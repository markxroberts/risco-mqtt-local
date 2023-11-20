import { IClientOptions } from 'mqtt/types/lib/client';

import merge from 'lodash/merge';
import mqtt from 'mqtt';
import {
  RiscoPanel,
  RiscoLogger,
  Partition,
  PartitionList,
  Output,
  OutputList,
  Zone,
  ZoneList,
  PanelOptions,
} from '@markxroberts/risco-lan-bridge/dist';
import pkg from 'winston';
import { cloneDeep } from 'lodash';

const { createLogger, format, transports } = pkg;
const { combine, timestamp, printf, colorize } = format;

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface RiscoMQTTConfig {
  log?: LogLevel,
  logColorize?: boolean,
  ha_discovery_prefix_topic?: string,
  ha_discovery_include_nodeId?: boolean,
  risco_mqtt_topic?: string,
  filter_bypass_zones: boolean,
  ha_state_publishing_delay: number,
  alarm_system_name: string,
  partitions?: {
    default?: PartitionConfig
    [label: string]: PartitionConfig
  },
  zones?: {
    default?: ZoneConfig
    [label: string]: ZoneConfig
  },
  user_outputs?: {
    default?: OutputUserConfig
    [label: string]: OutputUserConfig
  },
  system_outputs?: {
    default?: OutputSystemConfig
    [label: string]: OutputSystemConfig
  },
  arming_modes?: {
    partition?: {
      default?: ArmingConfig
      [label: string]: ArmingConfig
    },
  },
  panel: PanelOptions,
  mqtt?: MQTTConfig
}

export interface MQTTConfig extends IClientOptions {
  url: string
}

export interface PartitionConfig {
  name?: string
  name_prefix?: string
}

export interface ZoneConfig {
  off_delay?: number,
  device_class?: string,
  name?: string
  name_prefix?: string
}

export interface OutputUserConfig {
  device_class?: string,
  name?: string
  name_prefix?: string
}

export interface OutputSystemConfig {
  device_class?: string,
  name?: string
  name_prefix?: string
}

export interface ArmingConfig {
  armed_away?: string
  armed_home?: string
  armed_night?: string
  armed_vacation?: string
  armed_custom_bypass?: string
}

export interface PartitionArmingModes {
  [partition: string]: ArmingModes
}

export interface ArmingModes {
  armed_away: string
  armed_home: string
  armed_night: string
  armed_vacation: string
  armed_custom_bypass: string
}

const CONFIG_DEFAULTS: RiscoMQTTConfig = {
  log: 'info',
  logColorize: false,
  ha_discovery_prefix_topic: 'homeassistant',
  risco_mqtt_topic: 'risco-alarm-panel',
  alarm_system_name: 'Risco Alarm',
  filter_bypass_zones: true,
  ha_state_publishing_delay: 30,
  panel: {
    autoConnect: true
  },
  partitions: {
    default: {
      name_prefix: '',
    },
  },
  zones: {
    default: {
      off_delay: 0,
      device_class: 'motion',
      name_prefix: '',
    },
  },
  user_outputs: {
    default: {
      device_class: '',
      name_prefix: '',
    },
  },
  system_outputs: {
    default: {
      device_class: 'running',
      name_prefix: '',
    },
  },
  arming_modes: {
    partition: {
      default: {
        armed_away: 'armed_away',
        armed_home: 'armed_home',
        armed_night: 'armed_home',
        armed_vacation: 'armed_away',
        armed_custom_bypass: 'armed_home',
      },
    },
  },
  mqtt: {
    url: null,
    username: null,
    password: null,
    reconnectPeriod: 5000,
    clientId: 'risco-mqtt-' + Math.random().toString(16).substring(2, 8),
    will: {
      topic: null, payload: 'offline', qos: 1, retain: true, properties: {
        willDelayInterval: 30,
      }
    }
  },
};

