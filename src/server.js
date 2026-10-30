// More libuv threads for concurrent password checks; must be set before any async I/O.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const market = require('./market');
const views = require('./views');
const { GameError } = require('./errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Mutating API calls must be JSON. Together with SameSite=Strict cookies this blocks
  // cross-site form posts against both team and admin sessions.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be application/json', code: 'bad_request' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/participant'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

  const pub = path.join(__dirname, '..', 'public');
  const built = path.join(pub, 'app');
  if (process.env.LEGACY_UI !== '1' && fs.existsSync(path.join(built, 'index.html'))) {
    // The React apps from frontend/ (npm run build): player at /, admin at /admin/.
    // Hashed asset files never change, so they can be cached forever; the HTML always revalidates.
    app.use('/assets', express.static(path.join(built, 'assets'), { immutable: true, maxAge: '365d', index: false }));
    const html = { setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } };
    app.use('/admin', express.static(path.join(built, 'admin'), html));
    app.get('/admin', (req, res) => res.redirect(301, '/admin/'));
    app.use('/', express.static(built, { ...html, index: 'index.html' }));
  } else {
    // Fallback: the original plain-JS screens (LEGACY_UI=1, or the React build is missing).
    app.use('/shared', express.static(path.join(pub, 'shared'), { maxAge: '5m' }));
    app.use('/admin', express.static(path.join(pub, 'admin')));
    app.use('/', express.static(path.join(pub, 'participant')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof GameError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON', code: 'bad_request' });
    // Other body-parser rejections (too large, bad charset/encoding) carry their own 4xx status.
    if (err.expose && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message, code: 'bad_request' });
    // Connection lost, server busy (pool/lock/statement timeout): nothing was committed, retry is safe.
    const connectionLost = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '57P02', '57P03', '55P03', '57014', '53300', '08006', '08001'].includes(err.code)
      || /timeout exceeded when trying to connect|Connection terminated/.test(err.message);
    console.error('[error]', req.method, req.originalUrl, err);
    db.logSystem('error', `${req.method} ${req.originalUrl}: ${err.message}`, { code: err.code });
    res.status(connectionLost ? 503 : 500).json({
      error: connectionLost ? 'The market server is temporarily unavailable. Your committed trades are safe.' : 'Internal error',
      code: 'server_error',
    });
  });
  return app;
}

function startTimers() {
  // Server-side deadline enforcement. Orders also check the deadline themselves, so a late
  // tick can never let a late order through.
  const close = setInterval(() => {
    db.withPriority(() => market.autoCloseExpired())
      .then((n) => { if (n) views.invalidate(); })
      .catch((err) => console.error('[timer] auto-close failed:', err.message));
  }, 1000);
  const sweep = setInterval(() => {
    db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  }, 10 * 60 * 1000);
  return () => { clearInterval(close); clearInterval(sweep); };
}

async function main() {
  await db.migrate();
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`MarketVerse listening on http://localhost:${port}`);
    console.log(`  players: /   admin: /admin/`);
  });
  server.keepAliveTimeout = 65000;
  const stopTimers = startTimers();
  await db.logSystem('info', 'server started', { pid: process.pid, port });

  const shutdown = (sig) => {
    console.log(`received ${sig}, shutting down`);
    stopTimers();
    server.close(() => db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // A stray rejected promise must not take the market down mid-round: every write is a
  // transaction, so logging and carrying on is safe.
  process.on('unhandledRejection', (err) => {
    console.error('[unhandled]', err);
    db.logSystem('error', `unhandled rejection: ${err && err.message}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createApp, startTimers };
