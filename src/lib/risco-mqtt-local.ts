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
  auto_reconnect: boolean,
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
  auto_reconnect: true,
  panel: {},
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

  logger.debug(`User config:\n${JSON.stringify(userConfig, null, 2)}`);
  logger.debug(`Merged config:\n${JSON.stringify(config, null, 2)}`);

  class WinstonRiscoLogger implements RiscoLogger {
    log(log_lvl: LogLevel, log_data: any) {
      logger.log(log_lvl, log_data);
    }
  }

  config.panel.logger = new WinstonRiscoLogger();

  let panelReady = false;
  let mqttReady = false;
  let listenerInstalled = false;
  let initialized = false;
  let loop;
  let reconnect;

  if (!config.mqtt?.url) throw new Error('mqtt url option is required');

  let panel = new RiscoPanel(config.panel);
  let alarmMapping: PartitionArmingModes[] = [];

  panel.on('SystemInitComplete', () => {
    panel.riscoComm.tcpSocket.on('Disconnected', () => {
      panelReady = false;
      publishOffline();
    });
    if (!panelReady) {
      panelReady = true;
      panelOrMqttConnected();
    }
  });

  logger.info(`Connecting to mqtt server: ${config.mqtt.url}`);
  const mqtt_options = {
    clientId: `${config.mqtt.clientId}`,
    reconnectPeriod: config.mqtt.reconnectPeriod,
    username: `${config.mqtt.username}`,
    password: `${config.mqtt.password}`,
    will: {
      topic: `${config.risco_mqtt_topic}/alarm/status`,
    }
  }
  const mqtt_merge = merge(config.mqtt, mqtt_options);

  const mqttClient = mqtt.connect(config.mqtt.url, mqtt_merge);

  mqttClient.on('connect', () => {
    logger.info(`Connected on mqtt server: ${config.mqtt.url}`);
    if (!mqttReady) {
      mqttReady = true;
      panelOrMqttConnected();
    }
  });

  mqttClient.on('reconnect', () => {
    logger.info('MQTT reconnect');
  });

  mqttClient.on('disconnect', () => {
    logger.info('MQTT disconnect');
    mqttReady = false;
  });

  mqttClient.on('close', () => {
    logger.info('MQTT disconnected');
    mqttReady = false;
  });

  mqttClient.on('error', (error) => {
    logger.error(`MQTT connection error: ${error}`);
    mqttReady = false;
  });

  const ALARM_TOPIC_REGEX = new RegExp(`^${config.risco_mqtt_topic}/alarm/partition/([0-9]+)/set$`);
  const ZONE_BYPASS_TOPIC_REGEX = new RegExp(`^${config.risco_mqtt_topic}/alarm/zone/([0-9]+)-bypass/set$`);
  const OUTPUT_TOPIC_REGEX = new RegExp(`^${config.risco_mqtt_topic}/alarm/output/([0-9]+)/trigger$`);

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
        logger.info('Home Assistant is online');
        if (!initialized) {
          logger.info(`Delay 30 seconds before publishing initial states`);
          let t: any;
          t = setTimeout(() => publishInitialStates(),30000);
          initialized = true;
        } else {
          logger.info(`Delay 15 seconds before republishing initial states`);
          let t: any;
          t = setTimeout(() => publishInitialStates(),15000);
        }
      } else {
        logger.info('Home Assistant has gone offline');
      }
    } else if (topic === `${config.risco_mqtt_topic}/republish`) {
      if (message.toString() === 'states') {
        logger.info('Message to republish states');
        publishInitialStates();
        initialized = true;
      } else if (message.toString() === 'autodiscovery') {
        logger.info('Message to republish autodiscovery data');
        publishHomeAssistantDiscoveryInfo();
        initialized = true;
      } else if (message.toString() === 'communications') {
        logger.info('Message to reinitiate communications');
        panel.riscoComm.tcpSocket.disconnect(false);
        logger.info('Waiting 30 seconds before reconnecting to allow socket to reset');
        let t: any;
        t = setTimeout(() => panel.riscoComm.tcpSocket.connect(),30000);
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
      logger.debug(`Group arming initiated.  Code is ${code}.`)
      code = 'armed_group'
    }
    const group = groupLetterToNumber(letter);
    logger.debug(`Changing code for letter.  Letter is ${letter}.  Group is ${group}.`)
    switch (code) {
      case 'disarmed':
        return await panel.disarmPart(partId);
      case 'armed_home':
        return await panel.armHome(partId);
      case 'armed_away':
        return await panel.armAway(partId);
      case 'armed_group':
        return await panel.armGroup(partId,group);
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
    logger.debug(`Partition being updated is ${partitionId}.`)
    logger.verbose(`Currently mapped states are \n${JSON.stringify(alarmMapping, null, 2)}.`);
    if (partition.Alarm) {
      return 'triggered';
    } else if (!partition.Arm && !partition.HomeStay && !partition.GrpAArm && !partition.GrpBArm && !partition.GrpCArm && !partition.GrpDArm) {
      return 'disarmed';
    } else {
      const panelState = returnPanelAlarmState(partition);
      logger.debug(`Panel alarm state for partition ${partition.Label} is ${panelState}.`);
      const partitionAlarmMapping = alarmMapping.slice(partitionId,partitionIdEnd);
      logger.verbose(`Currently mapped states are \n${JSON.stringify(partitionAlarmMapping, null, 2)}.`);
      logger.verbose(`Currently mapped keys are \n${JSON.stringify(partitionAlarmMapping[0][partitionLabel], null, 2)}.`);
      const mappedKey = (Object.keys(partitionAlarmMapping[0][partitionLabel]) as (keyof ArmingModes)[]).find((key) => {
        return partitionAlarmMapping[0][partitionLabel][key] === panelState;
        logger.debug(`Mapped key = ${mappedKey}`)});
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
      if (output.OStatus === 'a') {
        return {
          output: '1',
          text: 'Activated'};
      } else {
        return {
          output: '0',
          text: 'Deactivated'};
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
      return '1';
    } else {
      return '0';
    }
  }

  function publishPanelStatus(state) {
    if (config.auto_reconnect && state) {
      if (reconnect !== null )
      clearTimeout(reconnect);
    }
    if (config.panel.socketMode === 'proxy') {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/proxystatus`, panelStatus(state), { qos: 1, retain: true });
      logger.verbose(`[Panel => MQTT] Published proxy connection status ${panelStatus(state)}`);
    } else {
      mqttClient.publish(`${config.risco_mqtt_topic}/alarm/panelstatus`, panelStatus(state), { qos: 1, retain: true });
      logger.verbose(`[Panel => MQTT] Published panel connection status ${panelStatus(state)}`);
    }
    if (config.auto_reconnect && !state) {
      if (config.panel.socketMode === 'proxy') {
        logger.info('Proxy server not communicating.  Auto-reconnect turned on.  Wait 30 seconds before restarting to allow socket to reset.')
      } else {
        logger.info('Panel not communicating.  Auto-reconnect turned on.  Wait 30 seconds before restarting to allow socket to reset.')
      }
      reconnect = setTimeout(() => panel.riscoComm.tcpSocket.connect(),30000);
    }
  }

  function publishSystemStateChange(message) {
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/systemmessage`, `${message}`, { qos: 1, retain: true });
    logger.verbose(`[Panel => MQTT] Published system message ${message}`);
  }

  function publishPartitionStateChanged(partition: Partition) {
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/status`, alarmPayload(partition), { qos: 1, retain: true });
    logger.verbose(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`);
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
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/status`, 'online', {
      qos: 1, retain: true,
    });
    mqttClient.publish(`${config.risco_mqtt_topic}/alarm/button_status`, 'online', {
      qos: 1, retain: true,
    });
    logger.verbose('[Panel => MQTT] Published alarm online');
    let reconnectDelay;
    if (config.panel.socketMode === 'proxy') {
      reconnectDelay = 121000
    } else {
      reconnectDelay = 11000
    }
    loop = setTimeout(function() {
      publishOffline();
      publishPanelStatus(false)},reconnectDelay);
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
      availability: {
        topic: `${config.risco_mqtt_topic}/alarm/status`,
      },
      entity_category: 'diagnostic',
      device: getDeviceInfo(),
    };

    mqttClient.publish(`${config.ha_discovery_prefix_topic}/sensor/${config.risco_mqtt_topic}/systemmessage/config`, JSON.stringify(systemPayload), {
      qos: 1, retain: true,
    });
    logger.info(`[Panel => MQTT][Discovery] Published System message sensor, HA name = ${systemPayload.name}`);
    logger.verbose(`[Panel => MQTT][Discovery] System message payload\n${JSON.stringify(systemPayload, null, 2)}`);

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
      logger.info(`Added alarm state mapping for partition ${partitionLabel}.`)
      logger.verbose(`Added alarm state mappings for parition ${partitionLabel} as \n${JSON.stringify(alarmRemap, null, 2)}.`)
      logger.verbose(`Alarm mappings updated as \n${JSON.stringify(alarmMapping, null, 2)}.`)
      
      const payload = {
        name: partition.Label,
        object_id: `${config.risco_mqtt_topic}-${partition.Id}`,
        state_topic: `${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/status`,
        unique_id: `${config.risco_mqtt_topic}-partition-${partition.Id}`,
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/alarm_control_panel/${config.risco_mqtt_topic}/${partitionIdSegment}/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published alarm_control_panel to HA Partition label = ${partition.Label}, HA name = ${payload.name} on partition ${partition.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Alarm discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }

    for (const output of activeToggleOutputs(panel.outputs)) {

      const useroutputConf = cloneDeep(config.user_outputs.default);
      merge(useroutputConf, config.user_outputs?.[output.Label]);

      const payload = {
        name: output.Label,
        unique_id: `${config.risco_mqtt_topic}-output-${output.Id}`,
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
        availability: {
          topic: `${config.risco_mqtt_topic}/alarm/status`,
        },
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
    logger.info(`Publishing initial partitions, zones and outputs states to Home assistant`);
    for (const partition of activePartitions(panel.partitions)) {
      publishPartitionStateChanged(partition);
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
    logger.info(`Finished publishing initial partitions, zones and output states to Home assistant`);
    publishSystemStateChange('System initialized')
  }

  function partitionListener(Id, EventStr) {
    if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed', 'Alarm', 'StandBy', 'GrpAArmed', 'GrpBArmed', 'GrpCArmed', 'GrpDArmed', 'GrpADisarmed', 'GrpBDisarmed', 'GrpCDisarmed', 'GrpDDisarmed'].includes(EventStr)) {
      publishPartitionStateChanged(panel.partitions.byId(Id));
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
    if (['LowBattery', 'BatteryOK'].includes(EventStr)) {
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

  function panelOrMqttConnected() {
    if (!panelReady) {
      logger.info(`Panel is not connected, waiting`);
      return;
    }
    if (!mqttReady) {
      logger.info(`MQTT is not connected, waiting`);
      return;
    }
    logger.info(`Panel and MQTT communications are ready`);
    logger.info(`Publishing Home Assistant discovery info`);

    if (!initialized) {
      publishHomeAssistantDiscoveryInfo();
      publishOnline();
    }

    if (panelReady) {
      publishPanelStatus(true)
    }

    if (!listenerInstalled) {
      logger.info(`Subscribing to Home assistant commands topics`);
      for (const partition of activePartitions(panel.partitions)) {
        const partitionCommandsTopic = `${config.risco_mqtt_topic}/alarm/partition/${partition.Id}/set`;
        logger.info(`Subscribing to ${partitionCommandsTopic} topic`);
        mqttClient.subscribe(partitionCommandsTopic);
      }
      for (const zone of activeZones(panel.zones)) {
        const zoneBypassTopic = `${config.risco_mqtt_topic}/alarm/zone/${zone.Id}-bypass/set`;
        logger.info(`Subscribing to ${zoneBypassTopic} topic`);
        mqttClient.subscribe(zoneBypassTopic);
      }
      for (const output of activeToggleOutputs(panel.outputs)) {
        const outputTopic = `${config.risco_mqtt_topic}/alarm/output/${output.Id}/trigger`;
        logger.info(`Subscribing to ${outputTopic} topic`);
        mqttClient.subscribe(outputTopic);
      }
      for (const output of activeButtonOutputs(panel.outputs)) {
        const outputTopic = `${config.risco_mqtt_topic}/alarm/output/${output.Id}/trigger`;
        logger.info(`Subscribing to ${outputTopic} topic`);
        mqttClient.subscribe(outputTopic);
      }
      mqttClient.subscribe(`${config.risco_mqtt_topic}/republish`);

      publishPanelStatus(panelReady);
      logger.info(`Subscribing to panel partitions events`);
      panel.partitions.on('PStatusChanged', (Id, EventStr) => {partitionListener(Id, EventStr)});

      logger.info(`Subscribing to panel zones events`);
      panel.zones.on('ZStatusChanged', (Id, EventStr) => {zoneListener(Id,EventStr)});
      
      logger.info(`Subscribing to panel outputs events`);
      panel.outputs.on('OStatusChanged', (Id, EventStr) => {outputListener(Id,EventStr)});

      logger.info(`Subscribing to panel system events`);
      panel.mbSystem.on('SStatusChanged', (EventStr, value) => {publishSystemStateChange(EventStr)});

      logger.info(`Subscribing to Home Assistant online status`);
      mqttClient.subscribe(`${config.ha_discovery_prefix_topic}/status`, { qos: 0 }, function(error, granted) {
        if (error) {
          logger.error(`Error subscribing to ${config.ha_discovery_prefix_topic}/status`);
        } else {
          logger.info(`${granted[0].topic} was subscribed`);
        }
      });
      panel.riscoComm.on('Clock', publishOnline);
      panel.riscoComm.tcpSocket.on('Disconnected', (data) => {publishPanelStatus(false)});
      panel.riscoComm.on('PanelCommReady', (data) => {publishPanelStatus(true)});

      listenerInstalled = true;
    } else {
      logger.info('Listeners already installed, skipping listeners registration');
    }

    logger.info(`Initialization completed`);
  }
}