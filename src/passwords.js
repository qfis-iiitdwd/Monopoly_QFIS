// Password hashing with Node's scrypt. Verification runs on the libuv thread pool, but at most
// SCRYPT_CONCURRENCY checks run at once (default 2): on a small server, eight CPU-heavy checks in
// parallel starve order processing (measured on a 1-vCPU stack: orders stalled ~9 s during a
// 150-laptop login rush). Extra checks wait in a queue; a very long queue is refused with 503.
const crypto = require('crypto');

const ADMIN_N = 16384;
// Team passwords are 8 random characters (~40 bits) behind a per-account login throttle, so a
// cheaper cost is safe and makes a hall-wide login rush 4× lighter (≈27 ms per check on 0.6 vCPU).
const TEAM_N = 4096;
const KEYLEN = 32;
const CONCURRENCY = Math.max(1, Number(process.env.SCRYPT_CONCURRENCY || 2));
const MAX_QUEUE = Number(process.env.SCRYPT_MAX_QUEUE || 300);

function hash(password, N = ADMIN_N) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

let running = 0;
const queue = [];
function release() {
  running--;
  const next = queue.shift();
  if (next) next();
}

function verify(password, stored) {
  const [scheme, n, saltB64, keyB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt') return Promise.resolve(false);
  if (queue.length >= MAX_QUEUE) {
    const err = new Error('Login is busy, please try again in a few seconds');
    err.busy = true;
    return Promise.reject(err);
  }
  return new Promise((resolve) => {
    const run = () => {
      running++;
      const expected = Buffer.from(keyB64, 'base64');
      crypto.scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 }, (err, key) => {
        release();
        resolve(!err && key.length === expected.length && crypto.timingSafeEqual(key, expected));
      });
    };
    if (running < CONCURRENCY) run(); else queue.push(run);
  });
}

module.exports = { hash, verify, TEAM_N, ADMIN_N, queueLength: () => queue.length };
