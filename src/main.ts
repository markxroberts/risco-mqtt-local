#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
import {riscoMqttHomeAssistant, RiscoMQTTConfig} from './lib';
import yaml from 'js-yaml';

try {
    let configPath = ""
    let json = false
    if ("RISCO_MQTT_HA_CONFIG_FILE" in process.env) {
        // if this var is set, we know we are running in the addon
        console.log(`[RML] Running as add-on.  Checking if risco-mqtt.json exists`)
        configPath = process.env.RISCO_MQTT_HA_CONFIG_FILE
        if (fs.existsSync(configPath)) {
            json = true
            console.log(`[RML] risco-config.json exists so using this config`)
        } else {
        configPath = process.env.RISCO_MQTT_HA_CONFIG_YAML
        console.log(`[RML] Checking if risco-mqtt.yaml exists`)
        // check if is file
        const sampleConfigPath = path.join(__dirname, "../config-sample.yaml")
        if (!fs.existsSync(configPath) && fs.existsSync(sampleConfigPath)) {
            fs.copyFileSync(sampleConfigPath, configPath);
            json = false;
            console.log(`[RML] risco-mqtt.yaml created as didn't exit.  Now using this config`)
        } else {
            console.log(`[RML] risco-mqtt.yaml exists so using this config`)
        }}}
    else {
        const configJSON = path.join(process.cwd(), 'config.json')
        const configYAML = path.join(process.cwd(), 'config.yaml')
        console.log(`[RML] Running as container`)
        if (fs.existsSync(configYAML)) {
            configPath = configYAML
            json = false
            console.log(`[RML] config.yaml exists, so using this`)
        } else {
            configPath = configJSON
            console.log(`[RML] config.yaml doesn't exist, so using config.json`)
        }
    }
    console.log('[RML] Loading config from: ' + configPath)
    if (fs.existsSync(configPath) && json) {
        const config = require(configPath)
        let configYAML
        if ("RISCO_MQTT_HA_CONFIG_FILE" in process.env) {
            configYAML = process.env.RISCO_MQTT_HA_CONFIG_YAML
        }
        else {configYAML = path.join(process.cwd(), 'config.yaml')};
        fs.writeFile(configYAML, yaml.dump(config), (err) => { if (err) {console.log(err);}});
        console.log(`[RML] Configuration file converted to yaml.  JSON version may be safely deleted.`)
        riscoMqttHomeAssistant(config)
    }
    else if (fs.existsSync(configPath) && !json) {
        const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as RiscoMQTTConfig
        riscoMqttHomeAssistant(config)
    } else {
        console.log(`[RML] File ${configPath} does not exist`)
        process.exit(1)
    }
} catch (e) {
    console.error('[RML] Startup error', e)
    process.exit(1)
}