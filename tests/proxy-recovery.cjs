const assert = require('assert/strict');
const { fixture } = require('./helpers.cjs');
const clockError = JSON.stringify({ name: 'RiscoCommandError', cmd: { commandStr: 'CLOCK', attempts: 4 } });
const f = fixture(); f.init();
const old = f.panel.riscoComm.tcpSocket;
f.panel.reentrantError = clockError;
f.panel.riscoComm.emit('CommsError', clockError);
f.panel.riscoComm.emit('CommsError', clockError);
assert.equal(f.calls.filter(c => c[0] === 'disconnect').length, 1);
assert.equal(f.last('/alarm/status'), 'offline');
assert.equal(old.listenerCount('SocketError'), 0);
assert.equal(old.listenerCount('Disconnected'), 0);
for (let i = 0; i < 3; i++) {
  f.panel.riscoComm.tcpSocket = f.panel.newSocket();
  f.panel.emit('SystemInitComplete');
  assert.equal(f.panel.riscoComm.listenerCount('CommsError'), 1);
  assert.equal(f.panel.riscoComm.listenerCount('PanelCommReady'), 1);
  f.panel.riscoComm.emit('CommsError', clockError);
}
assert.equal(f.calls.filter(c => c[0] === 'disconnect').length, 4);
for (const panel of [{ socketMode: 'direct', autoConnect: true }, { socketMode: 'proxy', autoConnect: false }]) {
  const other = fixture({ panel }); other.init();
  other.panel.riscoComm.emit('CommsError', clockError);
  assert.equal(other.calls.length, 0);
}
console.log('Proxy recovery regression tests passed');
