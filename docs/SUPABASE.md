# Database: Supabase

Supabase is the game's **only** database: for the event, for development and for the tests. The app
refuses to start without `DATABASE_URL`.

Supabase is hosted PostgreSQL, so nothing about the
game changes: the same tables, the same `mv_place_order()` function, the same append-only triggers,
locks and constraints. The app creates and updates its tables itself at every startup
(`src/schema.sql`), exactly as before. Only *where* the database runs is different.

**Projects to create:** one for the event. The tests wipe their database, so they need a second,
separate project (`TEST_DATABASE_URL`); they refuse to run against the game's `DATABASE_URL`. Once the
event project holds real teams, develop and stress-test against the test project, never the event one.
Check your plan's limit on active projects.

---

## 1. Create the project (once)

1. **https://supabase.com/dashboard** → **New project**.
2. **Region: `South Asia (Mumbai)`** (`ap-south-1`). It must be close to the app server: every order
   is a database round trip. Oracle Mumbai/Hyderabad and Supabase Mumbai are a few ms apart.
3. Set a **database password**: long and random. Save it; Supabase shows it only once (it can be reset
   under *Database settings*).
4. When the project is ready: **Connect** (top bar) → **Session pooler** → copy the URI. It looks like
   ```
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   Put your password in place of `[YOUR-PASSWORD]`. If it contains `@ : / ? # % $ &` or spaces,
   percent-encode them (`@` → `%40`, `#` → `%23`, ...), or reset it to letters and digits only.

**Which connection string:**

| Supabase option | Use it? | Why |
|---|---|---|
| **Session pooler** (port 5432) | **Yes** | Works over IPv4 everywhere (Oracle, Railway, laptops, Docker). Behaves like a direct connection. |
| Direct connection (`db.<ref>.supabase.co`) | If the server has IPv6 | IPv6-only unless you buy the IPv4 add-on. Docker containers usually have no IPv6. |
| Transaction pooler (port 6543) | No | The app keeps a connection pool of its own. The app warns if you use it. |

## 2. Settings in the Supabase dashboard

- **Pool Size:** *Database settings → Connection pooling configuration → Pool Size*: at least **34**
  (the app's 24 connections + room for scripts). The session pooler refuses connections beyond it.
  `npm run preflight` opens all 24 at once and fails if this is too low.
- **Data API (optional):** the app never uses Supabase's REST/GraphQL API. At startup it already locks
  every game table and function away from it (row level security on, no grants to `anon` /
  `authenticated`), and preflight checks that. You can also switch the API off entirely under
  *Project settings → Data API*.
- **Free plan:** projects pause after a week without activity. Open the dashboard and *Restore* it a
  day before the event, or use a paid plan for the event week.

## 3. Point the app at it

Put the URI in `.env` (copy `.env.example`; it's git-ignored):
```sh
DATABASE_URL='postgresql://postgres.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
```
Use single quotes, so a `$` in the password stays literal. Every entry point reads `.env`: `npm start`,
`npm run seed`, `npm run preflight`, Docker Compose, and the backup/restore scripts. A variable that is
already set in the environment wins over `.env`.

Then, from the laptop:
```sh
npm start                                         # creates the tables in Supabase on first start; Ctrl-C
ADMIN_PASSWORD='...' npm run seed -- --reset      # or --test-passwords for practice
npm run preflight                                 # must say READY
```

**What the app does differently for a Supabase URL** (detected from the host name; `src/db.js`):
- **SSL on** (Supabase requires it). The connection is encrypted; the certificate isn't checked
  against Supabase's CA unless you set `DB_SSL=verify`. To verify it, download the CA from
  *Database settings → SSL configuration* and save it as `config/supabase-ca.crt` (or set `DB_SSL_CA=<path>`).
- **Time limits** (15 s per statement, 10 s per lock wait, 30 s idle in a transaction) are set on each
  new connection, not sent as startup parameters, because poolers can reject those.

## 4. Deploying

- **Oracle:** `deploy/oracle/deploy.sh ubuntu@<IP> --database-url '<URI>'` on the first run (or set
  `DATABASE_URL` in the laptop's `.env` and omit the flag). It is saved in the server's `.env`.
  `seed.sh`, `backup.sh` and updates work as before. See [`DEPLOY_ORACLE.md`](DEPLOY_ORACLE.md).
- **Any VPS with Docker:** `.env` with `DOMAIN`, `DATABASE_URL`, `ADMIN_PASSWORD`, then
  `docker compose up -d --build` (app + Caddy).
- **Railway / Render:** set `DATABASE_URL` to the URI on the app service; no database service needed.

Run exactly **one** app instance: the deadline timer and login throttles live in the process.

## 5. Backups and restore

```sh
sh scripts/backup.sh pre-event          # dump of the game tables → backups/, verified by a test restore
sh scripts/restore.sh backups/<file>.dump   # STOP THE APP FIRST; replaces all game data
```
Both use `DATABASE_URL` (environment or `.env`) and run `pg_dump`/`psql` in a throwaway
`postgres:17-alpine` container, so only Docker is needed. On the Oracle server,
`deploy/oracle/backup.sh` does the same and copies the dump to the laptop.

Restore empties the game tables and reloads them **in one transaction**: if anything fails, nothing
changes. The tables must exist, so start the app once against a brand-new project before restoring
into it. Paid Supabase plans also keep daily backups of their own; the scripts above are still the
ones to use between rounds.

## Moving an existing game

To move a game from the old built-in PostgreSQL to Supabase without losing anything:

1. **Dump the old database**:
   - Oracle, *before* deploying the new code: `deploy/oracle/backup.sh ubuntu@<IP> before-supabase`
     (the server still runs the old scripts; the dump lands in `./backups/`).
   - A local Docker PostgreSQL: `docker exec <container> pg_dump -U marketverse -Fc marketverse > backups/before-supabase.dump`.
2. Create the Supabase project (sections 1 and 2).
3. Create the tables: `DATABASE_URL='<URI>' npm start`, wait for "listening", Ctrl-C.
4. Load the game: `DATABASE_URL='<URI>' sh scripts/restore.sh backups/<file>.dump`.
5. Deploy: `deploy/oracle/deploy.sh ubuntu@<IP> --database-url '<URI>'`.
6. Admin app → *Audit & health* → integrity check, and `npm run preflight`.

The old PostgreSQL container is removed on that deploy, but its data volume (`marketverse_pgdata`)
stays on the server until you delete it (`docker volume rm marketverse_pgdata`) once you're satisfied.
