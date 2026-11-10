const { createHmac } = require('node:crypto');

function createRtcProvider(env = process.env, request = fetch) {
  const cloudflare = Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN);
  const coturn = Boolean(env.TURN_URLS && env.TURN_SHARED_SECRET);
  if (env.NODE_ENV === 'production' && !cloudflare && !coturn) throw new Error('Configure TURN before deploying: CF_TURN_KEY_ID/CF_TURN_API_TOKEN or TURN_URLS/TURN_SHARED_SECRET.');
  return async username => {
    if (cloudflare) {
      const response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error('TURN service unavailable');
      const data = await response.json();
      const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
      if (!servers.some(s => s && s.credential && [].concat(s.urls || []).some(url => /^turns?:/.test(url)))) throw new Error('TURN configuration is invalid');
      return { iceServers: servers, expiresAt: Date.now() + 86400000 };
    }
    if (coturn) {
      const expires = Math.floor(Date.now() / 1000) + 86400;
      const user = `${expires}:${username}`;
      const credential = createHmac('sha1', env.TURN_SHARED_SECRET).update(user).digest('base64');
      return { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: env.TURN_URLS.split(',').map(s => s.trim()), username: user, credential }], expiresAt: expires * 1000 };
    }
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  };
}
module.exports = { createRtcProvider };
