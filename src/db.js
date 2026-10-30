const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');

// BIGINT (paise) fits safely in a JS number up to ~9e15 paise (₹90 lakh crore).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

require('./env').loadEnvFile();

// The database is Supabase (docs/SUPABASE.md). There is no built-in default.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set: put the Supabase session pooler URI in .env (see docs/SUPABASE.md)');
}
const dbUrl = new URL(connectionString);
// Supabase: the session pooler (aws-0-<region>.pooler.supabase.com) or the direct host (db.<ref>.supabase.co).
const isSupabase = /\.supabase\.(co|com)$/i.test(dbUrl.hostname);

const config = {
  connectionString,
  // Fail fast instead of hanging: a request that can't get a connection in 10 s gets a 503 the
  // client retries; no statement or lock wait can stall a connection for more than 15 s.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
  keepAlive: true,
};

// DB_SSL: unset = whatever the URL says (on for Supabase); 'require' = encrypted; 'verify' = encrypted
// and the certificate checked against DB_SSL_CA (Supabase: Database settings → SSL → download certificate);
// '0' = off. The URL's own ssl* parameters would override this, so they are dropped when it applies.
const sslMode = process.env.DB_SSL || (isSupabase ? 'require' : '');
if (sslMode && sslMode !== '0') {
  for (const k of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) dbUrl.searchParams.delete(k);
  config.connectionString = dbUrl.toString();
  config.ssl = sslMode === 'verify'
    ? { rejectUnauthorized: true, ca: fs.readFileSync(process.env.DB_SSL_CA || path.join(__dirname, '..', 'config', 'supabase-ca.crt'), 'utf8') }
    : { rejectUnauthorized: false };
} else if (sslMode === '0') {
  config.ssl = false;
}

// Statement, lock and idle-transaction limits. 'startup' sends them as startup parameters (plain
// PostgreSQL); 'session' sets them on each new connection instead, which every Supabase connection
// mode accepts; '0' leaves them to the role (ALTER ROLE ... SET, see README). DB_STARTUP_TIMEOUTS
// picks one (1, session or 0); the default is session on Supabase, startup elsewhere.
const TIMEOUTS = { statement_timeout: 15000, lock_timeout: 10000, idle_in_transaction_session_timeout: 30000 };
const timeoutMode = { 0: 'off', 1: 'startup', session: 'session' }[process.env.DB_STARTUP_TIMEOUTS] || (isSupabase ? 'session' : 'startup');
if (timeoutMode === 'startup') Object.assign(config, TIMEOUTS);
const setTimeouts = Object.entries(TIMEOUTS).map(([k, v]) => `SET ${k} = ${v};`).join(' ');
if (isSupabase && dbUrl.port === '6543') {
  console.warn('[db] DATABASE_URL uses Supabase\'s transaction pooler (port 6543); use the session pooler (port 5432) so the per-connection time limits stick');
}

// Participants share the main pool. Admin requests and the deadline timer get their own small
// pool, so Pause/Close/Apply never queue behind 250 phones when the main pool is saturated.
// In session mode a new connection is handed out only after its limits are set (else it is discarded).
if (timeoutMode === 'session') config.onConnect = (client) => client.query(setTimeouts);
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

module.exports = { isSupabase, pool, adminPool, withPriority, query, tx, migrate, logSystem, end };
