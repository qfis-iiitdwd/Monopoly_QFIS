const crypto = require('crypto');
const passwords = require('./passwords');
const db = require('./db');
const { GameError } = require('./errors');

const TEAM_COOKIE = 'mv_team';
const ADMIN_COOKIE = 'mv_admin';

// Per-identifier failure throttle. Keyed on the account, not the IP, because the whole venue
// will likely share one NAT address. The threshold is deliberately high: a rival typing wrong
// passwords must not be able to lock a team out, and brute force is already hopeless (8 random
// characters behind scrypt). Sustained hammering gets a short cool-down and is reported to the
// organisers in the system log. Existing sessions are never affected.
const FAIL_WINDOW_MS = 60000;
const FAIL_LIMIT = 20;
const COOL_DOWN_MS = 15000;
const failures = new Map();
function checkRate(key) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) {
    throw new GameError(`Too many failed attempts for this ID. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} s.`, 429, 'rate_limited');
  }
}
function noteFailure(key) {
  const now = Date.now();
  const f = failures.get(key) || { n: 0, until: 0, first: now, reported: 0 };
  if (now - f.first > FAIL_WINDOW_MS) { f.n = 0; f.first = now; }
  f.n += 1;
  if (f.n >= FAIL_LIMIT) {
    f.until = now + COOL_DOWN_MS;
    f.n = 0;
    f.first = now;
    if (now - f.reported > FAIL_WINDOW_MS) {
      f.reported = now;
      db.logSystem('error', `Repeated failed logins for "${key}" — someone may be guessing this team's password`, { key });
    }
  }
  failures.set(key, f);
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (now - v.first > FAIL_WINDOW_MS && v.until < now) failures.delete(k);
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Malformed cookie value: treat as absent (→ 401), never a 500.
    }
  }
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}

async function createSession(kind, ids, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token, kind, team_id, admin_id, member_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [token, kind, ids.teamId || null, ids.adminId || null, ids.memberName || null, hours]);
  return token;
}

// Team passwords are stored in plain text, lowercase (the organisers hand them out and look them
// up), so a check is a constant-time string comparison: no hashing cost, however many log in at once.
// The admin password stays scrypt-hashed.
function teamPasswordMatches(team, password) {
  const stored = Buffer.from(String(team.password));
  const given = Buffer.from(password);
  return stored.length === given.length && crypto.timingSafeEqual(stored, given);
}

async function loginTeam(identifier, password, memberName) {
  identifier = String(identifier || '').trim().toLowerCase();
  // Team passwords are case-insensitive (all are stored lowercase; see seed.js).
  password = String(password || '').trim().toLowerCase();
  const key = 'team:' + identifier;
  checkRate(key);
  const { rows: [team] } = await db.query('SELECT * FROM teams WHERE lower(access_identifier) = $1 AND is_active', [identifier]);
  const ok = team && teamPasswordMatches(team, password);
  if (!ok) { noteFailure(key); throw new GameError('Incorrect team ID or password', 401, 'unauthorized'); }
  const { rows: [{ settings }] } = await db.query('SELECT settings FROM game_state WHERE id = 1');
  const hours = settings.session_hours || 14;
  const token = await createSession('team', { teamId: team.id, memberName: String(memberName || '').trim().slice(0, 40) || null }, hours);
  return { token, hours, team: { id: team.id, name: team.name, access_identifier: team.access_identifier } };
}

async function loginAdmin(username, password) {
  username = String(username || '').trim();
  const key = 'admin:' + username;
  checkRate(key);
  const { rows: [admin] } = await db.query('SELECT * FROM admins WHERE username = $1', [username]);
  let ok;
  try {
    ok = admin && (await passwords.verify(password, admin.password_hash));
  } catch (err) {
    if (err.busy) throw new GameError(err.message, 503, 'busy');
    throw err;
  }
  if (!ok) { noteFailure(key); throw new GameError('Incorrect admin credentials', 401, 'unauthorized'); }
  const token = await createSession('admin', { adminId: admin.id }, 16);
  await db.query(`INSERT INTO admin_audit_log (admin_id, action) VALUES ($1, 'admin_login')`, [admin.id]);
  return { token, hours: 16, admin: { id: admin.id, username: admin.username } };
}

// Session lookups happen on every authenticated request, so they're cached briefly. Logout and
// password reset evict entries immediately (single app instance; see README if you run several).
const SESSION_CACHE_MS = 5000;
const sessionCache = new Map();
function forgetSessions(match) {
  for (const [k, v] of sessionCache) if (match(v.s)) sessionCache.delete(k);
}

async function lookup(token, kind) {
  if (!token) return null;
  const hit = sessionCache.get(kind + ':' + token);
  if (hit && hit.until > Date.now()) return hit.s && new Date(hit.s.expires_at) > new Date() ? hit.s : null;
  const s = await lookupDb(token, kind);
  if (sessionCache.size > 20000) sessionCache.clear();
  sessionCache.set(kind + ':' + token, { s, until: Date.now() + SESSION_CACHE_MS });
  return s;
}

async function lookupDb(token, kind) {
  const { rows: [s] } = await db.query(
    `SELECT s.*, t.name AS team_name, t.access_identifier, a.username
       FROM sessions s LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN admins a ON a.id = s.admin_id
      WHERE s.token = $1 AND s.kind = $2 AND s.expires_at > now()`, [token, kind]);
  if (!s) return null;
  if (kind === 'team' && !s.team_id) return null;
  return s;
}

function requireTeam(req, res, next) {
  lookup(parseCookies(req)[TEAM_COOKIE], 'team')
    .then((s) => {
      if (!s) return res.status(401).json({ error: 'Please log in', code: 'unauthorized' });
      req.session = s;
      next();
    })
    .catch(next);
}

// Admin endpoints use a different cookie and session kind; a team session can never pass.
function requireAdmin(req, res, next) {
  lookup(parseCookies(req)[ADMIN_COOKIE], 'admin')
    .then((s) => {
      if (!s) return res.status(401).json({ error: 'Admin login required', code: 'unauthorized' });
      req.admin = s;
      next();
    })
    .catch(next);
}

async function logout(req, cookieName) {
  const token = parseCookies(req)[cookieName];
  if (!token) return;
  forgetSessions((s) => s && s.token === token);
  await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

module.exports = {
  TEAM_COOKIE, ADMIN_COOKIE, setCookie, loginTeam, loginAdmin, requireTeam, requireAdmin, logout, parseCookies,
  forgetTeamSessions: (teamId) => forgetSessions((s) => s && s.team_id === teamId),
};
