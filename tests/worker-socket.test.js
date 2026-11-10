const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkerSocket } = require('../WorkerSocket');

class FakeWebSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen(); }
  receive(data) { this.onmessage({ data: JSON.stringify(data) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}
function create(t) {
  const client = new WorkerSocket('https://fn.test', { auth: { username: 'F', password: 'test-only' }, WebSocketImpl: FakeWebSocket });
  t.after(() => client.disconnect()); client.connect();
  const ws = FakeWebSocket.instances.at(-1); ws.open();
  return { client, ws };
}

test('mobile Worker transport sends credentials in first message and supports ack callbacks', async t => {
  const { client, ws } = create(t);
  assert.equal(ws.url, 'wss://fn.test/ws');
  assert.equal(ws.sent[0].event, 'auth');
  let session;
  client.on('ready', value => { session = value; });
  ws.receive({ event: 'ready', data: { name: 'F', sessionToken: 'private-token' } });
  assert.equal(client.connected, true); assert.equal(client.auth.sessionToken, session.sessionToken);
  const result = new Promise((resolve, reject) => client.timeout(1000).emit('message', 'hello', (error, data) => error ? reject(error) : resolve(data)));
  const packet = ws.sent.at(-1); assert.equal(packet.data, 'hello');
  ws.receive({ ack: packet.id, data: { ok: true } });
  assert.deepEqual(await result, { ok: true });
});

test('mobile Worker transport stops reconnecting after authentication denial', t => {
  const { client, ws } = create(t); let activeAtError;
  client.on('connect_error', () => { activeAtError = client.active; });
  ws.receive({ event: 'connect_error', data: { message: 'Denied' } });
  assert.equal(activeAtError, false); assert.equal(client.stopped, true); assert.equal(client.retry, undefined);
});

test('mobile Worker transport resumes its token after network loss and cancels in-flight acks', async t => {
  const { client, ws } = create(t);
  ws.receive({ event: 'ready', data: { sessionToken: 'resume-token' } });
  const interrupted = new Promise(resolve => client.timeout(1000).emit('call', 'voice', error => resolve(error)));
  ws.close(1006); assert.ok(await interrupted); assert.equal(client.active, true);
  client.connect(); const resumed = FakeWebSocket.instances.at(-1); resumed.open();
  assert.equal(resumed.sent[0].data.sessionToken, 'resume-token');
  resumed.receive({ event: 'ready', data: { sessionToken: 'resume-token' } });
  assert.equal(client.connected, true);
});
