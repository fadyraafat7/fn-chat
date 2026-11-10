require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const path = require('node:path');
async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in server/.env first.');
  const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'messages.sqlite'), { readOnly: true });
  const messages = db.prepare('SELECT id, sender, text, at FROM messages ORDER BY at, rowid').all();
  db.close();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 20000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE IF NOT EXISTS fn_messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, text TEXT NOT NULL, at BIGINT NOT NULL)');
    for (const m of messages) await client.query('INSERT INTO fn_messages (id,sender,text,at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [m.id,m.sender,m.text,m.at]);
    await client.query('COMMIT'); console.log('Message migration completed. Local messages were preserved.');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
}
migrate().catch(() => { console.error('Message migration failed; check the database connection and local file.'); process.exit(1); });
