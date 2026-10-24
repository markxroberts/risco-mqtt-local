const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const yaml = require('js-yaml');
const source = fs.readFileSync('dist/main.js', 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risco-startup-'));
function start(env = {}) {
  let loaded;
  const exports = {};
  const context = vm.createContext({ exports, JSON, __dirname: path.resolve('dist'), console: { log() {}, error() {} },
    process: { env, cwd: () => dir, exit(code) { throw new Error(`exit ${code}`); } },
    require(name) { return name === './lib' ? { riscoMqttHomeAssistant(config) { loaded = config; } } : require(name); },
  });
  vm.runInContext(source, context);
  return loaded;
}
try {
  const config = { panel: { panelPassword: '0012' }, mqtt: { url: 'mqtt://test' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  assert.deepEqual(JSON.parse(JSON.stringify(start())), config, 'container JSON is parsed as JSON');
  assert.deepEqual(yaml.load(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')), config);
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml.dump({ ...config, log: 'debug' }));
  assert.equal(start().log, 'debug', 'container prefers YAML');
  assert.equal(start({ RISCO_MQTT_HA_CONFIG_FILE: path.join(dir, 'config.json'), RISCO_MQTT_HA_CONFIG_YAML: path.join(dir, 'config.yaml') }).log, undefined, 'addon preserves JSON precedence');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'defaults: &defaults\n  url: mqtt://test\nmqtt:\n  <<: *defaults\n');
  fs.unlinkSync(path.join(dir, 'config.json'));
  assert.equal(start().mqtt.url, 'mqtt://test', 'YAML merge keys remain supported');
  fs.unlinkSync(path.join(dir, 'config.yaml'));
  const addonConfig = start({ RISCO_MQTT_HA_CONFIG_FILE: path.join(dir, 'config.json'), RISCO_MQTT_HA_CONFIG_YAML: path.join(dir, 'config.yaml') });
  assert.equal(typeof addonConfig.mqtt.url, 'string', 'new add-on gets its sample config');
  fs.unlinkSync(path.join(dir, 'config.yaml'));
  assert.throws(() => start(), /exit 1/);
  fs.writeFileSync(path.join(dir, 'config.yaml'), '[]');
  assert.throws(() => start(), /exit 1/, 'reject non-object configuration');
  console.log('Startup regression tests passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
