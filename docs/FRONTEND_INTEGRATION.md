# Plan: connect the Monopoly frontend to the MarketVerse API

> **Status (30 Oct 2026): done.** The frontend lives in `frontend/`. Every screen reads from and writes to the API, and the mock data files are deleted.
> - **Build check:** the build fails if mock data, `alert()` stubs, random numbers or the old demo tickers/teams come back.
> - **Proof:** `scripts/ui-audit.js` runs 111 checks in a real browser, including clicking every visible button on every page.
> - **Other tests:**
>   - backend tests 28/28;
>   - stress suite PASS;
>   - 50-laptop suite PASS.
>
> **Decisions taken:**
> - **CEO and details:** CEO names and extra company facts come from the organisers. `ceo` and `details` exist in the config and on the admin *Companies* page.
> - **Rankings:** teams don't see a leaderboard; the API returns 404 to teams.
> - **News:** newspapers and news go out on WhatsApp, so the portal has no news screens or uploads.
> - **Teams:** a team can be disabled and re-enabled.
> - **Not built:**
>   - free-text news and per-team messages;
>   - CSV import of the price script (it stays a command-line step).
> - **Added:** Event start/end and system health are on Overview. A Companies page was added to the admin app.
>
> The sections below are the original plan, kept for reference.

Source: `~/Downloads/Monopoly frontend` (React 18 + TypeScript + Tailwind + Vite).
Backend: this repo. Endpoint reference: [`API.md`](API.md).

## 1. What the frontend is today

The design is good. Every number and every button behind it is fake:

- **All data is mock.** `src/data/mockData.ts` and `src/data/adminMockData.ts` feed every screen through `useState` in `App.tsx`. Nothing calls a server.
- **Every action only changes browser memory.**
  - Buy/Sell edits a local array.
  - Pause, Close Market and Save Prices flip local variables.
  - Adjust Cash adds to a local number.
  - Reverse deletes a row from a local list.
  - A page refresh resets everything.
- **About 20 buttons are `alert()` stubs**, including:
  - Logout (both portals), Add Round, End Round, View Round Summary, View All Events;
  - Import from CSV, both Upload File buttons;
  - Reset Password (it pretends a "link was sent"), Edit Members, Reverse, View all transactions, Full activity ledger;
  - the three Export CSV buttons.
- **Hard-coded figures sit in the JSX.** These include:
  - "237 participants, +12", "16 companies", "1,428 orders, +18%", "₹ 18,42,560, +24%";
  - "₹ 15,62,400"; "1,236 / 142 / 50" order counts; "12,846 / 9,421 / 1,842 / 1,583" transactions;
  - "712 buy (49.9%) / 716 sell"; average order value ₹12,860;
  - the balance chart (a fixed SVG curve, R1–R5);
  - "Round 3 · Market Open" on every player page; the "Round 3 newspaper" banner;
  - three made-up news articles; four made-up round-history rows;
  - company filter options ALP/BVG/CRL/DYN/EKO; team filter options Team 07/12/03/21;
  - Round 1–6 lists (the event has 10); fixed page counts 16 / 96 / 856;
  - the starting net worth `1100000`.
- **Security hole: a "Player View / Admin Panel" switch** is on every screen. Anyone could open the admin panel. There are also no login screens at all.
- **Some controls have no backend equivalent at all**, for example "set any new price", "Add Round", "Allow short selling", "Pending/Cancelled orders" and "Dividend/Penalty" transactions. Section 4 decides each one.

**Rule for the integration:** a number appears on screen only if it came from an API response. A button shows success only after the server confirms. There are no optimistic updates. Anything the backend cannot do is removed or built for real, never left as a stub.

## 2. Architecture

- **Location.** Copy the frontend into this repo as `frontend/`, run `git init`, and make the first commit.
- **Two separate apps, two HTML entry points** (Vite multi-page build):
  - `frontend/index.html` is the player app, served at `/`;
  - `frontend/admin/index.html` is the admin app, served at `/admin/`.
  - Delete the role switcher and both "Switch to …" buttons. An admin URL is never linked from the player app.
