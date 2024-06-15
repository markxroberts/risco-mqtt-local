[![license badge](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/markxroberts/risco-mqtt-local/blob/main/LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/markxroberts/risco-mqtt-local)](https://hub.docker.com/r/markxroberts/risco-mqtt-local)
![Maintenance](https://img.shields.io/maintenance/yes/2024.svg)
[![buy me a coffee](https://img.shields.io/badge/If%20you%20like%20it-Buy%20me%20a%20coffee-orange.svg)](https://www.buymeacoffee.com/markxr)

[![Add to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmarkxroberts%2Frisco-mqtt-local)

# Risco MQTT Local integration

Provide Risco alarm panels integration to Home Assistant using Local TCP communication with Panel (no cloud access required)

This project is a fork of [Johann Vanackere](https://github.com/vanackej/risco-mqtt-local).  In turn this forks [risco-mqtt-home-assistant](https://github.com/mancioshell/risco-mqtt-home-assistant) by [Alessandro Mancini](https://github.com/mancioshell), using local APIs instead of RiscoCloud APIs.  Local APIs are based on [TJForc](https://github.com/TJForc) [local RISCO communication library](https://github.com/TJForc/risco-lan-bridge)

## Requirements

- Node.js (currently tested with >=ver. 10.x)
- Mqtt Server - e.g. Mosquitto, HiveMQ, etc.
- Home Assistant

## Features

- Interaction with RISCO alarm control panel using local APIs.
- Interaction with MQTT Alarm Control Panel integration in Home Assistant: maps away, home and disarmed by default or other states via config.
- Interaction with MQTT Binary Sensor integration in Home Assistant: sensors for each alarm state and additional alarm triggered sensor.
- Home Assistant MQTT Auto Discovery.
- RISCO multipartitions.
- Bypass zones in Home Assistant (additional switch created for each zone).
- Multiple systems with configurable alarm topic for each.
- Outputs supported.  Non-user-usable outputs represented as binary sensors (system outputs in configuration).  User-usable outputs represented as switches or buttons.  Note that pulsed switches are represented as buttons.  Refer to https://www.home-assistant.io/integrations/button/ and https://www.home-assistant.io/integrations/binary_sensor/ for acceptable device classes.
- Supports mapping of group arming via config file.
- Wireless zones now show battery status as additional binary sensors (this is the only information the panel gives).
- Separate binary sensors are provided that are only triggered in an alarm state. This permits automations based only on alarm-triggers.
- Panel connection status/proxy status sensor supported.
- Configurable reconnection delay after dropping of Cloud connection.
- Buttons to republish status, autodiscovery and reinitiate communications.
- Choose whether or not to allow bypass on entry/exit zones (filter_bypass_zones config option)
- System status sensor
- System battery status binary sensor
- Ready status sensor for each partition
- For home arming and group arming, delayed arming introduced in response to partition not ready (otherwise command just fails).  This will retry for up to 30 seconds if partition not ready to arm when arming command called.  HA alarm control panel will reflect this by showing 'arming'.  This is not the same as the Risco 'arming' state which initiates delayed arming (not supported).
- Local alarm code now supported.  This doesn't validate with the panel, but is for local validation within Home Assistant

## Installation

```
npm install @markxroberts/risco-mqtt-local
```
Or 
```
docker run -v $(pwd)/config.json:/data/config.json markxroberts/risco-mqtt-local:latest
```
Or install as HA add-on.

## Configuration

Create a file config.json in your project directory.  I suggest using config-sample.json in this folder rather than copying the commented version below.

```
{
  "log": "info", // Optional, default to "info"
  "panel": {
    "panelIp": "192.168.1.150",
    "panelPort": 1000,  // Optional
    "panelPassword": "1234",  // Optional
    "panelId": 1,
    "watchDogInterval": 10000,  // Optional
    "socketMode": "direct", // Optional
    "commandsLog": false // If enabled, dump all commands in a file named risco-commands-${date}.csv
  },
  "ha_discovery_prefix_topic": "homeassistant" //Optional
  "risco_mqtt_topic": "risco-alarm-panel", //Optional - topic to which state changes are published for multiple instances
  "filter_bypass_zones": true, // Optional - system filters out non-functional bypasses (usually entry and exit zones)
  "alarm_system_name": "Risco Alarm", // Optional - Device name and therefore prefix for HA sensor name
  "ha_state_publishing_delay": 30, // Optional - delay between autodiscovery and publishing states.  Without this delay HA may well show unknown state for sensors
  "alarm_code_arm_required": false, // Optional
  "alarm_code_disarm_required": false, // Optional
  "alarm_code": 1234 // Optional

  "mqtt": {
    "url": "mqtt://192.168.1.10:1883",
    "username": "MQTT_USERNAME",
    "password": "MQTT_PASSWORD"
  },
  "zones": {
    "default": { // Default zones configuration
      "off_delay": 30, // Optional auto off configuration for detectors. 0 to disable (default value: disabled)
      "name_prefix": "Sensor - " // A common prefix, added before all zone name
    },
    "GARAGE": { // Override config for an individual zone (based on zone label)
      "off_delay": 0, // Disable off_delay for this zone.
      "device_class": "garage_door", // override device class for binary sensor. default to "motion". see HA documentation for available values
      "name": "Garage Door", // Override default name for this zone. Default to zone label
      "name_prefix": "" // Force zone name prefix to empty for this zone
    },
  }
  "partitions": {
    "default": {
      "name_prefix": ""
    },
    "1": {
      "name": "House"
    },
    "2": {
      "name": "Garage"
    }
  },
  "user_outputs": {
    "default": {
      "name_prefix": ""
    },
    "Up/over Trigger": { 
      "device_class": "none", 
      "name": "Garage door trigger RISCO", 
      "name_prefix": "" 
    }
  },
  "system_outputs": {
    "default": {
      "name_prefix": ""
    },
    "Bell": { 
      "device_class": "sound", 
      "name": "Alarm Bell", 
      "name_prefix": "" 
    },
    "Strobe": { 
      "device_class": "light", 
      "name": "Alarm Strobe", 
      "name_prefix": "" 
    }
  }
  "arming_modes": {
    "House": { // Name of partition to remap
      "armed_away": "armed_away",  //optional - default shown
      "armed_home": "armed_home",  //optional - default shown
      "armed_night": "armed_home",  //optional - default shown
      "armed_vacation": "armed_away",  //optional - default shown
      "armed_custom_bypass: "armed_group_A" // Optional.  Example of group arming (takes A/B/C/D).  Default here is "armed_away"
  }
}

```

The panel full configuration options are described here : https://github.com/markxroberts/risco-lan-bridge#configuration

NB Ensure that zone description matches label stored in panel exactly (including case) to ensure that config is correctly represented.

## Subscribe Topics

**risco-mqtt-local** subscribes at startup one topic for every partition in your risco alarm panel configuration.

Topic format is `<risco_node_id>/alarm/<partition_id>/set` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

## Publish Topics

risco-mqtt-local publishes one topic for every partition and for every zones in your risco alarm panel configuration.

Partition topics format is `<risco_node_id>/alarm/<partition_id>/status` where **partition_id** is the id of the partition

Default payload could be: **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode, **armed_custom_bypass** if another mapping has been defined.

Zones topics format is `<risco_node_id>/alarm/<partition_id>/<zone_id>/status` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

Payload could be : **triggered** if zone is curently triggered, and **idle** if zone is currently idle.

In addition to every zone status, risco-mqtt-local publishes a topic for every zone with all the info of the zone in the payload in json format. Topics format is `<risco_node_id>/alarm/<partition_id>/<zone_id>` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

Zones that may be bypassed are published as switches at: `<risco_alarm_panel>/alarm/<partition_id>/switch/<zone_id>-bypass`.  On some systems, Entry/exit zones may not be bypassed and so you can choose not to publish this by setting the filter_bypass_zones flag.

Battery-powered zones have separate sensors for the battery.   These are published at: `<risco_node_id>/alarm/<partition_id>/<zone_id>/battery`.  These only have a binary state.

Outputs are published as `<risco_node_id/alarm>/<output_id>/status` for sensor outputs.  For outputs where interaction is possible, these are published as `<risco_node_id>/alarm/<output_id>/status` unless buttons, which are stateless.  Switches/buttons are published to `<risco_node_id>/alarm/<output_id>/set` as subscribed topics.

The cloud proxy status is published at `<risco_node_id>/alarm/cloudstatus` if the cloud proxy is enabled.

Arming modes are shown in the configuration example above.  All of these are optional.  Defaults are shown.  The syntax shown here must be used for mappings to work.

## Home Assistant Auto Discovery

risco-mqtt-local supports [mqtt auto discovery](https://www.home-assistant.io/docs/mqtt/discovery/) feature.

Default `<discovery_prefix>` is **homeassistant**. You can change it by overwriting the value within **ha_discovery_prefix_topic** config.

Home assistant auto discovery is republished on Home Assistant restart.

For multiple partitions, change **risco_mqtt_topic** in each installation.

## Usage

First, create the `config.json` file.  Only the first part of the file with system settings is mandatory.  It's not necessary to describe all of the zones/partitions/sensors as these can be customized from the Home Assistant front end.  I suggest using `config-sample.json` as a template.  The bind mount location is `/data` in the container.

It needs to be strictly in json format.

## Support

### Bug reports

Please use the bug issue template and fill all requested informations, including debug logs and commands logs.

## Credits

The bulk of this work was completed by [vanackej](https://github.com/vanackej).  I've adapted this and updated it, mainly for my purposes.  Thanks to [pergolafabio](https://github.com/pergolafabio) for the proxy testing.

Thanks to [TJForc](https://github.com/TJForc) for the local communication library and [Alessandro Mancini](https://github.com/mancioshell) for his initial work.
