const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');
const { Pool } = require('pg');
const { createRtcProvider } = require('../server/rtc-config');
const file = path.join(__dirname, '../.tools/cloud-deploy.env');
const env = parse(fs.readFileSync(file));
async function main() {
  let missing = false;
  if (env.RENDER_API_KEY) {
    const response = await fetch('https://api.render.com/v1/services?limit=1', { headers: { Authorization: `Bearer ${env.RENDER_API_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Render authorization failed (HTTP ' + response.status + ')');
    console.log('Render: API access verified.');
  } else { missing = true; console.log('Render: RENDER_API_KEY is missing.'); }
  if (env.DATABASE_URL) {
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 20000 });
    try { await pool.query('SELECT 1'); console.log('Neon: database access verified.'); } finally { await pool.end(); }
  } else { missing = true; console.log('Neon: DATABASE_URL is missing.'); }
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    await createRtcProvider({ ...env, NODE_ENV: 'production' })('connection-check');
    console.log('Cloudflare: temporary TURN credentials verified (not printed).');
  } else { missing = true; console.log('Cloudflare: TURN key settings are missing.'); }
  if (missing) process.exitCode = 2;
}
main().catch(error => { console.error(error.message.startsWith('Render authorization') ? error.message : 'Cloud connection check failed. Check the local settings; credentials were not printed.'); process.exitCode = 1; });
