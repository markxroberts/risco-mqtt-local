#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
import {riscoMqttHomeAssistant, RiscoMQTTConfig} from './lib';
import yaml from 'js-yaml';

try {
    let configPath = ""
    let json = true
    if ("RISCO_MQTT_HA_CONFIG_FILE" in process.env) {
        // if this var is set, we know we are running in the addon
        configPath = process.env.RISCO_MQTT_HA_CONFIG_FILE
        // check if is file
        const sampleConfigPath = path.join(__dirname, "../config-sample.json")
        if (!fs.existsSync(configPath) && fs.existsSync(sampleConfigPath)) {
            fs.copyFileSync(sampleConfigPath, configPath);
        }
    } else if ("RISCO_MQTT_HA_CONFIG_YAML" in process.env) {
        // if this var is set, we know we are running in the addon
        configPath = process.env.RISCO_MQTT_HA_CONFIG_YAML
        // check if is file
        const sampleConfigPath = path.join(__dirname, "../config-sample.yaml")
        if (!fs.existsSync(configPath) && fs.existsSync(sampleConfigPath)) {
            fs.copyFileSync(sampleConfigPath, configPath);
            json = false;
        }
    } else {
        const configJSON = path.join(process.cwd(), 'config.json')
        const configYAML = path.join(process.cwd(), 'config.yaml')
        if (fs.existsSync(configJSON)) {
            configPath = configJSON
        } else {
            configPath = configYAML
            json = false
        }
    }
    console.log('[RML] Loading config from: ' + configPath)
    if (fs.existsSync(configPath) && json) {
        const config = require(configPath)
        riscoMqttHomeAssistant(config)
    }
    else if (fs.existsSync(configPath) && !json) {
        const config = yaml.load(fs.readFileSync(configPath, 'utf-8') as RiscoMQTTConfig)
        riscoMqttHomeAssistant(config)
    } else {
        console.log(`[RML] File ${configPath} does not exist`)
        process.exit(1)
    }
} catch (e) {
    console.error('[RML] Startup error', e)
    process.exit(1)
}