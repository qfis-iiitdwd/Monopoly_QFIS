const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');

// BIGINT (paise) fits safely in a JS number up to ~9e15 paise (₹90 lakh crore).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const config = {
  connectionString: process.env.DATABASE_URL || 'postgres://marketverse:marketverse@localhost:5433/marketverse',
  // Fail fast instead of hanging: a request that can't get a connection in 10 s gets a 503 the
  // client retries; no statement or lock wait can stall a connection for more than 15 s.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
  keepAlive: true,
};
// Sent as startup parameters. Some transaction-mode poolers (PgBouncer) reject those: set
// DB_STARTUP_TIMEOUTS=0 and apply them with ALTER ROLE instead (see README).
if (process.env.DB_STARTUP_TIMEOUTS !== '0') {
  Object.assign(config, { statement_timeout: 15000, lock_timeout: 10000, idle_in_transaction_session_timeout: 30000 });
}
// Participants share the main pool. Admin requests and the deadline timer get their own small
// pool, so Pause/Close/Apply never queue behind 250 phones when the main pool is saturated.
const pool = new Pool({ ...config, max: Number(process.env.DB_POOL_SIZE || 20) });
const adminPool = new Pool({ ...config, max: Number(process.env.DB_ADMIN_POOL_SIZE || 4) });
for (const p of [pool, adminPool]) p.on('error', (err) => console.error('[db] idle client error', err.message));

const priority = new AsyncLocalStorage();
const current = () => (priority.getStore() ? adminPool : pool);
// Runs fn (and everything it awaits) on the admin pool.
const withPriority = (fn) => priority.run(true, fn);

async function query(text, params) {
  return current().query(text, params);
}

// Deadlock and serialization failures roll the whole transaction back, so running it again is safe.
const RETRYABLE = new Set(['40P01', '40001']);

// Runs fn(client) inside a transaction. Rolls back on any thrown error; retries transient conflicts.
async function tx(fn, { attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = await current().connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      if (RETRYABLE.has(err.code) && attempt < attempts) {
        logSystem('warn', 'transaction retried', { code: err.code, attempt });
        continue;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Serialize concurrent migrations (e.g. tests and server starting together).
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    await c.query(sql);
  });
}

async function logSystem(level, message, data) {
  try {
    await pool.query('INSERT INTO system_log (level, message, data) VALUES ($1, $2, $3)', [level, message, data ? JSON.stringify(data) : null]);
  } catch (err) {
    console.error('[db] failed to write system log', err.message);
  }
}

const end = () => Promise.all([pool.end(), adminPool.end()]);

module.exports = { pool, adminPool, withPriority, query, tx, migrate, logSystem, end };