- **Same origin.** `vite build` outputs into `public/participant` and `public/admin`, which Express already serves.
  - Cookies keep working (HttpOnly, SameSite=Strict) and no CORS is needed.
  - In development, Vite's proxy sends `/api` to `localhost:3000`.
  - Keep the current vanilla UIs as `public/*-legacy` until the new ones pass section 6, then delete them.
- **`src/api/client.ts`**: one `fetch` wrapper.
  - Sends JSON with `credentials: 'same-origin'`.
  - Parses `{error, code}`.
  - On `401` it shows the login screen. On `503` it retries with backoff. On a network error it shows the offline banner.
- **`src/api/types.ts`**: TypeScript types copied from the real responses (not from the mock types). The mock types `ParticipantTeam`, `AdminOrder` and others are deleted.
- **Money.** The API uses integer paise; the UI shows rupees.
  - `formatters.ts` gains `paiseToINR()`. No float maths on money anywhere.
  - Quantities are integers.
- **Live state.** Poll `/api/market/status` every 2 s (the backend is built and load-tested for this).
  - When `current_round` or `phase` changes, refetch portfolio and prices.
  - The countdown uses `server_time` and `deadline`, never the laptop clock.
- **Delete `src/data/`.** A build check (`npm run check:nomock`) fails the build if the source contains any of:
  - `mockData`, `adminMockData`, `alert(`, `Math.random`;
  - the old fake tickers (`ALP|BVG|CRL|DYN|EKO`).

## 3. Player app: every element and its API

| Screen / element | Today | Connect to |
|---|---|---|
| **Login screen** (new; the design has none) | missing | `POST /api/auth/login {team_id, password, member_name}`. Shows the server's error text, including the "too many attempts" and "busy" messages. |
| Sidebar team name, player name, initials | `INITIAL_USER` | `GET /api/me` |
| Logout | `alert('Logged out')` | `POST /api/auth/logout`, then show the login screen |
| **Dashboard**: Net Worth, Cash, Holdings Value, P&L, % | computed from mock with a fixed ₹11,00,000 start | `GET /api/portfolio` (`net_worth`, `cash`, holdings value, P&L, rank). The P&L colour and sign follow the data; the design always shows green "+". |
| Market Status card: round number, "Market Open" | hard-coded "Round 3 / Market Open" | `GET /api/market/status`: `current_round`, `phase`, `paused` |
| Phase stepper (Preparation → Open → Closing → Settled) | fixed at "Open" | map `phase`: awaiting_open → Preparation, trading → Open, closed/news → Closing, settled → Settled; paused gets its own state |
| Countdown (new; essential) | missing | `deadline` − `server_time` from the status poll |
| "From Organisers" banner | fixed newspaper text | `message` from the status poll; hidden when empty |
| Your Holdings table, row click to trade | `INITIAL_HOLDINGS` | `holdings` from `/api/portfolio` |
| Recent Activity, "View All Transactions" | `INITIAL_ACTIVITIES` | `GET /api/transactions`. Shows executed, rejected (with reason), and "Correction by organisers" (with reason). |
| **Markets** table, search, sector filter | `INITIAL_COMPANIES` | `GET /api/companies`. Sector = `industry`; the filter options come from the data. Badge colour is derived from the industry. |
| CEO column | mock names | **Decision A**: add a `ceo` field to the config/companies, or replace the column with the description |
| Change % | mock | `change` from the price board (previous official price vs current) |
| **Trading**: company list, search | mock | same `GET /api/companies` |
| Place Order: price, owned, available cash | mock | price board + `held` + portfolio `cash`. Also show "shares left on exchange" and "max per order" from the board. |
| Quantity box, ± buttons | step 10, unbounded | clamp to 1…`max_order_quantity` |
| Estimated value | qty × price | qty × price + fee (`fee_bps` from status), labelled as an estimate |
| Review Order → confirm modal | client-side check only | Keep the client checks as warnings. **Confirm** sends `POST /api/orders` with a fresh `idempotency_key` created when the modal opens. |
| Order result toast | always "Successfully purchased" | `200`: "Executed at ₹X, fee ₹Y" from the response. `422`: the server's rejection reason. On a network error, retry with the **same key**, then `GET /api/orders/:id`. Disable Confirm while sending. |
| Buttons when the market is closed or paused | always enabled | disabled with the reason, driven by `phase` / `paused` / company `tradable` |
| Recent Orders, "View All Orders" | mock | `GET /api/orders` (latest 300) |
| **News modal** | three invented articles | `GET /api/news/current`: published headlines, plus links to `/api/paper/:round` PDFs |
| Leaderboard | not in the design | **Decision B**: add a small Ranks card using `GET /api/leaderboard` (recommended), or leave it out |