export function riscoMqttHomeAssistant(userConfig: RiscoMQTTConfig) {

  const config = merge(CONFIG_DEFAULTS, userConfig);

  let format = combine(
    timestamp({
      format: () => new Date().toLocaleString(),
    }),
    printf(({ level, message, label, timestamp }) => {
      return `${timestamp} [${level}] ${message}`;
    }),
  );
  if (config.logColorize) {
    format = combine(
      colorize({
        all: false,
        level: true,
      }),
      format,
    );
  }

  const logger = createLogger({
    format: format,
    level: config.log || 'info',
    transports: [
      new transports.Console(),
    ],
  });

  logger.debug(`[RML] User config:\n${JSON.stringify(userConfig, null, 2)}`);
  logger.debug(`[RML] Merged config:\n${JSON.stringify(config, null, 2)}`);

  class WinstonRiscoLogger implements RiscoLogger {
    log(log_lvl: LogLevel, log_data: any) {
      logger.log(log_lvl, log_data);
    }
  }

  config.panel.logger = new WinstonRiscoLogger();

  let panelReady = false;
  let mqttReady = false;
  let listenerInstalled = false;
  let socketListeners = false;
  let initialized = false;
  let loop;
  let reconnect;
  let reconnecting = false;
  let awaitPartitionReady = false;
  let partitionDetailId;
  let partitionDetailType;
  let partitionReadyStatus = [];
  let armingTimer = false

  if (!config.mqtt?.url) throw new Error('[RML] MQTT url option is required');

  let panel = new RiscoPanel(config.panel);
  let alarmMapping: PartitionArmingModes[] = [];

  panel.on('SystemInitComplete', () => {
    panel.riscoComm.tcpSocket.on('Disconnected', () => {
      panelReady = false;
      socketListeners = false;
      publishOffline();
    });
    if (!panelReady) {
      panelReady = true;
      panelOrMqttConnected();
    }
  });

  logger.info(`[RML] Connecting to mqtt server: ${config.mqtt.url}`);
  const mqtt_options = {
    clientId: `${config.mqtt.clientId}`,
    reconnectPeriod: config.mqtt.reconnectPeriod,
    username: `${config.mqtt.username}`,
    password: `${config.mqtt.password}`,
    will: {
      topic: `${config.risco_mqtt_topic}/alarm/button_status`,
    }
  }
  const mqtt_merge = merge(config.mqtt, mqtt_options);

  const mqttClient = mqtt.connect(config.mqtt.url, mqtt_merge);

  mqttClient.on('connect', () => {
    logger.info(`[RML] Connected on mqtt server: ${config.mqtt.url}`);
    if (!mqttReady) {
      mqttReady = true;
      panelOrMqttConnected();
    }
  });

  mqttClient.on('reconnect', () => {
    logger.info('[RML] MQTT reconnect');
  });

  mqttClient.on('disconnect', () => {
    logger.info('[RML] MQTT disconnected');
    mqttReady = false;
  });

  mqttClient.on('close', () => {
    logger.info('[RML] MQTT disconnected');
    mqttReady = false;
  });

  mqttClient.on('error', (error) => {
    logger.error(`[RML] MQTT connection error: ${error}`);
    mqttReady = false;
  });

  const ALARM_TOPIC_REGEX = new RegExp(`^${config.risco_mqtt_topic}/alarm/partition/([0-9]+)/set$`);
  const ZONE_BYPASS_TOPIC_REGEX = new RegExp(`^${config.risco_mqtt_topic}/alarm/zone/([0-9]+)-bypass/set$`);
  const OUTPUT_TOPIC_REGEX = new RegExp(`^${config.risco_mqtt_topic}/alarm/output/([0-9]+)/trigger$`);
  const republishing_delay = config.ha_state_publishing_delay * 1000

  mqttClient.on('message', (topic, message) => {
    let m;
    if ((m = ALARM_TOPIC_REGEX.exec(topic)) !== null) {
      m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (partitionId) => {
        const command = message.toString();
        logger.info(`[MQTT => Panel] Received change state command ${command} on topic ${topic} in partition ${partitionId}`);
        try {
          const success = await changeAlarmStatus(command, partitionId);
          if (success) {
            logger.info(`[MQTT => Panel] ${command} command sent on partition ${partitionId}`);
          } else {
            logger.error(`[MQTT => Panel] Failed to send ${command} command on partition ${partitionId}`);
          }
        } catch (err) {
          logger.error(`[MQTT => Panel] Error during state change command ${command} from topic ${topic} on partition ${partitionId}`);
          logger.error(err);
        }
      });
    } else if ((m = ZONE_BYPASS_TOPIC_REGEX.exec(topic)) !== null) {
      m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (zoneId) => {
        const bypass = parseInt(message.toString(), 10) == 1;
        logger.info(`[MQTT => Panel] Received bypass zone command ${bypass} on topic ${topic} for zone ${zoneId}`);
        try {
          if (bypass !== panel.zones.byId(zoneId).Bypass) {
            const success = await panel.toggleBypassZone(zoneId);
            if (success) {
              logger.info(`[MQTT => Panel] toggle bypass command sent on zone ${zoneId}`);
            } else {
              logger.error(`[MQTT => Panel] Failed to send toggle bypass command on zone ${zoneId}`);
            }
          } else {
            logger.info('[MQTT => Panel] Zone is already on the desired bypass state');
          }
        } catch (err) {
          logger.error(`[MQTT => Panel] Error during zone bypass toggle command from topic ${topic} on zone ${zoneId}`);
          logger.error(err);
        }
      });
    } else if ((m = OUTPUT_TOPIC_REGEX.exec(topic)) !== null) {
      m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (outputId) => {
        const outputcommand = message.toString();
        logger.info(`[MQTT => Panel] Received output trigger command on topic ${topic} for output ${outputId}`);
        try {
          if (outputcommand !== panel.outputs.byId(outputId).Status) {
            const success = await panel.toggleOutput(outputId);
            if (success) {
              logger.info(`[MQTT => Panel] toggle output command sent on output ${outputId}`);
            } else {
              logger.error(`[MQTT => Panel] Failed to send toggle output command on zone ${outputId}`);
          }
        } else {
          logger.info('[MQTT => Panel] Output is already on the desired output state');
        }
        } catch (err) {
          logger.error(`[MQTT => Panel] Error during output toggle command from topic ${topic} on output ${outputId}`);
          logger.error(err);
        }
      });
    } else if (topic === `${config.ha_discovery_prefix_topic}/status`) {
      if (message.toString() === 'online') {
        logger.info('[RML] Home Assistant is online');
          logger.info(`[RML] Delay ${config.ha_state_publishing_delay} seconds before publishing initial states`);
          let t: any;
          t = setTimeout(() => publishInitialStates(), republishing_delay);
      } else {
        logger.info('[RML] Home Assistant has gone offline');
      }
    } else if (topic === `${config.risco_mqtt_topic}/republish`) {
      if (message.toString() === 'states') {
        logger.info('[RML] Message received via MQTT to republish states');
        publishInitialStates();
      } else if (message.toString() === 'autodiscovery') {
        logger.info('[RML] Message received via MQTT to republish autodiscovery data');
        publishHomeAssistantDiscoveryInfo();
      } else if (message.toString() === 'communications') {
        logger.info('[RML] Message received via MQTT to reinitiate communications');
        panel.riscoComm.tcpSocket.disconnect(true);
        logger.info('[MQTT => Panel] Disconnect socket command sent');
        removeSocketListeners()
        reconnecting = true;
      }
    }
  });

  function groupLetterToNumber(letter) {
    if (letter === 'A') {
      return 1;
    } else if (letter === 'B') {
      return 2;
    } else if (letter === 'C') {
      return 3;
    } else if (letter === 'D') {
      return 4;
    }
  };

  async function changeAlarmStatus(code: string, partId: number) {
    let letter = 'A';
    if (code.includes('group')) {
      letter = code.substr(code.length - 1);
      logger.info(`[MQTT => Panel] Group arming initiated.  Code is ${code}.`)
      code = 'armed_group'
    }
    const group = groupLetterToNumber(letter);
    const partStatus = panel.partitions.byId(partId).Ready
    logger.debug(`[MQTT => Panel] Changing code for letter.  Letter is ${letter}.  Group is ${group}.`)
    switch (code) {
      case 'disarmed':
        return await panel.disarmPart(partId);
      case 'armed_home':
        if (partitionReadyStatus[partId] === true) {
          logger.info(`[RML] Partition ${partId} ready, sending arm command`)
          logger.debug(`${partitionReadyStatus[partId]}`)
          return await panel.armHome(partId);
      } else {
          awaitPartitionReady = true
          partitionDetailId = partId
          partitionDetailType = code
          logger.info(`[RML] Partition ${partId} not ready.  Will await Ready status.`)
          logger.debug(`${partitionReadyStatus[partId]}`)
        }
      case 'armed_away':
        try {
          return await panel.armAway(partId);
        }
        catch (error) {
          logger.info(`${error}`)
        }
      case 'armed_group':
        if (partitionReadyStatus[partId] === true) {
          logger.info(`[RML] Partition ${partId} ready, sending arm command`)
          logger.debug(`${partitionReadyStatus[partId]}`)
          return await panel.armGroup(partId, group);
        } else {
          awaitPartitionReady = true
          partitionDetailId = partId
          partitionDetailType = code
          logger.info(`[RML] Partition ${partId} not ready.  Will await Ready status.`)
          logger.debug(`${partitionReadyStatus[partId]}`)
        }
    }
  }

  function returnPanelAlarmState(partition: Partition) {
    if (partition.Arm) {
      return 'armed_away'
    }
    if (partition.HomeStay) {
      return 'armed_home'
    }
    if (partition.GrpAArm) {
      return 'armed_group_A'
    }
    if (partition.GrpBArm) {
      return 'armed_group_B'
    }
    if (partition.GrpCArm) {
      return 'armed_group_C'
    }
    if (partition.GrpDArm) {
      return 'armed_group_D'
    }
  }

  function alarmPayload(partition: Partition) {
    const partitionId = (partition.Id -1);
    const partitionIdEnd = (partitionId + 1);
    const partitionLabel = partition.Label;
    logger.debug(`[RML] Partition being updated is ${partitionId}.`)
    logger.verbose(`[RML] Currently mapped states are \n${JSON.stringify(alarmMapping, null, 2)}.`);
    if (partition.Alarm) {
      return 'triggered';
    } else if (!partition.Arm && !partition.HomeStay && !partition.GrpAArm && !partition.GrpBArm && !partition.GrpCArm && !partition.GrpDArm) {
      return 'disarmed';
    } else {
      const panelState = returnPanelAlarmState(partition);
      logger.debug(`[Panel => MQTT] Panel alarm state for partition ${partition.Label} is ${panelState}.`);
      const partitionAlarmMapping = alarmMapping.slice(partitionId,partitionIdEnd);
      logger.verbose(`[RML] Currently mapped states are \n${JSON.stringify(partitionAlarmMapping, null, 2)}.`);
      logger.verbose(`[RML] Currently mapped keys are \n${JSON.stringify(partitionAlarmMapping[0][partitionLabel], null, 2)}.`);
      const mappedKey = (Object.keys(partitionAlarmMapping[0][partitionLabel]) as (keyof ArmingModes)[]).find((key) => {
        return partitionAlarmMapping[0][partitionLabel][key] === panelState;
        logger.debug(`[RML] Mapped key = ${mappedKey}`)});
      return mappedKey;
    }
  };
  function outputState(output: Output, EventStr: string) {
    if (EventStr !== '0') {
      if (EventStr === 'Activated' || EventStr === 'Pulsed') {
        return {
          output: '1',
          text: EventStr};
      } else {
        return {
          output: '0',
          text: EventStr};
      }
    } else {
      if (output.Active) {
        return {
          output: '1',
          text: output.Active};
      } else {
        return {
          output: '0',
          text: output.Active};
      }
    }  
  }
  function alarmSensorState(zone: Zone) {
    if (zone.Alarm && zone.Arm) {
      return '1';
    } else {
      return '0';
    }
  }
  function panelStatus(state) {
    if (state) {
      return {
        state: '1',
        text: 'online'
      };
    } else {
      return {
        state: '0',
        text: 'offline'
      };
    }
  }

  function publishState(state) {
    const status = panelStatus(state)
    if (config.panel.socketMode === 'proxy') {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/proxystatus`, status.state, { qos: 1, retain: true });
      logger.verbose(`[Panel => MQTT] Published proxy connection status ${status.text}`);
    } else {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/panelstatus`, status.state, { qos: 1, retain: true });
      logger.verbose(`[Panel => MQTT] Published panel connection status ${status.text}`);
    }
  }

  function publishPanelStatus(state) {
    const status = panelStatus(state)
    if (state) {
      publishState(state);
    }
    if (config.panel.autoConnect && !state && initialized) {
      if (config.panel.socketMode === 'proxy') {
        logger.info('[RML] Proxy server not communicating.')
        publishState(state)
      } else {
        publishState(state)
        logger.info(`[RML] Panel not communicating.`)
      }
    }
    if (!config.panel.autoConnect && !state && initialized) {
      logger.info('[RML] Panel not communicating.  Manual reconnection can be initiated via HA button.  Intermittent connection retries may be attempted in response to errors.')
      publishState(state)
    }
  }

  function socketDisconnected(socket) {
    if (panelReady) {
      clearTimeout(reconnect);
      logger.info('[RML] Panel is connected, so reconnection not required.');
      reconnecting = false;
    } else {
      if (socket) {
        panel.riscoComm.tcpSocket.disconnect(true);
        logger.info('[MQTT => Panel] Socket disconnection command sent')
        removeSocketListeners()
        publishState(false);
      }
    }
  }

  function publishSystemStateChange(message) {
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/systemmessage`, `${message}`, { qos: 1, retain: true });
    logger.verbose(`[Panel => MQTT] Published system message ${message}`);
  }

  function publishSystemBatteryStatus(message) {
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/systembattery`, `${message}`, { qos: 1, retain: true });
    logger.verbose(`[Panel => MQTT] Published system battery state ${message}`);
  }

  function partitionStatus(partition: Partition) {
    if (partition.Ready) {
      return {
        state: '0',
        text: 'Ready'
      };
    } else {
      return {
        state: '1',
        text: 'Not ready'
      };
    }
  }

  function publishPartitionStateChanged(partition: Partition, arming: boolean) {
    if (!arming) {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/status`, alarmPayload(partition), { qos: 1, retain: true });
      logger.verbose(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`);
    }
    if (arming) {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/status`, 'arming', { qos: 1, retain: true });
      logger.verbose(`[Panel => MQTT] Published alarm status arming on partition ${partition.Id}`);
    }
  }

  function publishPartitionStatus(partition: Partition) {
    const partitionState = partitionStatus(partition)
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/partition/${partition.Id}-status/status`, partitionState.state, { qos: 1, retain: true });
    logger.verbose(`[Panel => MQTT] Published partition status ${partitionState.text} on partition ${partition.Id}`);
  }

  function publishZoneStateChange(zone: Zone, publishAttributes: boolean) {
    if (publishAttributes) {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}`, JSON.stringify({
        id: zone.Id,
        alarm: zone.Alarm,
        arm: zone.Arm,
        label: zone.Label,
        type: zone.type,
        typeLabel: zone.typeLabel,
        tech: zone.tech,
        techLabel: zone.techLabel,
        tamper: zone.Tamper,
        low_battery: zone.LowBattery,
        bypass: zone.Bypass,
      }), { qos: 1, retain: true });
    }
    let zoneStatus = zone.Open ? '1' : '0';
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/status`, zoneStatus, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone status ${zoneStatus} on zone ${zone.Label}`);
  }
  function publishZoneBatteryStateChange(zone: Zone, publishAttributes: boolean) {
    if (publishAttributes) {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/battery`, JSON.stringify({
        id: zone.Id,
        label: zone.Label,
        type: zone.type,
        typeLabel: zone.typeLabel,
        tech: zone.tech,
        techLabel: zone.techLabel,
        tamper: zone.Tamper,
        bypass: zone.Bypass,
      }), { qos: 1, retain: true });
    }
    let zoneBattery = zone.LowBattery ? '1' : '0';
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/battery/status`, zoneBattery, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone battery status ${zoneBattery} on zone ${zone.Label}`);
  }
  function publishZoneAlarmStateChange(zone: Zone, publishAttributes: boolean) {
    if (publishAttributes) {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/battery`, JSON.stringify({
        id: zone.Id,
        arm: zone.Arm,
        label: zone.Label,
        type: zone.type,
        typeLabel: zone.typeLabel,
        tech: zone.tech,
        techLabel: zone.techLabel,
        tamper: zone.Tamper,
        low_battery: zone.LowBattery,
        bypass: zone.Bypass,
      }), { qos: 1, retain: true });
    }
  
    const zoneAlarm = alarmSensorState(zone)  
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/alarm/status`, zoneAlarm, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone alarm status ${zoneAlarm} on zone ${zone.Label}`);
  }

  function publishOutputStateChange(output: Output, EventStr: string) {
    const outputStatus = outputState(output, EventStr)
    const outputId = output.Id
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/output/${output.Id}/status`, outputStatus.output, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published output status ${outputStatus.text} on output ${output.Label}`);
  }

  function publishZoneBypassStateChange(zone: Zone) {
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/zone/${zone.Id}-bypass/status`, zone.Bypass ? '1' : '0', {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone bypass status ${zone.Bypass} on zone ${zone.Label}`);
  }
  function activePartitions(partitions: PartitionList): Partition[] {
    return partitions.values.filter(p => p.Exist);
  }
  function activeZones(zones: ZoneList): Zone[] {
    return zones.values.filter(z => !z.NotUsed);
  }
  function activeBypassZones(zones: ZoneList): Zone[] {
    if (config.filter_bypass_zones === true) {
      return zones.values.filter(z => z.Type !== 3 && !z.NotUsed);
    } else {
      return zones.values.filter(z => !z.NotUsed);
    }
  }
  function batteryZones(zones: ZoneList): Zone[] {
    return zones.values.filter(z => z.tech === 'W');
  }
  function activeToggleOutputs(outputs: OutputList): Output[] {
    return outputs.values.filter(o => o.UserUsable && !o.Pulsed);
  }
  function activeButtonOutputs(outputs: OutputList): Output[] {
    return outputs.values.filter(o => o.UserUsable && o.Pulsed);
  }
  function activeSystemOutputs(systemoutputs: OutputList): Output[] {
    return systemoutputs.values.filter(o => !o.UserUsable && o.Label !== '');
  }

  function publishOnline() {
    clearTimeout(loop);
    reconnecting = false
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/status`, 'online', {
      qos: 1, retain: true,
    });
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/button_status`, 'online', {
      qos: 1, retain: true,
    });
    logger.verbose('[Panel => MQTT] Published alarm online');
    let reconnectDelay;
    if (config.panel.socketMode === 'proxy') {
      reconnectDelay = 60000
    } else {
      reconnectDelay = 30000
    }
    if (!reconnecting) {
      loop = setTimeout(function() {
      publishOffline();
      publishPanelStatus(false)},reconnectDelay);
    }
  }

  function publishOffline() {
    if (mqttReady) {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/status`, 'offline', {
        qos: 1, retain: true,
      });
      logger.verbose('[Panel => MQTT] Published alarm offline');
    }
  }

  function getDeviceInfo() {
    return {
      manufacturer: 'Risco',
      model: `${panel.riscoComm.panelInfo.PanelModel}/${panel.riscoComm.panelInfo.PanelType}`,
      name: config.alarm_system_name,
      sw_version: panel.riscoComm.panelInfo.PanelFW,
      identifiers: config.risco_mqtt_topic,
    };
  }

  function publishHomeAssistantDiscoveryInfo() {
    if (config.panel.socketMode === 'proxy') {
      const proxyPayload = {
        name: `Proxy connection status`,
        object_id: `${config.risco_mqtt_topic}-proxy-connection-status`,
        state_topic: `${config.risco_mqtt_topic}/alarm/proxystatus`,
        unique_id: `${config.risco_mqtt_topic}-proxystatus`,
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/button_status`,
        },
        payload_on: '1',
        payload_off: '0',
        device_class: 'connectivity',
        entity_category: 'diagnostic',
        device: getDeviceInfo(),
      }

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/proxystatus/config`, JSON.stringify(proxyPayload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published proxy status sensor, HA name = ${proxyPayload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Proxy status payload\n${JSON.stringify(proxyPayload, null, 2)}`);
    } else {
      const panelPayload = {
        name: `Panel connection status`,
        object_id: `${config.risco_mqtt_topic}-panel-connection-status`,
        state_topic: `${config.risco_mqtt_topic}/alarm/panelstatus`,
        unique_id: `${config.risco_mqtt_topic}-panelstatus`,
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/button_status`,
        },
        payload_on: '1',
        payload_off: '0',
        device_class: 'connectivity',
        entity_category: 'diagnostic',
        device: getDeviceInfo(),
      }

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/panelstatus/config`, JSON.stringify(panelPayload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published panel status sensor, HA name = ${panelPayload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Panel status payload\n${JSON.stringify(panelPayload, null, 2)}`);

    };

    const systemPayload = {
      name: `System message`,
      object_id: `${config.risco_mqtt_topic}-system-message`,
      state_topic: `${config.risco_mqtt_topic}/alarm/systemmessage`,
      unique_id: `${config.risco_mqtt_topic}-system-message`,
      availability_mode: 'all',
      availability: [
        {topic: `${config.risco_mqtt_topic}/alarm/status`},
        {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
      entity_category: 'diagnostic',
      device: getDeviceInfo(),
    };

    mqttClient.publish(`${config.ha_discovery_prefix_topic}/sensor/${config.risco_mqtt_topic}/systemmessage/config`, JSON.stringify(systemPayload), {
      qos: 1, retain: true,
    });
    logger.info(`[Panel => MQTT][Discovery] Published System message sensor, HA name = ${systemPayload.name}`);
    logger.verbose(`[Panel => MQTT][Discovery] System message payload\n${JSON.stringify(systemPayload, null, 2)}`);

    const systemBatteryPayload = {
      name: `System battery`,
      object_id: `${config.risco_mqtt_topic}-system-battery`,
      state_topic: `${config.risco_mqtt_topic}/alarm/systembattery`,
      unique_id: `${config.risco_mqtt_topic}-system-battery`,
      availability_mode: 'all',
      availability: [
        {topic: `${config.risco_mqtt_topic}/alarm/status`},
        {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
      payload_on: 'LowBattery',
      payload_off: 'BatteryOk',
      device_class: 'battery',
      device: getDeviceInfo(),
    };

    mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/systembattery/config`, JSON.stringify(systemBatteryPayload), {
      qos: 1, retain: true,
    });
    logger.info(`[Panel => MQTT][Discovery] Published System battery sensor, HA name = ${systemBatteryPayload.name}`);
    logger.verbose(`[Panel => MQTT][Discovery] System battery sensor payload\n${JSON.stringify(systemBatteryPayload, null, 2)}`);

    const republishStatePayload = {
      name: `Republish state payload`,
      object_id: `${config.risco_mqtt_topic}-republish-state`,
      unique_id: `${config.risco_mqtt_topic}-republish-state`,
      availability: {
        topic: `${config.risco_mqtt_topic}/alarm/button_status`,
      },
      payload_press: 'states',
      command_topic: `${config.risco_mqtt_topic}/republish`,
      entity_category: 'diagnostic',
      device_class: 'restart',
      device: getDeviceInfo(),
    };

    mqttClient.publish(`${config.ha_discovery_prefix_topic}/button/${config.risco_mqtt_topic}/repubish_state/config`, JSON.stringify(republishStatePayload), {
      qos: 1, retain: true,
    });
    logger.info(`[Panel => MQTT][Discovery] Published republish state button, HA name = ${republishStatePayload.name}`);
    logger.verbose(`[Panel => MQTT][Discovery] Republish state payload\n${JSON.stringify(republishStatePayload, null, 2)}`);

    const republishAutodiscoveryPayload = {
      name: `Republish autodiscovery`,
      object_id: `${config.risco_mqtt_topic}-republish-autodiscovery`,
      unique_id: `${config.risco_mqtt_topic}-republish-autodiscovery`,
      availability: {
        topic: `${config.risco_mqtt_topic}/alarm/button_status`,
      },
      payload_press: 'autodiscovery',
      command_topic: `${config.risco_mqtt_topic}/republish`,
      entity_category: 'diagnostic',
      device_class: 'restart',
      device: getDeviceInfo(),
    };

    mqttClient.publish(`${config.ha_discovery_prefix_topic}/button/${config.risco_mqtt_topic}/repubish_autodiscovery/config`, JSON.stringify(republishAutodiscoveryPayload), {
      qos: 1, retain: true,
    });
    logger.info(`[Panel => MQTT][Discovery] Published republish autodiscovery button, HA name = ${republishAutodiscoveryPayload.name}`);
    logger.verbose(`[Panel => MQTT][Discovery] Republish autodiscovery payload\n${JSON.stringify(republishAutodiscoveryPayload, null, 2)}`);

    const restartPayload = {
      name: `Restart communications`,
      object_id: `${config.risco_mqtt_topic}-restart-communications`,
      unique_id: `${config.risco_mqtt_topic}-restart-communications`,
      availability: {
        topic: `${config.risco_mqtt_topic}/alarm/button_status`,
      },
      payload_press: 'communications',
      command_topic: `${config.risco_mqtt_topic}/republish`,
      entity_category: 'diagnostic',
      device_class: 'restart',
      device: getDeviceInfo(),
    };

    mqttClient.publish(`${config.ha_discovery_prefix_topic}/button/${config.risco_mqtt_topic}/restart_communications/config`, JSON.stringify(restartPayload), {
      qos: 1, retain: true,
    });
    logger.info(`[Panel => MQTT][Discovery] Published restart communications button, HA name = ${restartPayload.name}`);
    logger.verbose(`[Panel => MQTT][Discovery] Republish restart communications payload\n${JSON.stringify(restartPayload, null, 2)}`);

    for (const partition of activePartitions(panel.partitions)) {

      partitionReadyStatus.push({[partition.Id]: partition.Ready})
      logger.debug(`Partition status on ${partition.Id} is ${partition.Ready}`)

      const partitionConf = cloneDeep(config.partitions.default);
      merge(partitionConf, config.partitions?.[partition.Label]);

      const armingConfig = cloneDeep(config.arming_modes.partition.default);
      merge(armingConfig, config.arming_modes?.[partition.Label]);

      const partitionLabel = partition.Label

      let alarmRemap: PartitionArmingModes;
      alarmRemap = {
        [partitionLabel]: {
          armed_away: armingConfig.armed_away,
          armed_home: armingConfig.armed_home,
          armed_night: armingConfig.armed_night,
          armed_vacation: armingConfig.armed_vacation,
          armed_custom_bypass: armingConfig.armed_custom_bypass
        }};
      alarmMapping.push(alarmRemap);
      logger.info(`[RML] Added alarm state mapping for partition ${partitionLabel}.`)
      logger.verbose(`[RML] Added alarm state mappings for partition ${partitionLabel} as \n${JSON.stringify(alarmRemap, null, 2)}.`)
      logger.verbose(`[RML] Alarm mappings updated as \n${JSON.stringify(alarmMapping, null, 2)}.`)
      
      const payload = {
        name: partition.Label,
        object_id: `${config.risco_mqtt_topic}-${partition.Id}`,
        state_topic: `${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/status`,
        unique_id: `${config.risco_mqtt_topic}-partition-${partition.Id}`,
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        payload_disarm: 'disarmed',
        payload_arm_away: armingConfig.armed_away,
        payload_arm_home: armingConfig.armed_home,
        payload_arm_night: armingConfig.armed_night,
        payload_arm_vacation: armingConfig.armed_vacation,
        payload_arm_custom_bypass: armingConfig.armed_custom_bypass,
        device: getDeviceInfo(),
        command_topic: `${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/set`,
      };

      const partitionName = partitionConf.name || partition.Label;
      payload.name = partitionConf.name_prefix + partitionName;

      let partitionIdSegment = `${partition.Id}`;

      let partitionSensorName = `${partition.Label} status`

      const partitionpayload = {
        name: partitionSensorName,
        object_id: `${config.risco_mqtt_topic}-${partition.Id}-status`,
        state_topic: `${config.risco_mqtt_topic}/alarm/partition/${partition.Id}-status/status`,
        unique_id: `${config.risco_mqtt_topic}-partition-${partition.Id}-status`,
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        payload_on: '1',
        payload_off: '0',
        device_class: 'occupancy',
        device: getDeviceInfo(),
      };

      partitionpayload.name = partitionConf.name_prefix + partitionName;

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/alarm_control_panel/${config.risco_mqtt_topic}/${partitionIdSegment}/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published alarm_control_panel to HA Partition label = ${partition.Label}, HA name = ${payload.name} on partition ${partition.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Alarm discovery payload\n${JSON.stringify(payload, null, 2)}`);
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/partition-${partitionIdSegment}-status/config`, JSON.stringify(partitionpayload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor of partition status to HA label = ${partition.Label}, HA name = ${partitionpayload.name} on partition ${partition.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Partition status sensor discovery payload\n${JSON.stringify(partitionpayload, null, 2)}`);
    }

    for (const output of activeToggleOutputs(panel.outputs)) {

      const useroutputConf = cloneDeep(config.user_outputs.default);
      merge(useroutputConf, config.user_outputs?.[output.Label]);

      const payload = {
        name: output.Label,
        unique_id: `${config.risco_mqtt_topic}-output-${output.Id}`,
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        payload_on: '1',
        payload_off: '0',
        state_on: '1',
        state_off: '0',
        device_class: useroutputConf.device_class,
        icon: 'mdi:toggle-switch-off',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_mqtt_topic}/alarm/output/${output.Id}/status`,
        command_topic: `${config.risco_mqtt_topic}/alarm/output/${output.Id}/trigger`,
      };

      const useroutputName = useroutputConf.name || output.Label;
      payload.name = useroutputConf.name_prefix + useroutputName;

      let useroutputIdSegment = `${output.Id}`;

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/switch/${config.risco_mqtt_topic}/${useroutputIdSegment}-output/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published switch to HA: Output label = ${output.Label}, HA name = ${payload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Output discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }
    for (const output of activeButtonOutputs(panel.outputs)) {

      const useroutputConf = cloneDeep(config.user_outputs.default);
      merge(useroutputConf, config.user_outputs?.[output.Label]);

      const payload = {
        name: output.Label,
        unique_id: `${config.risco_mqtt_topic}-output-${output.Id}`,
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        payload_press: '1',
        icon: 'mdi:gesture-tap-button',
        device: getDeviceInfo(),
        qos: 1,
        command_topic: `${config.risco_mqtt_topic}/alarm/output/${output.Id}/trigger`,
      };

      const useroutputName = useroutputConf.name || output.Label;
      payload.name = useroutputConf.name_prefix + useroutputName;

      let useroutputIdSegment = `${output.Id}`;

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/button/${config.risco_mqtt_topic}/${useroutputIdSegment}-output/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published button to HA: Output label = ${output.Label}, HA name = ${payload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Output discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }
    for (const systemoutput of activeSystemOutputs(panel.outputs)) {

      const systemoutputConf = cloneDeep(config.system_outputs.default);
      merge(systemoutputConf, config.system_outputs?.[systemoutput.Label]);

      const payload = {
        name: systemoutput.Label,
        unique_id: `${config.risco_mqtt_topic}-systemoutput-${systemoutput.Id}`,
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        payload_on: '1',
        payload_off: '0',
        device_class: systemoutputConf.device_class,
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_mqtt_topic}/alarm/output/${systemoutput.Id}/status`,
      };

      const outputName = systemoutputConf.name || systemoutput.Label;
      payload.name = systemoutputConf.name_prefix + outputName;

      let systemoutputIdSegment = `${systemoutput.Id}`;
      
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/${systemoutputIdSegment}-output/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Output label = ${systemoutput.Label}, HA name = ${payload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Output discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }

    for (const zone of activeZones(panel.zones)) {

      const zoneConf = cloneDeep(config.zones.default);
      merge(zoneConf, config.zones?.[zone.Label]);

      const payload: any = {
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        unique_id: `${config.risco_mqtt_topic}-zone-${zone.Id}`,
        payload_on: '1',
        payload_off: '0',
        device_class: zoneConf.device_class,
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/status`,
        json_attributes_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}`,
      };

      const alarmSensorPayload: any = {
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        unique_id: `${config.risco_mqtt_topic}-zone-alarm-${zone.Id}`,
        payload_on: '1',
        payload_off: '0',
        device_class: 'problem',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/alarm/status`,
        json_attributes_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}`,
      };

      if (zoneConf.off_delay) {
        payload.off_delay = zoneConf.off_delay; // If the service is stopped with any activated zone, it can remain forever on without this config
      }

      const zoneName = zoneConf.name || zone.Label;
      payload.name = zoneConf.name_prefix + zoneName;
      alarmSensorPayload.name = zoneConf.name_prefix + zoneName + ' Alarm';

      let nodeIdSegment = `${zone.Id}`;

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/${nodeIdSegment}/config`, JSON.stringify(payload), {
        qos: 1,
        retain: true,
      });
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/${nodeIdSegment}-alarm/config`, JSON.stringify(alarmSensorPayload), {
        qos: 1,
        retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${payload.name}`);
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${alarmSensorPayload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(payload, null, 2)}`);
      logger.verbose(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(alarmSensorPayload, null, 2)}`);
    }

    for (const zone of activeBypassZones(panel.zones)) {
      
      const zoneConf = cloneDeep(config.zones.default);
      merge(zoneConf, config.zones?.[zone.Label]);

      const payload: any = {
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        unique_id: `${config.risco_mqtt_topic}-zone-${zone.Id}-bypass`,
        payload_on: '1',
        payload_off: '0',
        state_on: '1',
        state_off: '0',
        icon: 'mdi:toggle-switch-off',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}-bypass/status`,
        command_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}-bypass/set`,
      };

      const zoneName = zoneConf.name || zone.Label;
      payload.name = zoneConf.name_prefix + zoneName + ' Bypass';

      let nodeIdSegment = `${zone.Id}`;

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/switch/${config.risco_mqtt_topic}/${nodeIdSegment}-bypass/config`, JSON.stringify(payload), {
        qos: 1,
        retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published switch to HA: Zone label = ${zone.Label}, HA name = ${payload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Bypass switch discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }

    for (const zone of batteryZones(panel.zones)) {

      const zoneConf = cloneDeep(config.zones.default);
      merge(zoneConf, config.zones?.[zone.Label]);

      const payload: any = {
        availability_mode: 'all',
        availability: [
          {topic: `${config.risco_mqtt_topic}/alarm/status`},
          {topic: `${config.risco_mqtt_topic}/alarm/button_status`}],
        unique_id: `${config.risco_mqtt_topic}-zone-${zone.Id}-battery`,
        payload_on: '1',
        payload_off: '0',
        device_class: 'battery',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}/battery/status`,
        json_attributes_topic: `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}`,
      };

      const zoneName = zoneConf.name || zone.Label;
      payload.name = zoneConf.name_prefix + zoneName + ' Battery';

      let nodeIdSegment = `${zone.Id}_battery`;

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.risco_mqtt_topic}/${nodeIdSegment}/config`, JSON.stringify(payload), {
        qos: 1,
        retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${payload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }
  }

  function publishInitialStates() {
    logger.info(`[RML] Publishing initial partitions, zones and outputs states to Home assistant`);
    for (const partition of activePartitions(panel.partitions)) {
      publishPartitionStateChanged(partition, false);
      publishPartitionStatus(partition);
    }
    for (const zone of activeZones(panel.zones)) {
      publishZoneStateChange(zone, true);
      publishZoneBypassStateChange(zone);
      publishZoneBatteryStateChange(zone, true);
      publishZoneAlarmStateChange(zone, true);
    }
    for (const output of activeToggleOutputs(panel.outputs)) {
      publishOutputStateChange(output, '0');
    }
    for (const output of activeButtonOutputs(panel.outputs)) {
      publishOutputStateChange(output, '0');
    }
    for (const systemoutput of activeSystemOutputs(panel.outputs)) {
      publishOutputStateChange(systemoutput, '0');
    }
    initialized = true
    logger.info(`[RML] Finished publishing initial partitions, zones and output states to Home assistant`);
    publishSystemStateChange('System initialized')
    publishPanelStatus(true)
    publishSystemBatteryStatus('BatteryOk')
    
  }

  function partitionListener(Id, EventStr) {
    if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed', 'Alarm', 'StandBy', 'GrpAArmed', 'GrpBArmed', 'GrpCArmed', 'GrpDArmed', 'GrpADisarmed', 'GrpBDisarmed', 'GrpCDisarmed', 'GrpDDisarmed'].includes(EventStr)) {
      publishPartitionStateChanged(panel.partitions.byId(Id), false);
    }
    if (['Ready', 'NotReady'].includes(EventStr)) {
      let partitionwait
      publishPartitionStatus(panel.partitions.byId(Id));
      if (['Ready'].includes(EventStr)) {
        partitionReadyStatus[Id] = true
        if (awaitPartitionReady) {
          logger.info(`[RML] Partition ${Id} now ready, so sending arming command.`)
          clearTimeout(partitionwait);
          changeAlarmStatus(partitionDetailType, partitionDetailId);
          awaitPartitionReady = false
          armingTimer = false
        }
      } else {
        partitionReadyStatus[Id] = false;
        publishPartitionStateChanged(panel.partitions.byId(Id), true);
        if (awaitPartitionReady && !armingTimer) {
          armingTimer = true
          partitionwait = setTimeout(function() {
            awaitPartitionReady = false;
            armingTimer = false
            logger.info(`[RML] Arming command timed out on partition ${Id}`)}, 30000)
        } if (armingTimer) {
          logger.info(`[RML] Delayed arming already initiated on partition ${Id}.`)
        }
      }
    }
  }

  function zoneListener(Id, EventStr) {
    if (['Closed', 'Open'].includes(EventStr)) {
      publishZoneStateChange(panel.zones.byId(Id), false);
    }
    if (['Bypassed', 'UnBypassed'].includes(EventStr)) {
      publishZoneBypassStateChange(panel.zones.byId(Id));
      publishZoneStateChange(panel.zones.byId(Id), true);
    }
    if (['LowBattery', 'BatteryOk'].includes(EventStr)) {
      publishZoneStateChange(panel.zones.byId(Id), true);
      publishZoneBatteryStateChange(panel.zones.byId(Id), false);
    }
    if (['Alarm', 'StandBy'].includes(EventStr)) {
      publishZoneStateChange(panel.zones.byId(Id), true);
      publishZoneAlarmStateChange(panel.zones.byId(Id), false);
    }
  }

  function outputListener(Id, EventStr) {
    if (['Pulsed', 'Activated', 'Deactivated'].includes(EventStr)) {
      publishOutputStateChange(panel.outputs.byId(Id), EventStr);
    }
  }

  function statusListener(EventStr) {
    if (['LowBattery', 'BatteryOk'].includes(EventStr)) {
      publishSystemBatteryStatus(EventStr);
    } else {
      publishSystemStateChange(EventStr)
    }
  }

  function errorListener(type, data) {
    logger.info(`[RML] Error received ${type}, ${data}`);
    logger.info('[RML] Panel or cloud not communicating properly.');
    if (data.includes('Cloud')) {
      publishPanelStatus(true);
    } else {
      publishPanelStatus(false)
    }
    if (type.includes('CommsError')) {
      if (data.includes('New socket being connected')) {
      logger.info('[RML] TCP Socket disconnected, new socket being connected.  Ensure old listeners removed.');
      reconnecting = true;
      } else if (data.includes('Disconnected')) {
      logger.info('[RML] TCP Socket disconnected');
      removeSocketListeners();
      } else if (data.includes('No reconnection')){
      logger.info('[RML] TCP Socket disconnected, no new socket to be connected');
      removeSocketListeners();
      reconnecting = false
      }
    } else {
    if (data.includes('EHOSTUNREACH')) {
      panelReady = false;
      logger.info(`[RML] Panel unreachable.`)
      reconnecting = true;
      } else if (data.includes('Cloud socket Closed' || 'RiscoCloud Socket: closed' || 'Risco command error: TIMEOUT')) {
        logger.info(`[RML] Cloud socket error ${data} received.  Disconnecting socket to avoid reconnection loop.`)
        panelReady = false;
        socketDisconnected(true);
        removeSocketListeners();
        reconnecting = true;
      } else if (data.includes('ECONNRESET')) {
        logger.info(`[RML] Socket error.  Connection to panel reset.`)
        reconnecting = true;
        removeSocketListeners();
      } else {
        logger.info('[RML] Error not processed.')
      }
    }
  }

  function removeSocketListeners() {
    panel.riscoComm.tcpSocket.removeListener('Disconnected', (data) => {publishPanelStatus(false)})
    panel.riscoComm.removeListener('PanelCommReady', (data) => {publishPanelStatus(true)})
    panel.riscoComm.tcpSocket.removeListener('SocketError', (data) => {errorListener('SocketError', data)});
    panel.riscoComm.removeListener('CommsError', (data) => {errorListener('CommsError', data)});
    socketListeners = false
    logger.info('[MQTT => Panel] Socket listeners removed')
  }

  function panelOrMqttConnected() {
    if (!panelReady) {
      logger.info(`[RML] Panel is not connected, waiting`);
      return;
    }
    if (!mqttReady) {
      logger.info(`[RML] MQTT is not connected, waiting`);
      return;
    }
    logger.info(`[RML] Panel and MQTT communications are ready`);
    logger.info(`[RML] Publishing Home Assistant discovery info`);

    if (!initialized) {
      publishHomeAssistantDiscoveryInfo();
      publishOnline();
    } else {
      publishOnline();
    }

    if (panelReady) {
      publishPanelStatus(true)
    }

    if (!listenerInstalled) {
      logger.info(`[RML] Subscribing to Home assistant commands topics`);
      for (const partition of activePartitions(panel.partitions)) {
        const partitionCommandsTopic = `${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/set`;
        logger.info(`[RML] Subscribing to ${partitionCommandsTopic} topic`);
        mqttClient.subscribe(partitionCommandsTopic);
      }
      for (const zone of activeZones(panel.zones)) {
        const zoneBypassTopic = `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}-bypass/set`;
        logger.info(`[RML] Subscribing to ${zoneBypassTopic} topic`);
        mqttClient.subscribe(zoneBypassTopic);
      }
      for (const output of activeToggleOutputs(panel.outputs)) {
        const outputTopic = `${config.risco_mqtt_topic}/alarm/output/${output.Id}/trigger`;
        logger.info(`[RML] Subscribing to ${outputTopic} topic`);
        mqttClient.subscribe(outputTopic);
      }
      for (const output of activeButtonOutputs(panel.outputs)) {
        const outputTopic = `${config.risco_mqtt_topic}/alarm/output/${output.Id}/trigger`;
        logger.info(`[RML] Subscribing to ${outputTopic} topic`);
        mqttClient.subscribe(outputTopic);
      }
      mqttClient.subscribe(`${config.risco_mqtt_topic}/republish`);

      publishPanelStatus(panelReady);
      logger.info(`[RML] Subscribing to panel partitions events`);
      panel.partitions.on('PStatusChanged', (Id, EventStr) => {partitionListener(Id, EventStr)});

      logger.info(`[RML] Subscribing to panel zones events`);
      panel.zones.on('ZStatusChanged', (Id, EventStr) => {zoneListener(Id,EventStr)});
      
      logger.info(`[RML] Subscribing to panel outputs events`);
      panel.outputs.on('OStatusChanged', (Id, EventStr) => {outputListener(Id,EventStr)});

      logger.info(`[RML] Subscribing to panel system events`);
      panel.mbSystem.on('SStatusChanged', (EventStr, value) => {statusListener(EventStr)});

      logger.info(`[RML] Subscribing to Home Assistant online status`);
      mqttClient.subscribe(`${config.ha_discovery_prefix_topic}/status`, { qos: 0 }, function(error, granted) {
        if (error) {
          logger.error(`[RML] Error subscribing to ${config.ha_discovery_prefix_topic}/status`);
        } else {
          logger.info(`[RML] ${granted[0].topic} was subscribed`);
        }
      });
      logger.info(`[RML] Subscribing to system clock`);
      panel.riscoComm.on('Clock', () => {
        publishOnline();
        publishPanelStatus(true)});
      }
      listenerInstalled = true;

    if (!socketListeners) {
      logger.info(`[RML] Subscribing to socket disconnection message`);
      panel.riscoComm.tcpSocket.on('Disconnected', (data) => {publishPanelStatus(false)});
  
      logger.info(`[RML] Subscribing to panel communications message`);
      panel.riscoComm.on('PanelCommReady', (data) => {publishPanelStatus(true)});
  
      logger.info(`[RML] Subscribing to socket error message`);
      panel.riscoComm.tcpSocket.on('SocketError', (data) => {errorListener('SocketError', data)});
  
      logger.info(`[RML] Subscribing to communications error message`);
      panel.riscoComm.on('CommsError', (data) => {errorListener('CommsError', data)});
      socketListeners = true

    } else {
      reconnecting = false;
      logger.info('[RML] Listeners already installed, skipping listeners registration');
    }
    initialized = true
    logger.info(`[RML] Panel initialization and autodiscovery completed`);
  }
}