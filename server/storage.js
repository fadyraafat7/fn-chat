const path = require('node:path');
const fs = require('node:fs');

async function openStorage(env = process.env) {
  if (env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 20000, idleTimeoutMillis: 10000 });
    pool.on('error', error => console.error('Database connection error:', error.code || 'unavailable'));
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS fn_messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, text TEXT NOT NULL, at BIGINT NOT NULL)');
    } catch (error) { await pool.end(); throw error; }
    return {
      async history() {
        const { rows } = await pool.query('SELECT id, sender AS "from", text, at FROM (SELECT * FROM fn_messages ORDER BY at DESC, id DESC LIMIT 500) AS recent ORDER BY at ASC, id ASC');
        return rows.map(row => ({ ...row, at: Number(row.at) }));
      },
      async insert(message) { await pool.query('INSERT INTO fn_messages (id, sender, text, at) VALUES ($1, $2, $3, $4)', [message.id, message.from, message.text, message.at]); },
      async ping() { await pool.query('SELECT 1'); },
      close: () => pool.end(),
    };
  }
  if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production; local files on free hosting are temporary.');
  const { DatabaseSync } = require('node:sqlite');
  const filename = env.DB_PATH || path.join(__dirname, 'messages.sqlite');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO messages (id, sender, text, at) VALUES (?, ?, ?, ?)');
  const history = db.prepare('SELECT id, sender AS "from", text, at FROM (SELECT rowid, * FROM messages ORDER BY at DESC, rowid DESC LIMIT 500) ORDER BY at ASC, rowid ASC');
  return {
    async history() { return history.all(); },
    async insert(message) { insert.run(message.id, message.from, message.text, message.at); },
    async ping() { db.prepare('SELECT 1').get(); },
    async close() { db.close(); },
  };
}
module.exports = { openStorage };
