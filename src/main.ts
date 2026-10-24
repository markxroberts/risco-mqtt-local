#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { riscoMqttHomeAssistant, RiscoMQTTConfig } from './lib';
import { load, dump, CORE_SCHEMA, mergeTag } from 'js-yaml';

try {
  const addon = 'RISCO_MQTT_HA_CONFIG_FILE' in process.env;
  const jsonPath = addon ? process.env.RISCO_MQTT_HA_CONFIG_FILE : path.join(process.cwd(), 'config.json');
  const yamlPath = addon ? process.env.RISCO_MQTT_HA_CONFIG_YAML : path.join(process.cwd(), 'config.yaml');
  if (!jsonPath || !yamlPath) throw new Error('Both JSON and YAML configuration paths must be configured');
  // Preserve existing precedence: add-ons prefer JSON; containers prefer YAML.
  const useJson = addon ? fs.existsSync(jsonPath) : !fs.existsSync(yamlPath) && fs.existsSync(jsonPath);
  const configPath = useJson ? jsonPath : yamlPath;
  if (addon && !fs.existsSync(configPath)) {
    fs.copyFileSync(path.join(__dirname, '../config-sample.yaml'), configPath);
    console.log(`[RML] Created sample configuration at ${configPath}`);
  }
  console.log(`[RML] Loading config from: ${configPath}`);
  const text = fs.readFileSync(configPath, 'utf8');
  const config = (useJson ? JSON.parse(text) : load(text, { schema: CORE_SCHEMA.withTags(mergeTag) })) as RiscoMQTTConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Configuration must be an object');
  }
  if (useJson) {
    fs.writeFileSync(yamlPath, dump(config));
    console.log('[RML] Configuration converted to YAML. The JSON file may be safely deleted.');
  }
  riscoMqttHomeAssistant(config);
} catch (e) {
  console.error('[RML] Startup error', e);
  process.exit(1);
}
