# Deploying on Oracle Cloud Always Free

This guide puts MarketVerse on a free Oracle Cloud server: an Ampere ARM machine with up to 4 CPUs
and 24 GB RAM, running the app and Caddy (automatic HTTPS) via Docker Compose. That is
more than the 1 CPU / 1 GB setup that passed every stress test. The database is a Supabase project:
create it first ([`SUPABASE.md`](SUPABASE.md), sections 1–2; pick the Mumbai region) and keep its
**Session pooler** URI at hand.

You do the account and server creation in the Oracle web console (Part A, about 20 minutes, once).
Everything after that is one command each from this laptop (Part B).

> Oracle's console changes its wording from time to time. If a button name below doesn't match
> exactly, look for the closest equivalent; the settings themselves are what matter.

---

## Part A: Oracle console (once)

### A1. Create the account
1. Go to **https://www.oracle.com/cloud/free/** → **Start for free**.
2. Fill in your details. A card is needed for identity verification only. Oracle may place a small
   temporary hold, but Always Free resources are never charged.
3. **Home region: choose `India West (Mumbai)` or `India South (Hyderabad)`.** This can't be changed
   later, and the server must be in your home region to be free. India keeps latency to players' phones low.
4. Wait for the "account is ready" email (minutes, occasionally longer), then sign in at
   **https://cloud.oracle.com**.

**Optional but recommended: upgrade to Pay As You Go** (*Billing & Cost Management → Upgrade and
Manage Payment*).
- Always Free resources stay free after upgrading.
- Upgraded accounts have far fewer "out of capacity" errors when creating the server.
- They are also exempt from Oracle reclaiming idle free servers (see A5).
- If you upgrade, also create a **budget alert** of ₹100 (*Billing → Budgets*) so you're emailed if
  anything ever starts costing money.

### A2. Create the server
1. Menu (☰) → **Compute → Instances → Create instance**.
2. **Name:** `marketverse`.
3. **Image and shape → Edit:**
   - **Image → Change image → Ubuntu → Canonical Ubuntu 24.04** (the normal one, not "Minimal").
     The build must be **aarch64** (it is selected automatically with the Ampere shape).
   - **Shape → Change shape → Virtual machine → Ampere → `VM.Standard.A1.Flex`**.
     **OCPUs: 2, Memory: 12 GB.** (Up to 4 OCPUs / 24 GB is free in total. 2/12 is plenty and is
     easier to get when capacity is tight.)
   - The shape must show the **"Always Free-eligible"** label.
4. **Networking:**
   - **Create new virtual cloud network** and **Create new public subnet** (defaults are fine).
   - **Automatically assign public IPv4 address: Yes**.
5. **Add SSH keys → Upload public key files** → choose `~/.ssh/id_ed25519.pub` from this laptop.
   (In the file picker press ⌘⇧. to show hidden folders.)
6. **Boot volume:** leave the default (about 47–50 GB; up to 200 GB total is free).
7. **Create**. After a minute or two the state turns **Running**. Copy the **Public IP address** from
   the instance page. It's referred to below as `<IP>`.

**"Out of capacity for shape VM.Standard.A1.Flex"?** That's common on free accounts. Try:
- 1 OCPU / 6 GB;
- another availability domain if your region lists several;
- trying again a few hours later;
- upgrading to Pay As You Go (A1), which usually fixes it at once.

### A3. Open ports 80 and 443
The server is behind Oracle's cloud firewall (the *security list*). By default it only lets SSH in.
1. On the instance page, click the **subnet** link (under *Primary VNIC*), or go to
   **Networking → Virtual cloud networks → your VCN → Subnets → the public subnet**.
2. Open **Security** (or *Security Lists*) → **Default Security List for …** → **Add Ingress Rules**.
3. Add **two** rules:

   | Source CIDR | IP protocol | Destination port |
   |---|---|---|
   | `0.0.0.0/0` | TCP | `80` |
   | `0.0.0.0/0` | TCP | `443` |

   (Leave *Stateless* unticked and *Source port* empty.)

Ubuntu's own firewall on the server also blocks these ports. The setup script opens it for you.

### A4. Check you can log in
From this laptop:
```sh
ssh ubuntu@<IP>
```
Type `yes` to trust the server the first time, then `exit`. If it hangs, the instance isn't running
or the public IP is wrong. If it says *Permission denied*, the wrong SSH key was uploaded in A2.5.

