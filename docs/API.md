# MarketVerse HTTP API

Two interfaces use this API: the **player app** (`/`) and the **admin page** (`/admin/`). There is no
public or projector API: apart from logging in and the four market/news reads marked *open*, every
endpoint needs a login.

**Conventions**
- **Request bodies.** All `POST`/`PATCH` bodies are JSON (`Content-Type: application/json`); anything
  else gets `415`. Bodies are capped at 32 KB.
- **Sessions.** Logins set an HttpOnly, SameSite=Strict cookie: `mv_team` for players, `mv_admin` for
  admins. A team cookie never works on admin endpoints, and the reverse is also true.
- **Money and percentages.** Money is integer **paise** (₹1 = 100). Percentages are integer **basis
  points** (100 = 1%).
- **Errors.** An error is `{ "error": "message", "code": "..." }`.
  - `400` invalid input
  - `401` not logged in
  - `404` not found
  - `409` not allowed in the current state
  - `422` order rejected (the order is still recorded with its reason)
  - `429` too fast
  - `503` busy or database unavailable; nothing was saved, so it is safe to retry
- Every admin write needs a `reason` where noted, and lands in the audit log.

## Server

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | open | `{ ok, time }`; 503 if the database is unreachable. For uptime checks. |

## Player app

### Login
| Method | Path | Auth | Body / query | Purpose |
|---|---|---|---|---|
| POST | `/api/auth/login` | open | `{ team_id, password, member_name? }` | Log in. Team ID is case/space-insensitive. 20 wrong passwords in a minute pause new logins for that ID for 15 s; existing sessions are unaffected. |
| POST | `/api/auth/logout` | team | `{}` | End this device's session. |
| GET | `/api/me` | team | | `{ team: { id, name, access_identifier }, member_name }` |

### Market (open; no team data)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/market/status` | Event status, phase (`trading`, `closed`, …), current round, deadline, server time (for the countdown), paused flag, organiser message, settings teams need (fee, limits, Margin Bank on/off, `leaderboard_visible`). |
| GET | `/api/market/prices` | Every company: price, previous price, change, CEO, description, `details` (extra facts), exchange inventory, max order size, tradable/suspended. |
| GET | `/api/market/history` | Official price of every company after every settled round. |
| GET | `/api/news/current` | Published newspapers and news-segment headlines only. |

### Team
| Method | Path | Body / query | Purpose |
|---|---|---|---|
| GET | `/api/portfolio` (alias `/api/team`) | | Cash, holdings with value and P&L, debt, net worth, rank, trades this round. |
| GET | `/api/companies` | | Price board plus this team's holding in each company. |
| GET | `/api/companies/:id` | | One company: details, price history, this team's holding and trades in it, related news. |
| GET | `/api/paper/:round` | | That round's newspaper PDF, once published. |
| GET | `/api/leaderboard` | | Published leaderboard (net worth, P&L; never holdings) and this team's row. **404** when `settings.players_see_leaderboard` is false (this event's setting). |
| GET | `/api/transactions` | | Orders (executed, rejected, and reversed by organisers, with reason), bank sales, corrections, other cash movements. |

### Trading
| Method | Path | Body / query | Purpose |
|---|---|---|---|
| POST | `/api/orders` | `{ company_id, side: "buy"\|"sell", quantity, idempotency_key }` | Place an order. Executes immediately and in full at the round's official price, or is rejected with a reason (`422`). The same `idempotency_key` (8–100 chars `A-Z a-z 0-9 _ -`) always returns the same order, so retries never double-execute. Limited to 10 orders/s per team (bursts of 30). |
| GET | `/api/orders` | | This team's latest 300 orders. |
| GET | `/api/orders/:id` | | One order (use after a network failure to see whether it went through). |

