const { test } = require('node:test');
const assert = require('node:assert/strict');
const configure = require('../app.config');
const { openStorage } = require('../server/storage');
test('online build requires a remote HTTPS address', () => {
  const saved = { url: process.env.FN_SERVER_URL, online: process.env.FN_ONLINE_BUILD };
  try {
    process.env.FN_ONLINE_BUILD = '1';
    for (const address of ['http://127.0.0.1:3000', 'http://example.com', 'https://localhost']) {
      process.env.FN_SERVER_URL = address; assert.throws(() => configure({ config: {} }));
    }
    process.env.FN_SERVER_URL = 'https://fn.example.com';
    assert.equal(configure({ config: {} }).extra.serverUrl, 'https://fn.example.com');
  } finally {
    for (const [key,value] of [['FN_SERVER_URL',saved.url], ['FN_ONLINE_BUILD',saved.online]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('production cannot silently use temporary local SQLite storage', async () => {
  await assert.rejects(openStorage({ NODE_ENV: 'production' }), /DATABASE_URL/);
});

test('Workers URLs select native WebSocket transport while Node URLs retain Socket.IO', () => {
  const saved = process.env.FN_SERVER_URL;
  try {
    delete process.env.FN_SERVER_URL;
    assert.equal(configure({ config: { extra: { serverUrl: 'https://fn-chat.example.workers.dev' } } }).extra.serverTransport, 'websocket');
    assert.equal(configure({ config: { extra: { serverUrl: 'https://fn.example.com' } } }).extra.serverTransport, 'socket.io');
  } finally { if (saved === undefined) delete process.env.FN_SERVER_URL; else process.env.FN_SERVER_URL = saved; }
});