### A5. Things to know
- **Idle reclamation:** Oracle may reclaim an Always Free server that sits idle (CPU under ~20%) for
  7 days, on accounts that haven't upgraded. Upgrading to Pay As You Go avoids it. Otherwise
  redeploy if it happens: everything is scripted, and the game data is in your laptop backups.
- **The IP** stays the same through restarts. It changes only if you terminate the instance.
  (*Reserved public IPs* can make it permanent if you ever need that.)

---

## Part B: Deploy from this laptop

All commands run in the project folder (`~/QFIS/marketverse`). Requirements: `config/game.json`
exists (the event config), Part A is done, and the Supabase project exists.

### B1. Deploy
```sh
deploy/oracle/deploy.sh ubuntu@<IP> --database-url 'postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
```
(Single quotes around the URI. If `DATABASE_URL` is in this laptop's `.env`, `--database-url` can be left out.)
The first run takes about 5 minutes. It:
1. sets the server up: Docker, the firewall, the time zone (IST), automatic security updates;
2. copies the code, and `config/game.json` separately (it's never in git or in the image);
3. creates the server's `.env` with the database URI and a random admin password. **It prints the admin
   password once; save it.** It's also stored on the server in `/opt/marketverse/.env`;
4. builds and starts the app + Caddy, then waits until HTTPS answers. The app creates its tables in
   Supabase on first start.

At the end it prints the site address:
```
LIVE:  https://<IP-with-dashes>.sslip.io/        (players)
       https://<IP-with-dashes>.sslip.io/admin/  (organisers, user: admin)
```
`sslip.io` is a free service that turns `140-238-1-2.sslip.io` into the IP `140.238.1.2`, so Caddy can
get a real HTTPS certificate without you buying a domain.

**Own domain instead** (e.g. `market.qfis.in`):
1. Create a DNS **A record** pointing at `<IP>`.
2. Run `deploy/oracle/deploy.sh ubuntu@<IP> --domain market.qfis.in`.

**If Caddy can't get a certificate for sslip.io** (that service shares a weekly certificate limit with
everyone who uses it):
1. Create a free name at **https://www.duckdns.org** pointing at `<IP>`.
2. Deploy with `--domain yourname.duckdns.org`.

### B2. Seed the game
```sh
deploy/oracle/seed.sh ubuntu@<IP> --practice          # testers: team01 / pw-team01 … team50 / pw-team50
deploy/oracle/seed.sh ubuntu@<IP> --real              # the event: random passwords → ./credentials.csv
```
- Seeding **wipes the current game**.
- `--real` asks you to type `RESET`. It writes the team logins only to `credentials.csv` on this
  laptop: print the slips and keep the file private.
- Both finish by running the preflight check. In practice mode it reports **FAIL** for "test
  passwords"; that is expected.

### B3. Let people stress-test it
1. `deploy/oracle/seed.sh ubuntu@<IP> --practice`
2. Share the player link and logins `team01`/`pw-team01` … `team50`/`pw-team50` with testers.
   Give the admin link and password only to organisers.
3. In the admin app: **Start event → Open Round 1**. Testers trade. Then close, apply prices, and
   open the next round.

**Automated stress suites from this laptop** (they wipe the game; seed `--practice` again after):
```sh
ADMIN=$(ssh ubuntu@<IP> "grep ^ADMIN_PASSWORD= /opt/marketverse/.env | cut -d= -f2")
URL=https://<IP-with-dashes>.sslip.io

deploy/oracle/seed.sh ubuntu@<IP> --practice
ADMIN_PASSWORD=$ADMIN npm run laptops -- --url $URL                           # 50 laptops

deploy/oracle/seed.sh ubuntu@<IP> --practice --short-rounds                   # 20 s rounds
ADMIN_PASSWORD=$ADMIN npm run stress -- --url $URL                            # 94 edge-case checks

deploy/oracle/seed.sh ubuntu@<IP> --practice
node scripts/ui-audit.js --url $URL --admin-password "$ADMIN"                 # real browser, 138 checks

deploy/oracle/seed.sh ubuntu@<IP> --practice                                  # leave it ready for humans
```
The load comes from this laptop's connection. For a real-world test, also have 30–50 people on
phones (mobile data and the venue Wi-Fi) trade during one open round.

### B4. Update after code changes
```sh
deploy/oracle/deploy.sh ubuntu@<IP>
```
- It copies the new code and rebuilds. The `.env` and certificates are kept; the game data is in Supabase.
- `--database-url '<URI>'` switches to another database (e.g. a new Supabase password).
- The app restarts in a few seconds; phones reconnect by themselves.
- Avoid doing this while a round is open.
- If you changed `config/game.json`, seed again for it to take effect.

### B5. Day-to-day operations
```sh
ssh ubuntu@<IP>                                                   # then:
cd /opt/marketverse
docker compose ps                                                 # app and caddy "Up (healthy)"
docker compose logs -f --tail 100 app                             # live app log (Ctrl-C to leave)
docker compose restart app                                        # restart the app (state is in the DB)
docker compose exec app node scripts/preflight.js                 # readiness check
docker stats --no-stream                                          # CPU / memory per container
```
Backups (from the laptop; the dump is verified on the server, then copied to `./backups/`):
```sh
deploy/oracle/backup.sh ubuntu@<IP> pre-event
deploy/oracle/backup.sh ubuntu@<IP> after-r3
```
Restore (on the server, as a last resort):
```sh
cd /opt/marketverse && docker compose stop app && sh scripts/restore.sh backups/<file>.dump && docker compose start app
```
(Or from the laptop with `DATABASE_URL` in its `.env`: `sh scripts/restore.sh backups/<file>.dump`, with the server's app stopped.)
Backups and restores run `pg_dump`/`psql` in a `postgres:17-alpine` container against Supabase.

### B6. Event-day checklist
1. `deploy/oracle/deploy.sh ubuntu@<IP>`: latest code.
2. `deploy/oracle/seed.sh ubuntu@<IP> --real` → print `credentials.csv`.
3. The preflight it runs must say **READY**.
4. `deploy/oracle/backup.sh ubuntu@<IP> pre-event`
5. Follow the event-day runbook in the README. After each round: `deploy/oracle/backup.sh ubuntu@<IP> after-rN`.

---

## What runs where

```
Internet ──443/80──► Oracle security list ──► Ubuntu firewall ──► Caddy (HTTPS, certificates)
                                                                    │
                                                                    ▼
                                                     app (Node, port 3000, internal only)
                                                                    │
                                                                    │ SSL
                                                                    ▼
                                                 Supabase PostgreSQL (Mumbai, session pooler)
```
- `/opt/marketverse` on the server holds:
  - the code;
  - `.env`, with the database URI and admin password, mode 600;
  - `config/game.json`;
  - `backups/`.
- The app port is not reachable from the internet; only Caddy is. Supabase is reached over SSL with
  the database password, and the app locks Supabase's public API out of the game tables at startup.
- SSH accepts only your key; Oracle's Ubuntu images disable password logins.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `deploy.sh` waits and then says HTTPS didn't answer | Check A3 (ingress rules for 80 and 443). Then `ssh ubuntu@<IP> 'cd /opt/marketverse && docker compose logs --tail 50 caddy'`. Certificate errors there mean port 80 is blocked or the domain doesn't point at `<IP>`. |
| `ssh: connect … timed out` | The instance is stopped, or the IP changed (instance terminated). Check the console. |
| `BUILD/START FAILED` | The script prints the log. Usually disk or network trouble. Run it again. |
| Players see "Connection lost" | `docker compose ps`; `docker compose logs app`. The app restarts by itself if it crashes. |
| Forgot the admin password | `ssh ubuntu@<IP> "grep ADMIN_PASSWORD /opt/marketverse/.env"` |
| Want to start completely fresh | `deploy/oracle/seed.sh ubuntu@<IP> --real` wipes and re-creates the game in Supabase. `ssh ubuntu@<IP> 'cd /opt/marketverse && docker compose down -v'` also deletes the certificates; then run `deploy.sh` again. |
| `deploy.sh` says the server's `.env` has no `DATABASE_URL` | The server ran the old built-in PostgreSQL. Pass `--database-url`; to keep that game, follow "Moving an existing game" in [`SUPABASE.md`](SUPABASE.md) first. |
| App log shows database errors | Check `DATABASE_URL` in `/opt/marketverse/.env` and the Supabase troubleshooting rows in the README. Is the Supabase project paused? |
