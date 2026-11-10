const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createRtcProvider } = require('../server/rtc-config');
test('production refuses missing TURN credentials', () => {
  assert.throws(() => createRtcProvider({ NODE_ENV: 'production' }));
});
test('coturn issues signed expiring credentials without exposing its shared secret', async () => {
  const secret = 'server-only-test-secret';
  const config = await createRtcProvider({ TURN_URLS: 'turn:example.com:3478', TURN_SHARED_SECRET: secret })('F');
  const turn = config.iceServers[1];
  assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
  assert.ok(config.expiresAt > Date.now());
  assert.ok(!JSON.stringify(config).includes(secret));
});
test('Cloudflare credentials are fetched on the server and key is not returned', async () => {
  const key = 'test-api-secret'; let called = false;
  const provider = createRtcProvider({ CF_TURN_KEY_ID: 'test-id', CF_TURN_API_TOKEN: key }, async (url, options) => {
    assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/test-id/credentials/generate-ice-servers');
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    called = true;
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-password' }] }) };
  });
  const config = await provider('F');
  assert.ok(called); assert.ok(!JSON.stringify(config).includes(key));
});
test('TURN service error does not silently downgrade online calls to STUN only', async () => {
  const provider = createRtcProvider({ CF_TURN_KEY_ID: 'id', CF_TURN_API_TOKEN: 'key' }, async () => ({ ok: false }));
  await assert.rejects(provider('F'));
});
