const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const { EventEmitter } = require('events');

// Exercise the actual nested handlers without opening panel or MQTT connections.
const source = fs.readFileSync('src/lib/risco-mqtt-local.ts', 'utf8');
const ast = ts.createSourceFile('risco-mqtt-local.ts', source, ts.ScriptTarget.Latest, true);
const handlers = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['errorListener', 'removeSocketListeners'].includes(node.name?.text)) {
    handlers.push(node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(handlers.length, 2);
function fixture(mode = 'proxy', autoConnect = true) {
  let disconnects = 0;
  let offline = 0;
  const socket = new EventEmitter();
  socket.disconnect = allowReconnect => {
    assert.equal(allowReconnect, true);
    disconnects++;
    // Simulate an error emitted during disconnect, before it completes.
    context.errorListener('CommsError', clockError);
  };
  const context = vm.createContext({
    config: { panel: { socketMode: mode, autoConnect } },
    panel: { riscoComm: Object.assign(new EventEmitter(), { tcpSocket: socket }) },
    panelReady: true, reconnecting: false, socketListeners: true,
    recoverySocket: undefined,
    logger: { info() {} }, publishPanelStatus() {},
    publishOffline() { offline++; }, socketDisconnected() {},
    disconnectedListener() {}, panelCommReadyListener() {},
    socketErrorListener() {}, commsErrorListener() {},
  });
  vm.runInContext(ts.transpile(handlers.join('\n')), context);
  return { context, socket, disconnects: () => disconnects, offline: () => offline };
}
const clockError = JSON.stringify({ name: 'RiscoCommandError', cmd: { commandStr: 'CLOCK', attempts: 4 } });
const f = fixture();
f.context.errorListener('CommsError', clockError);
f.context.errorListener('CommsError', clockError);
assert.equal(f.disconnects(), 1, 'restart once per socket, including reentrant errors');
assert.equal(f.offline(), 1);
assert.equal(f.context.panelReady, false);
assert.equal(f.context.reconnecting, true);
const replacement = { disconnect(reconnect) { assert.equal(reconnect, true); } };
f.context.panel.riscoComm.tcpSocket = replacement;
f.context.errorListener('CommsError', clockError);
assert.equal(f.context.recoverySocket, replacement, 'a later socket can recover again');
for (const [mode, auto] of [['direct', true], ['proxy', false]]) {
  const other = fixture(mode, auto);
  other.context.errorListener('CommsError', clockError);
  assert.equal(other.disconnects(), 0, 'respect mode and automatic connection setting');
}
for (const data of ['Socket Disconnected', 'New socket being connected', 'Invalid parameter', JSON.stringify({ name: 'RiscoCommandError', cmd: { commandStr: 'SSTT?' } })]) {
  const other = fixture();
  other.context.errorListener('CommsError', data);
  assert.equal(other.disconnects(), 0, 'do not restart on unrelated communications events');
}
const cleanup = fixture();
const comm = cleanup.context.panel.riscoComm;
for (let i = 0; i < 3; i++) {
  cleanup.socket.on('Disconnected', cleanup.context.disconnectedListener);
  cleanup.socket.on('SocketError', cleanup.context.socketErrorListener);
  comm.on('PanelCommReady', cleanup.context.panelCommReadyListener);
  comm.on('CommsError', cleanup.context.commsErrorListener);
  cleanup.context.removeSocketListeners();
  assert.equal(cleanup.socket.listenerCount('Disconnected'), 0);
  assert.equal(cleanup.socket.listenerCount('SocketError'), 0);
  assert.equal(comm.listenerCount('PanelCommReady'), 0);
  assert.equal(comm.listenerCount('CommsError'), 0);
}
console.log('Proxy recovery regression tests passed');