### Margin Bank (only when enabled in settings)
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/loans` | | Rules, collateral value, available to borrow, loans. |
| POST | `/api/loans` | `{ amount, collateral: [{ company_id, quantity }], request_key }` | Borrow against pledged shares. `request_key` makes retries safe. |
| POST | `/api/loans/:id/repay` | `{}` | Repay principal + interest in full; releases the collateral. |

## Admin page

### Session and overview
| Method | Path | Body / query | Purpose |
|---|---|---|---|
| POST | `/api/admin/login` | `{ username, password }` | Admin login. |
| POST | `/api/admin/logout` | `{}` | |
| GET | `/api/admin/me` | | Current admin. |
| GET | `/api/admin/overview` | | Everything the Overview shows: state, all rounds with counts (executed, rejected, teams that traded, `traded_value`, shares bought/sold), team and company counts (incl. disabled teams, tradable companies), logged-in teams, DB latency, connection pool, recent audit entries and errors. |

### Event and round control
| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/admin/event/start` | `{}` | Start the event (company configuration freezes). |
| POST | `/api/admin/rounds/:id/publish-newspaper` | `{}` | Release that round's newspaper early (opening the round also does it). |
| POST | `/api/admin/rounds/:id/open` | `{}` | Open trading; the deadline is now + the round's duration. |
| POST | `/api/admin/rounds/:id/extend` | `{ seconds, reason }` | Extend the open round (1–3600 s). |
| POST | `/api/admin/rounds/:id/close` | `{}` | Close trading now (also happens automatically at the deadline). |
| POST | `/api/admin/rounds/:id/reopen` | `{ seconds, reason }` | Undo an accidental close. Only before the news segment is published. |
| POST | `/api/admin/rounds/:id/publish-news` | `{}` | Make the round's headlines visible in the players' News tab. |
| GET | `/api/admin/rounds/:id/preview` | | The exact prices the market update would set now, with the breakdown (script, trading pressure, noise). |
| POST | `/api/admin/rounds/:id/apply-market-update` | `{}` | Set the new prices, charge loan interest, liquidate due loans, snapshot the leaderboard. Applying twice is harmless. |
| POST | `/api/admin/rounds/:id/undo-market-update` | `{ reason }` | Undo the latest update (e.g. a typo in the script). Only before the next round opens, and not if loans were charged. |
| POST | `/api/admin/pause` | `{ reason }` | Stop all trading immediately. |
| POST | `/api/admin/resume` | `{ extend: true\|false, reason? }` | Resume; `extend` adds the paused time to the deadline. |
| POST | `/api/admin/message` | `{ message }` | Banner on every player's screen (empty string clears it). |
| POST | `/api/admin/event/end` | `{}` | After Round 10: liquidate outstanding loans and freeze the final rankings. |
| GET | `/api/admin/rounds/:id/paper` | | Preview a newspaper PDF before it is published. |
| GET | `/api/admin/summary` | | For the presentation slides: prices and changes, top 5 gainers and losers, most traded, top 5 teams, this round's headlines, and final results after the event. |

### Price plan (confidential)
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/admin/events` | | The price script (`SCRIPT-R01` … `R10`), other scheduled events, and all headlines. |
| PATCH | `/api/admin/events/:id` | `{ configuration: { companies: { TICKER: bps }, industries: { Name: bps } }, reason }` | Correct a not-yet-applied round's moves. Reason required once the event has started. |

### Companies
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/admin/companies` | | All companies with price, inventory, shares held by teams, limits. |
| PATCH | `/api/admin/companies/:id` | `{ field: value, reason }` | Before the start: name, industry, description, `ceo`, `details` (`{ "Label": "text" }`, ≤ 20), max order size, pressure reference, loan eligibility. After the start (reason required): description, `ceo`, `details`, max order size. |
| POST | `/api/admin/companies/:id/trading` | `{ tradable: true\|false, reason }` | Suspend or resume trading in one company (teams see the reason). |

### Teams and corrections
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/admin/teams` | | Every team (including disabled ones, `rank: null`): live valuation, rank, `total_pnl`, `is_active`, member names used on its orders, executed order count, devices logged in. |
| GET | `/api/admin/teams/:id` | | One team: portfolio, every order, full cash ledger, loans. |
| GET | `/api/admin/teams/:id/history` | | Net worth, cash and holdings value after each settled round (round 0 = start), plus now. |
| POST | `/api/admin/teams/:id/active` | `{ active: true\|false, reason }` | Disable a team: logs out all its devices at once, blocks login and orders, leaves it out of rankings. Enable restores it; holdings and history are untouched. |
| POST | `/api/admin/teams/:id/reset-password` | `{ reason }` | New random password (returned once); logs out all that team's devices. |
| POST | `/api/admin/orders/:id/reverse` | `{ reason }` | Undo a mistaken trade exactly (shares, cash incl. fee, profit, price pressure). Refused if the shares or cash have since been used. |
| POST | `/api/admin/teams/:id/adjust-cash` | `{ amount (paise, ±), reason }` | Cash correction, ledgered. |
| POST | `/api/admin/teams/:id/adjust-holdings` | `{ company_id, delta (±shares), reason }` | Shares correction, to or from the exchange. |
| POST | `/api/admin/rewards` | `{ team_ids: [..], quest, amount (paise), reason }` | Quest/quiz reward; once per team per quest; capped. |

### Inspection and health
| Method | Path | Query | Purpose |
|---|---|---|---|
| GET | `/api/admin/orders` | `?status=executed\|rejected&round=N&limit=1..20000` | All orders (latest first), with reversal status. |
| GET | `/api/admin/orders/suspected-duplicates` | | Same team/company/side/size within 15 s under different keys: likely double taps. |
| GET | `/api/admin/ledger` | `?team=ID&type=trade_buy\|trade_sell\|trade_reversal\|adjustment\|quest_reward\|initial_deposit\|…&round=N&before=ENTRY_ID&limit=1..5000` | Every cash movement of every team, newest first, with the trade's round, ticker, side, quantity, price, fee and order id where there is one; `totals` per type. Page with `before`. |
| GET | `/api/admin/audit-log` | | Last 500 admin actions with reasons and before/after. |
| GET | `/api/admin/system-log` | | Server events and errors (e.g. password-guessing alerts). |
| GET | `/api/admin/integrity` | | Checks that the books balance; `{ problems: [] }` when healthy. |
