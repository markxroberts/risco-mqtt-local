const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
function fixture(config = {}) {
  const published = [], calls = [], timers = new Map();
  let panel, mqttOptions, timerId = 0;
  const client = new EventEmitter();
  client.publish = (topic, payload) => published.push({ topic, payload });
  client.subscribe = (topic, options, callback) => callback?.(null, [{ topic }]);
  function list(values) {
    return Object.assign(new EventEmitter(), { values, byId: id => values.find(v => v.Id === Number(id)) });
  }
  const partitions = list([
    { Id: 1, Label: 'House', Exist: true, Ready: false },
    { Id: 3, Label: 'Garage', Exist: true, Ready: true, GrpBArm: true },
  ]);
  const logger = Object.fromEntries(['info', 'verbose', 'debug', 'error', 'configure', 'log'].map(k => [k, () => {}]));
  class Panel extends EventEmitter {
    constructor() {
      super(); panel = this;
      this.partitions = partitions;
      this.zones = list([{ Id: 1, Label: 'Door', tech: 'W', type: 1 }]);
      this.outputs = list([{ Id: 1, Label: 'Light', UserUsable: true, Active: true, Pulsed: false }]);
      this.mbSystem = Object.assign(new EventEmitter(), { Label: 'Alarm', Status: 'AC fault' });
      this.riscoComm = Object.assign(new EventEmitter(), { tcpSocket: this.newSocket(), panelInfo: {} });
    }
    newSocket() {
      const socket = new EventEmitter();
      socket.disconnect = async reconnect => {
        calls.push(['disconnect', reconnect]);
        if (this.reentrantError) this.riscoComm.emit('CommsError', this.reentrantError);
        // Match the bridge's synchronous CommsError before Disconnected event.
        this.riscoComm.emit('CommsError', 'Socket Disconnected');
        socket.emit('Disconnected', reconnect);
      };
      return socket;
    }
    async armHome(id) { calls.push(['home', id]); return true; }
    async armAway(id) { calls.push(['away', id]); if (this.failAway) throw new Error('failed'); return true; }
    async armGroup(id, group) { calls.push(['group', id, group]); return true; }
    async disarmPart(id) { calls.push(['disarm', id]); return true; }
    async toggleOutput(id) { calls.push(['output', id]); return true; }
    async toggleBypassZone(id) { calls.push(['bypass', id]); return true; }
  }
  const exports = {};
  const context = vm.createContext({
    exports, Buffer, console,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === 'mqtt') return { connect(url, options) { mqttOptions = options; return client; } };
      if (name.includes('risco-lan-bridge')) return { RiscoPanel: Panel };
      if (name === 'winston') return { createLogger: () => logger, transports: { Console: class {}, File: class {} }, format: { combine() {}, timestamp() {}, printf() {}, colorize() {} } };
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync('dist/lib/risco-mqtt-local.js', 'utf8'), context);
  exports.riscoMqttHomeAssistant({ panel: { socketMode: 'proxy' }, mqtt: { url: 'mqtt://test' }, ...config });
  function init() { client.emit('connect'); panel.emit('SystemInitComplete'); }
  function message(suffix, value) { client.emit('message', `${config.risco_mqtt_topic || 'risco-alarm-panel'}/${suffix}`, Buffer.from(value)); }
  function runTimer(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) throw new Error(`No timer for ${delay}`);
    timers.delete(entry[0]); entry[1].fn();
  }
  return { panel, client, calls, published, timers, init, message, runTimer, mqttOptions,
    last(topic) { return published.filter(p => p.topic.endsWith(topic)).at(-1)?.payload; } };
}
module.exports = { fixture };
