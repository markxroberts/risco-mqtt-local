<!-- https://developers.home-assistant.io/docs/add-ons/presentation#keeping-a-changelog -->
## 2026.1.5-beta2
- debug attempted to move to yaml files

## 2026.1.5-beta1
- attempted to move to yaml files

## 2026.1.3
- deprecated as didn't work as add-on

## 2026.1.2
- arm-v7 architecture deprecated
- republish MQTT discovery on restart
- added binary sensor for programming mode
- remove .json config example files in preparation for move to .yaml

## 2025.10.3
- config.yaml is now default
- HA autodiscovery now uses supported_features

## 2025.10.2
- updated MQTT autodiscovery definitions
- ability to use config.yaml instead of config.json

## 2023.8.1
- logging option logtofile (boolean)
- ability to temporarily change logging in live app

## 2023.8.0
- added system binary sensors for phone line, power and tamper status
- system status pulled from panel at startup
- breaking change: alarm system name acquired from system label at startup - this will relabel your sensors.

## To be releases
- add multiple panels support (#TODO)

## 0.4.3
- Build multi arch Docker images (#27)

## 0.4.2
- Republish state after home assistant restart

## 0.4.1
- fix #24: Bypassing zone errors

## 0.4.0
- fix #23: Zone config override issue
- fix #12: Add ability to bypass a zone
- fix #18: Add support for Agility 4/RW032 panels
- Add Home assistant Device info
- Improve reconnection behavior

## 0.3.8

- Fix a major bug in decryption mecanism

## 0.3.7

- Stability fixes
- Add option to logs all commands in a separated file

## 0.3.6

- Improve reliability during discovery
- Fix concurrency issues

## 0.3.5

- Use latest Docker image

## 0.3.4

- Display errors at startup
