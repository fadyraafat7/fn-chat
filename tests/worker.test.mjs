import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PrivateRoom } from '../worker/index.mjs';

const env = { USER_1: 'F', PASSWORD_1: 'first-test-password-only', USER_2: 'N', PASSWORD_2: 'second-test-password-only' };
class Socket {
  readyState = 1; sent = []; attachment = {};
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code) { this.code = code; this.readyState = 3; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  events(event) { return this.sent.filter(p => p.event === event).map(p => p.data); }
}
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const sockets = [];
  const ctx = {
    storage: {
      sql: { exec(query, ...params) { const statement = db.prepare(query); return { toArray: () => statement.all(...params) }; } },
      async setAlarm(value) { this.alarm = value; }, async deleteAlarm() { this.alarm = null; },
    },
    getWebSockets: () => sockets, setWebSocketAutoResponse() {},
  };
  // SQL mutations are eager in Cloudflare. Match that while using real SQLite.
  ctx.storage.sql.exec = (query, ...params) => {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) { const rows = statement.all(...params); return { toArray: () => rows }; }
    statement.run(...params); return { toArray: () => [] };
  };
  const room = new PrivateRoom(ctx, env);
  const socket = (address = 'test-ip') => { const s = new Socket(); s.serializeAttachment({ address, expires: Date.now() + 20000 }); sockets.push(s); return s; };
  const send = (s, event, data, id = 1) => room.webSocketMessage(s, JSON.stringify({ event, data, id }));
  const login = async (name, sessionToken) => { const s = socket(); await send(s, 'auth', { username: name, password: name === 'F' ? env.PASSWORD_1 : env.PASSWORD_2, sessionToken }); return s; };
  return { db, ctx, room, socket, send, login };
}

test('Worker messages and sessions survive object recreation; credentials stay private', async t => {
  const f = fixture(t), a = await f.login('F'), b = await f.login('N');
  await f.send(a, 'message', 'رسالة محفوظة');
  assert.equal(a.sent.find(p => p.ack === 1)?.data.ok, true);
  assert.equal(b.events('message')[0].from, 'F');
  assert.equal(JSON.stringify(a.sent).includes(env.PASSWORD_1), false);
  const restored = new PrivateRoom(f.ctx, env);
  const token = a.events('ready')[0].sessionToken;
  a.close(1000);
  const resumed = f.socket();
  await restored.webSocketMessage(resumed, JSON.stringify({ event: 'auth', data: { username: 'F', password: env.PASSWORD_1, sessionToken: token } }));
  assert.equal(resumed.events('ready')[0].messages[0].text, 'رسالة محفوظة');
  assert.equal(resumed.events('ready')[0].sessionToken, token);
});

test('Worker rejects third accounts, unauthenticated writes, and duplicate devices', async t => {
  const f = fixture(t), a = await f.login('F');
  const stranger = f.socket('other-ip');
  await f.send(stranger, 'auth', { username: 'third', password: env.PASSWORD_1 });
  assert.equal(stranger.code, 4001);
  const anonymous = f.socket(); await f.send(anonymous, 'message', 'blocked');
  assert.equal(anonymous.code, 4001);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  const duplicate = await f.login('F'); assert.equal(duplicate.code, 4001);
  const resumed = await f.login('F', a.events('ready')[0].sessionToken);
  assert.equal(a.code, 4002); assert.equal(resumed.events('ready').length, 1);
  await f.room.webSocketClose(a, 1000);
  assert.equal(resumed.events('presence').at(-1).includes('F'), true);
});

test('Worker relays calls only after callee acceptance and preserves call state across hibernation', async t => {
  const f = fixture(t), a = await f.login('F'), b = await f.login('N');
  await f.send(a, 'call', 'video', 10);
  const call = a.sent.find(p => p.ack === 10).data;
  await f.send(a, 'call-ready', { id: call.id });
  assert.equal(b.events('incoming-call')[0].from, 'F');
  await f.send(a, 'call-signal', { id: call.id, signal: { type: 'offer', sdp: 'before-acceptance' } });
  await f.send(a, 'call-answer', { id: call.id, accept: true });
  assert.equal(b.events('call-signal').length, 0);
  assert.equal(a.events('call-accepted').length, 0);
  const restored = new PrivateRoom(f.ctx, env);
  await restored.webSocketMessage(b, JSON.stringify({ event: 'call-answer', data: { id: call.id, accept: true }, id: 12 }));
  assert.equal(a.events('call-accepted')[0].id, call.id);
  await f.send(a, 'call-signal', { id: call.id, signal: { type: 'offer', sdp: 'accepted-offer' } });
  assert.equal(b.events('call-signal')[0].signal.sdp, 'accepted-offer');
  await f.send(b, 'call-signal', { id: 'wrong-id', signal: { type: 'answer', sdp: 'blocked' } });
  assert.equal(a.events('call-signal').length, 0);
  b.close(1000); await restored.webSocketClose(b, 1000);
  assert.equal(a.events('call-ended').at(-1).reason, 'disconnected');
});

test('Worker expires unanswered calls and anonymous sockets with durable alarms', async t => {
  const f = fixture(t), a = await f.login('F'); await f.login('N');
  const anonymous = f.socket(); anonymous.serializeAttachment({ expires: Date.now() - 1, address: 'expired' });
  await f.send(a, 'call', 'voice');
  const call = f.room.readCall(); call.expires = Date.now() - 1; f.room.saveCall(call);
  await new PrivateRoom(f.ctx, env).alarm();
  assert.equal(anonymous.code, 4001);
  assert.equal(a.events('call-ended').at(-1).reason, 'unanswered');
  assert.equal(f.room.readCall(), null);
});

test('Worker applies a persistent login limit and keeps chat available without TURN', async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) await f.send(f.socket('bad-ip'), 'auth', { username: 'F', password: 'incorrect' });
  const limited = f.socket('bad-ip');
  await new PrivateRoom(f.ctx, env).webSocketMessage(limited, JSON.stringify({ event: 'auth', data: { username: 'F', password: env.PASSWORD_1 } }));
  assert.equal(limited.code, 4001);
  assert.match(limited.events('connect_error')[0].message, /محاولات/);
  const good = f.socket('good-ip'); await f.send(good, 'auth', { username: 'F', password: env.PASSWORD_1 });
  await f.send(good, 'rtc-config', undefined, 8);
  assert.match(good.sent.find(p => p.ack === 8).data.error, /TURN/);
  const health = await f.room.fetch(new Request('https://test/health'));
  assert.equal(health.status, 200); assert.equal((await health.json()).callsConfigured, false);
});
