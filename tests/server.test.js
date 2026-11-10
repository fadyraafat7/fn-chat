const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

test('messages survive restart, sessions resume safely and calls require acceptance', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const url = `http://127.0.0.1:${port}`;
  let child; const clients = [];
  t.after(async () => { for (const c of clients) c.disconnect(); if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } fs.rmSync(dir, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', CF_TURN_KEY_ID: '', CF_TURN_API_TOKEN: '', TURN_URLS: '', TURN_SHARED_SECRET: '', PORT: String(port), USER_1: 'F', PASSWORD_1: 'password-one', USER_2: 'N', PASSWORD_2: 'password-two', DB_PATH: path.join(dir, 'messages.sqlite') }, stdio: ['ignore','pipe','pipe'] });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server failed to start'); })]);
  };
  const connect = (username, password, sessionToken) => new Promise((resolve, reject) => {
    const s = io(url, { auth: { username, password, sessionToken }, reconnection: false, timeout: 2000 }); clients.push(s);
    s.once('ready', data => resolve({ s, data })); s.once('connect_error', reject);
  });
  const ack = (s, event, value) => new Promise(resolve => s.emit(event, value, resolve));
  await start();
  await assert.rejects(connect('stranger', 'password-one'));
  const first = await connect('F', 'password-one');
  await assert.rejects(connect('F', 'password-one'));
  let second = await connect('N', 'password-two');
  const replaced = once(second.s, 'disconnect');
  second = await connect('N', 'password-two', second.data.sessionToken);
  await replaced;
  const rtc = await new Promise(resolve => second.s.emit('rtc-config', resolve));
  assert.ok(Array.isArray(rtc.iceServers));
  const received = once(second.s, 'message');
  assert.deepEqual(await ack(first.s, 'message', 'hello'), { ok: true });
  assert.equal((await received)[0].text, 'hello');
  const initiated = await ack(first.s, 'call', 'voice');
  let signals = 0; second.s.on('call-signal', () => signals++);
  first.s.emit('call-signal', { id: initiated.id, signal: { type: 'offer', sdp: 'early' } });
  const incoming = once(second.s, 'incoming-call'); first.s.emit('call-ready', { id: initiated.id });
  assert.equal((await incoming)[0].id, initiated.id);
  const accepted = once(first.s, 'call-accepted'); second.s.emit('call-answer', { id: initiated.id, accept: true }); await accepted;
  const delivered = once(second.s, 'call-signal'); first.s.emit('call-signal', { id: initiated.id, signal: { type: 'offer', sdp: 'valid' } });
  assert.equal((await delivered)[0].signal.sdp, 'valid'); assert.equal(signals, 1);
  first.s.disconnect(); second.s.disconnect(); child.kill(); await once(child, 'exit');
  await start(); const again = await connect('F', 'password-one');
  assert.equal(again.data.messages.length, 1); assert.equal(again.data.messages[0].text, 'hello');
});