## 4. Admin app: every element and its API

The admin page needs the round lifecycle the backend enforces, in order:

1. publish newspaper
2. open
3. close (automatic at the deadline)
4. publish news
5. preview the update
6. apply the market update

The current design has no way to run steps 1, 4, 5 or 6. The Rounds screen is reshaped around them.

| Screen / element | Today | Connect to / change |
|---|---|---|
| **Admin login screen** (new) | missing | `POST /api/admin/login`; `GET /api/admin/me` on load |
| Logout | `alert` | `POST /api/admin/logout` |
| **Overview**: 4 KPI cards | hard-coded | `GET /api/admin/overview` (teams, logged-in teams, per-round order counts). Traded value and "vs last round" need a small backend addition (section 5). Remove any delta the server can't compute. |
| Round Control: round, status | local state | overview `state` + rounds |
| Pause / Resume | flips a variable | `POST /api/admin/pause {reason}`; `POST /api/admin/resume {extend, reason}`. Ask for the reason in a modal. |
| Close Market | flips a variable | `POST /api/admin/rounds/:id/close` (with a confirm) |
| Edit Round modal (choose any round and any status) | sets local state | **Remove.** The server won't jump rounds or set an arbitrary status, and shouldn't. Replace it with **Extend** (`/extend {seconds, reason}`) and **Reopen** (`/reopen {seconds, reason}`), shown only when valid. |
| Quick Announcement → Publish | adds a fake activity row | `POST /api/admin/message {message}`; also add a "Clear" button. It appears on every player screen within about 2 s. |
| Recent Activity table | mock | `GET /api/admin/audit-log` (admin actions) + `GET /api/admin/system-log`. Order events come from `/api/admin/orders`. |
| Top Participants | mock | `GET /api/admin/teams` (live valuation and rank) |
| **Rounds**: round selector (Round 1–6, with Live/Completed/Upcoming) | `ADMIN_ROUNDS` | `overview.rounds` (10 rounds), status mapped from pending/open/closed/settled |
| Add Round | `alert` | **Remove.** Rounds come from `config/game.json`. |
| Primary action button (new) | missing | "Next step" for the selected round: Publish newspaper → Open → Close → Publish news → Preview → Apply market update. Each step calls its `/rounds/:id/...` endpoint. |
| End Round | `alert` | **Remove**, replaced by the steps above |
| View Round Summary | `alert` | `GET /api/admin/summary`: gainers and losers, most traded, top 5 (for the PPT) |
| **Company Price Update** table (type any new price) | edits local prices | **Reshape.** The backend never accepts a typed price; prices come from the price script plus trading pressure. Show `GET /rounds/:id/preview`: current price, script %, pressure %, resulting new price. The editable cell becomes the **script % for rounds not yet applied** → `PATCH /api/admin/events/SCRIPT-RNN {configuration, reason}`. "Save Changes" saves those edits; a separate **Apply market update** button calls `/apply-market-update`. **Undo** calls `/undo-market-update`. |
| Import from CSV | `alert` | **Decision C**: remove (the import runs from the command line: `scripts/import-moves.js`, recommended), or build an upload endpoint |
| Round History table | four invented rows | audit-log entries for that round |
| View All Events | `alert` | full audit log in a drawer |
| Publish News / Announcement: Market News vs General Announcement | adds a fake activity row | Headlines are prepared in the config. **Market News** becomes "Publish this round's news" → `/rounds/:id/publish-news`, listing the prepared headlines from `GET /api/admin/events`. **General Announcement** → `/api/admin/message`. Free-text news and "Specific Teams" have no backend: **Decision D**. |
| Round Content: Upload newspaper / materials | `alert` | **Decision E**: replace with **Preview newspaper** (`GET /rounds/:id/paper`) and **Publish newspaper** (`/publish-newspaper`); PDFs are placed in `papers/` before the event (recommended). Or build an admin PDF upload. |
| Round Settings: Allow short selling, Company news | local toggles | **Remove.** The game has no short selling. Company news is always shown from the published headlines. |
| Suspend / resume trading in one company (new) | missing | `POST /api/admin/companies/:id/trading {tradable, reason}` |
| **Participants**: KPI cards (237 / ₹15,62,400 / 3 warnings) | hard-coded | computed from `GET /api/admin/teams` |
| Team list, search, sort, pagination | mock, fixed 16 pages | `GET /api/admin/teams`, with search, sort and pagination done in the browser (50–250 teams is small) |
| Status filter Active/Suspended/Warning | mock | **Decision F**: "Logged in / Not logged in" (from `sessions`), plus "Disabled" if we add the deactivate endpoint. "Warning" has no meaning in the backend: remove it. |
| Team drawer: stats, Rank | mock | `GET /api/admin/teams/:id` |
| Sub-tabs Overview / Portfolio / Orders / Transactions | only the underline moves | real content from the same `teams/:id` response: holdings, orders, ledger |
| Team Members, Edit | mock names + `alert` | Members are just the names typed at login. Show the distinct `placed_by` names from the team's orders. Remove Edit. |
| Adjust Cash | changes a local number | modal → `POST /teams/:id/adjust-cash {amount (paise, ±), reason}`. The projected balance comes from real cash. A debit larger than cash shows the server's refusal. |
| Adjust Holdings | toast only | new modal → `POST /teams/:id/adjust-holdings {company_id, delta, reason}` |
| Reset Password | "link sent" alert | `POST /teams/:id/reset-password {reason}` → show the new password once in a modal. Warn that it logs out every device of that team. |
| Send Message (per team) | toast only | **Decision G**: remove (only a broadcast message exists, recommended), or build per-team messages |
| Reward (new) | missing | `POST /api/admin/rewards {team_ids, quest, amount, reason}` (quiz prizes) |
| Reverse Transaction (team drawer) | `alert` | opens that team's executed orders, each with **Reverse** → `POST /api/admin/orders/:id/reverse {reason}` |
| **Orders**: KPI cards | hard-coded | counts from `GET /api/admin/orders?round=N` |
| Filters type/status/company/round | fixed options | Status options become Executed / Rejected / Reversed (Pending and Cancelled don't exist). Company and round options come from the data. Search covers team, ticker and order ID. |
| Orders table, pagination | mock, 96 fixed pages | `GET /api/admin/orders?status=&round=&limit=`; paginate in the browser |
| Order Details card | mock | the selected row: placed by, time, price, fee, cash, rejection reason, reversal reason |
| Reverse Order | marks "Cancelled" locally | `POST /api/admin/orders/:id/reverse {reason}` → refetch. Show the server's refusal text (for example "shares already sold"). Warn if the order's round is already settled. |
| Order Statistics | hard-coded 712/716, ₹12,860 | computed from the fetched orders |
| Likely double taps (new) | missing | `GET /api/admin/orders/suspected-duplicates` with a Reverse button |
| Export CSV | `alert` | generated in the browser from the fetched rows (real data) |
| **Transactions** (all ledger entries, all teams) | mock | **needs a new endpoint**: `GET /api/admin/ledger` (section 5). Type filter options are the real types: Buy, Sell, Correction (reversal), Adjustment, Reward, Initial deposit (plus Loan types if loans are on). Fee is part of each trade, not a separate entry. Dividend and Penalty don't exist; remove them. |
| Reverse Transaction | deletes the row locally | **Remove** for non-trade entries (the ledger is append-only by design; a mistake is fixed with an opposite Adjust Cash). For trade entries, link to Reverse Order. |
| Team Balance History chart | fixed SVG curve | **needs a new endpoint**: net worth per settled round from the leaderboard snapshots, drawn from data |
| **Missing admin functions** (backend has them, design doesn't) | — | Start event, End event, Integrity check (`/integrity`), System health. **Decision H**: add a small "Event" section to Overview (recommended). Without Start/End there is no way to run the game. |

## 5. Backend additions this needs

All are small. They come with tests, and every change appends to the audit log.

1. `GET /api/admin/ledger?team=&type=&round=&limit=&before=`: all-team ledger, paginated (Transactions screen).
2. `GET /api/admin/teams/:id/history`: net worth after each settled round (balance chart).
3. Extend `GET /api/admin/overview` with per-round `traded_value` and `orders` so the KPI deltas are real.
4. Only if chosen:
   - (A) a `ceo` field;
   - (F) `POST /api/admin/teams/:id/active {active, reason}` to disable a team;
   - (G) per-team messages;
   - (C/E) admin uploads for the price CSV and newspaper PDFs.

## 6. Proving nothing is fake

1. **No mocks remain.** `src/data/` is deleted, and the `check:nomock` grep gate runs on every build.
2. **Every button calls the network.** A Puppeteer script (already a dependency of the frontend) logs in as admin and as a team. It clicks every interactive element listed in sections 3–4 and records the network requests. Then:
   - each mutating button must hit its listed endpoint;
   - after each action, the script re-reads the state through the API and checks the change, for example: cash moved by exactly the adjustment, an order row exists, the round status changed, a reversal is recorded;
   - any button that makes no request and isn't pure navigation fails the test.
3. **Two-screen check.** The admin pauses, sends a message, opens and closes a round; a separate player browser must show each change within 3 s. Repeated with 50 player browsers (`browsers.js`).
4. **Refresh test.** Reload every page mid-game: all numbers stay the same (proves they come from the server, not memory).
5. **Server is the source of truth.** For each team, the player dashboard's numbers equal `GET /api/admin/teams/:id`. `GET /api/admin/integrity` stays clean after the whole run.
6. **Regression.** `npm test`, the 67-check stress suite and the 50-laptop suite are re-run against the built frontend; real-browser trading is re-run through the new UI.
7. **Phone widths.** Players use phones too. Every player screen is checked at 375 px. The design's tables need a stacked mobile layout for Holdings and Markets.

## 7. Order of work

1. **Setup.** Copy into `frontend/`, set up git, multi-page Vite, dev proxy, API client and types, delete mocks, money helpers.
2. **Player app.** Login, shell (status poll, countdown, banner, offline), Dashboard, Markets, Trading + confirm, News, History, Logout.
3. **Backend additions** (section 5) with tests.
4. **Admin app.** Login, Overview (including event start/end), Rounds lifecycle, Participants, Orders, Transactions.
5. **Verification** (section 6), fixes, then remove the legacy UIs.

## 8. Decisions needed

| | Question | Recommendation |
|---|---|---|
| A | CEO column: add real CEO names, or show the description? | Add a `ceo` field if the story has CEOs; otherwise drop the column |
| B | Add a small leaderboard to the player app? | Yes (the API already exists) |
| C | Price-script CSV import in the admin page? | No; keep it on the command line before the event |
| D | Free-text news and "Specific Teams" publishing? | No; prepared headlines + broadcast message |
| E | Newspaper upload from the admin page? | No; put the PDFs in `papers/`, with preview and publish in the admin page |
| F | Team status filter: add "Disable team"? | Yes, one small endpoint, useful for cheating |
| G | Per-team messages? | No |
| H | Event start/end and health in Overview? | Yes (required to run the game) |
