-- Q-FIS MarketVerse schema.
-- All money is stored as BIGINT paise. All percentages are integer basis points (1 bp = 0.01%).
-- Idempotent: safe to run on every startup.

CREATE TABLE IF NOT EXISTS game_state (
  id             INT PRIMARY KEY CHECK (id = 1),
  status         TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'running', 'finished')),
  current_round  INT NOT NULL DEFAULT 0,
  paused         BOOLEAN NOT NULL DEFAULT false,
  paused_at      TIMESTAMPTZ,
  message        TEXT NOT NULL DEFAULT '',
  settings       JSONB NOT NULL,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  access_identifier  TEXT NOT NULL UNIQUE,
  password           TEXT NOT NULL,      -- plain text, lowercase: organisers hand it out and look it up
  cash               BIGINT NOT NULL CHECK (cash >= 0),
  realized_pnl       BIGINT NOT NULL DEFAULT 0,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admins (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('team', 'admin')),
  team_id      INT REFERENCES teams(id),
  admin_id     INT REFERENCES admins(id),
  member_name  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  CHECK ((kind = 'team' AND team_id IS NOT NULL) OR (kind = 'admin' AND admin_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS companies (
  id                  SERIAL PRIMARY KEY,
  ticker              TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  industry            TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  initial_price       BIGINT NOT NULL CHECK (initial_price > 0),
  shares_outstanding  BIGINT NOT NULL CHECK (shares_outstanding > 0),
  float_shares        BIGINT NOT NULL CHECK (float_shares > 0),       -- initial exchange inventory; teams + inventory always equals this
  exchange_inventory  BIGINT NOT NULL CHECK (exchange_inventory >= 0),
  max_order_quantity  BIGINT NOT NULL CHECK (max_order_quantity > 0),
  pressure_ref_qty    BIGINT NOT NULL CHECK (pressure_ref_qty > 0),   -- net demand that produces pressure_scale_bps of price impact
  loan_eligible       BOOLEAN NOT NULL DEFAULT true,
  is_tradable         BOOLEAN NOT NULL DEFAULT true,
  suspension_reason   TEXT,
  CHECK (float_shares <= shares_outstanding),
  CHECK (exchange_inventory <= float_shares)
);

CREATE TABLE IF NOT EXISTS rounds (
  id                      INT PRIMARY KEY CHECK (id >= 1),
  title                   TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed', 'settled')),
  duration_seconds        INT NOT NULL DEFAULT 300 CHECK (duration_seconds > 0),
  newspaper_pdf           TEXT,
  newspaper_published_at  TIMESTAMPTZ,
  bulletin_published_at   TIMESTAMPTZ,
  opened_at               TIMESTAMPTZ,
  trading_deadline        TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  market_update_status    TEXT NOT NULL DEFAULT 'none' CHECK (market_update_status IN ('none', 'done')),
  completed_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS holdings (
  team_id           INT NOT NULL REFERENCES teams(id),
  company_id        INT NOT NULL REFERENCES companies(id),
  quantity          BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  pledged_quantity  BIGINT NOT NULL DEFAULT 0 CHECK (pledged_quantity >= 0),
  cost_basis        BIGINT NOT NULL DEFAULT 0 CHECK (cost_basis >= 0),
  PRIMARY KEY (team_id, company_id),
  CHECK (pledged_quantity <= quantity)
);

CREATE TABLE IF NOT EXISTS orders (
  id                BIGSERIAL PRIMARY KEY,
  team_id           INT NOT NULL REFERENCES teams(id),
  round_id          INT REFERENCES rounds(id),
  company_id        INT REFERENCES companies(id),
  side              TEXT NOT NULL,
  quantity          BIGINT,
  status            TEXT NOT NULL CHECK (status IN ('executed', 'rejected')),
  idempotency_key   TEXT NOT NULL,
  placed_by         TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  executed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  UNIQUE (team_id, idempotency_key),
  CHECK (status = 'rejected' OR (quantity > 0 AND side IN ('buy', 'sell') AND round_id IS NOT NULL AND company_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS orders_round_idx ON orders (round_id, status);

CREATE TABLE IF NOT EXISTS trades (
  id               BIGSERIAL PRIMARY KEY,
  order_id         BIGINT UNIQUE REFERENCES orders(id),
  team_id          INT NOT NULL REFERENCES teams(id),
  round_id         INT NOT NULL REFERENCES rounds(id),
  company_id       INT NOT NULL REFERENCES companies(id),
  side             TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  source           TEXT NOT NULL DEFAULT 'order' CHECK (source IN ('order', 'liquidation', 'reversal')),
  quantity         BIGINT NOT NULL CHECK (quantity > 0),
  execution_price  BIGINT NOT NULL CHECK (execution_price > 0),
  gross            BIGINT NOT NULL,
  fee              BIGINT NOT NULL CHECK (fee >= 0),
  cash_delta       BIGINT NOT NULL,
  cash_after       BIGINT NOT NULL CHECK (cash_after >= 0),
  realized_pnl     BIGINT NOT NULL DEFAULT 0,
  executed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS trades_team_idx ON trades (team_id, id);
CREATE INDEX IF NOT EXISTS trades_round_idx ON trades (round_id, company_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                BIGSERIAL PRIMARY KEY,
  team_id           INT NOT NULL REFERENCES teams(id),
  transaction_type  TEXT NOT NULL CHECK (transaction_type IN
                      ('initial_deposit', 'trade_buy', 'trade_sell', 'loan_disbursement', 'loan_repayment',
                       'liquidation', 'quest_reward', 'adjustment', 'trade_reversal')),
  amount            BIGINT NOT NULL,
  balance_after     BIGINT NOT NULL CHECK (balance_after >= 0),
  reference_type    TEXT,
  reference_id      TEXT,
  memo              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by        TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS ledger_team_idx ON ledger_entries (team_id, id);

-- Team passwords are stored in plain text (the admin password stays hashed). Databases from before
-- that change had them scrypt-hashed in password_hash; those teams can't log in until re-seeded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'password_hash') THEN
    ALTER TABLE teams RENAME COLUMN password_hash TO password;
  END IF;
END $$;

-- Story details shown to players: the CEO and free-form facts ("Founded": "1998", ...).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ceo TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}';

-- One row per company per completed round. round_id 0 = initial listing price.
-- The primary key makes it impossible to apply a market update to the same round twice.
CREATE TABLE IF NOT EXISTS stock_prices (
  company_id       INT NOT NULL REFERENCES companies(id),
  round_id         INT NOT NULL CHECK (round_id >= 0),
  price            BIGINT NOT NULL CHECK (price > 0),
  prev_price       BIGINT,
  fundamental_bps  INT NOT NULL DEFAULT 0,
  trading_bps      INT NOT NULL DEFAULT 0,
  noise_bps        INT NOT NULL DEFAULT 0,
  total_bps        INT NOT NULL DEFAULT 0,
  net_demand       BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, round_id)
);

-- Bulletins: the headlines of the post-trading news segment. Hidden until published.
CREATE TABLE IF NOT EXISTS news_items (
  id            SERIAL PRIMARY KEY,
  round_id      INT NOT NULL REFERENCES rounds(id),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  affected      TEXT NOT NULL DEFAULT '',
  media_url     TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  is_published  BOOLEAN NOT NULL DEFAULT false,
  published_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scheduled_events (
  id                TEXT PRIMARY KEY,
  event_name        TEXT NOT NULL,
  clue_round        INT,
  effective_round   INT NOT NULL REFERENCES rounds(id),
  configuration     JSONB NOT NULL,
  notes             TEXT NOT NULL DEFAULT '',
  is_applied        BOOLEAN NOT NULL DEFAULT false,
  applied_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS loans (
  id            SERIAL PRIMARY KEY,
  team_id       INT NOT NULL REFERENCES teams(id),
  principal     BIGINT NOT NULL CHECK (principal >= 0),
  interest_due  BIGINT NOT NULL DEFAULT 0 CHECK (interest_due >= 0),
  status        TEXT NOT NULL CHECK (status IN ('active', 'repaid', 'liquidated', 'defaulted')),
  issued_round  INT NOT NULL,
  due_round     INT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  repaid_at     TIMESTAMPTZ,
  closing_note  TEXT,
  request_key   TEXT NOT NULL,
  UNIQUE (team_id, request_key)
);

CREATE TABLE IF NOT EXISTS collateral (
  loan_id     INT NOT NULL REFERENCES loans(id),
  team_id     INT NOT NULL REFERENCES teams(id),
  company_id  INT NOT NULL REFERENCES companies(id),
  quantity    BIGINT NOT NULL CHECK (quantity > 0),
  released    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (loan_id, company_id)
);

CREATE TABLE IF NOT EXISTS quest_awards (
  id         SERIAL PRIMARY KEY,
  team_id    INT NOT NULL REFERENCES teams(id),
  quest_key  TEXT NOT NULL,
  amount     BIGINT NOT NULL CHECK (amount > 0),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, quest_key)
);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  round_id        INT NOT NULL,
  team_id         INT NOT NULL REFERENCES teams(id),
  rank            INT NOT NULL,
  net_worth       BIGINT NOT NULL,
  cash            BIGINT NOT NULL,
  holdings_value  BIGINT NOT NULL,
  debt            BIGINT NOT NULL,
  realized_pnl    BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, team_id)
);

CREATE TABLE IF NOT EXISTS final_rankings (
  team_id         INT PRIMARY KEY REFERENCES teams(id),
  rank            INT NOT NULL,
  net_worth       BIGINT NOT NULL,
  cash            BIGINT NOT NULL,
  holdings_value  BIGINT NOT NULL,
  debt            BIGINT NOT NULL,
  realized_pnl    BIGINT NOT NULL,
  tied            BOOLEAN NOT NULL DEFAULT false,
  frozen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  admin_id      INT REFERENCES admins(id),
  action        TEXT NOT NULL,
  reason        TEXT,
  before_state  JSONB,
  after_state   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS system_log (
  id          BIGSERIAL PRIMARY KEY,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- An admin correction that undoes an executed order. The order row itself is never edited; this row
-- marks it reversed and points at the offsetting trade (source 'reversal'). One reversal per order.
CREATE TABLE IF NOT EXISTS order_reversals (
  order_id    BIGINT PRIMARY KEY REFERENCES orders(id),
  trade_id    BIGINT NOT NULL UNIQUE REFERENCES trades(id),
  admin_id    INT REFERENCES admins(id),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Databases created before reversals existed: widen the CHECK constraints in place.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trades_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%reversal%') THEN
    ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_source_check;
    ALTER TABLE trades ADD CONSTRAINT trades_source_check CHECK (source IN ('order', 'liquidation', 'reversal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_transaction_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%trade_reversal%') THEN
    ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_transaction_type_check;
    ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_transaction_type_check CHECK (transaction_type IN
      ('initial_deposit', 'trade_buy', 'trade_sell', 'loan_disbursement', 'loan_repayment',
       'liquidation', 'quest_reward', 'adjustment', 'trade_reversal'));
  END IF;
END $$;

-- Financial history is append-only. Corrections are new entries, never edits.
-- (TRUNCATE, used only by the full reset script, does not fire row triggers.)
-- One exception: undoing a market update (src/market.js undoMarketUpdate) may delete that round's
-- stock_prices rows. It sets mv.undo_round for its own transaction only, and records the deleted
-- prices in the audit log.
CREATE OR REPLACE FUNCTION mv_forbid_mutation() RETURNS trigger AS $$
BEGIN
  -- Nested IF: PL/pgSQL does not short-circuit AND, and other tables have no round_id.
  IF TG_TABLE_NAME = 'stock_prices' AND TG_OP = 'DELETE' THEN
    IF OLD.round_id::TEXT = current_setting('mv.undo_round', true) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['trades', 'ledger_entries', 'admin_audit_log', 'stock_prices'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_append_only') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mv_forbid_mutation()',
                     t || '_append_only', t);
    END IF;
  END LOOP;
END $$;

-- Order execution, entirely inside the database: one round trip per order, and row locks held for
-- microseconds rather than across network round trips. This keeps a deadline burst on one popular
-- stock fast even when the database is tens of milliseconds away from the app server.
-- Rules and messages mirror src/trading.js's documentation; JS validates the idempotency key and
-- passes NULL for values that are not integers.
-- Lock order: market gate (shared) → team → company → holding. Admin transitions take the gate
-- exclusively, so an order never straddles a pause, close or market update.
CREATE OR REPLACE FUNCTION mv_place_order(p_team INT, p_key TEXT, p_company INT, p_side TEXT, p_qty BIGINT, p_placed_by TEXT)
RETURNS TABLE (order_id BIGINT, duplicate BOOLEAN) AS $$
DECLARE
  gs        game_state%ROWTYPE;
  rnd       rounds%ROWTYPE;
  co        companies%ROWTYPE;
  h         holdings%ROWTYPE;
  v_cash    BIGINT;
  v_price   BIGINT;
  v_gross   BIGINT;
  v_fee     BIGINT;
  v_delta   BIGINT;
  v_basis   BIGINT := 0;
  v_real    BIGINT := 0;
  v_free    BIGINT;
  v_limit   INT;
  v_n       INT;
  v_order   BIGINT;
  v_after   BIGINT;
  v_reason  TEXT;
  v_active  BOOLEAN;
BEGIN
  SELECT o.id INTO v_order FROM orders o WHERE o.team_id = p_team AND o.idempotency_key = p_key;
  IF FOUND THEN RETURN QUERY SELECT v_order, true; RETURN; END IF;

  PERFORM pg_advisory_xact_lock_shared(7310001);
  -- Each statement in a volatile function takes a fresh snapshot, so these see any transition
  -- that committed while we waited for the gate.
  SELECT * INTO gs FROM game_state WHERE id = 1;
  SELECT cash, is_active INTO v_cash, v_active FROM teams WHERE id = p_team FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown team %', p_team; END IF;
  -- A concurrent request with the same key may have committed while we waited for the team lock.
  SELECT o.id INTO v_order FROM orders o WHERE o.team_id = p_team AND o.idempotency_key = p_key;
  IF FOUND THEN RETURN QUERY SELECT v_order, true; RETURN; END IF;

  SELECT * INTO rnd FROM rounds WHERE id = gs.current_round;
  IF NOT v_active THEN v_reason := 'This team has been disabled by the organisers';
  ELSIF gs.status <> 'running' THEN v_reason := 'The market is not running';
  ELSIF gs.paused THEN v_reason := 'Trading is paused by the organisers';
  ELSIF rnd.id IS NULL OR rnd.status <> 'open' THEN v_reason := 'The trading window is closed';
  ELSIF clock_timestamp() >= rnd.trading_deadline THEN v_reason := 'The trading deadline has passed';
  ELSIF p_side IS NULL OR p_side NOT IN ('buy', 'sell') THEN v_reason := 'Side must be buy or sell';
  ELSIF p_qty IS NULL OR p_qty <= 0 THEN v_reason := 'Quantity must be a positive whole number';
  END IF;

  IF v_reason IS NULL THEN
    SELECT * INTO co FROM companies WHERE id = p_company FOR NO KEY UPDATE;
    IF co.id IS NULL THEN v_reason := 'Unknown company';
    ELSIF NOT co.is_tradable THEN v_reason := co.ticker || ' is suspended' || COALESCE(': ' || co.suspension_reason, '');
    ELSIF p_qty > co.max_order_quantity THEN v_reason := format('Maximum order size for %s is %s shares', co.ticker, co.max_order_quantity);
    END IF;
  END IF;

  v_limit := COALESCE((gs.settings->>'max_trades_per_round')::INT, 0);
  IF v_reason IS NULL AND v_limit > 0 THEN
    SELECT COUNT(*) INTO v_n FROM orders WHERE team_id = p_team AND round_id = rnd.id AND status = 'executed';
    IF v_n >= v_limit THEN v_reason := format('Limit of %s trades per round reached', v_limit); END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT price INTO v_price FROM stock_prices WHERE company_id = co.id AND round_id = rnd.id - 1;
    IF v_price IS NULL THEN RAISE EXCEPTION 'no official price for % before round %', co.ticker, rnd.id; END IF;
    v_gross := v_price * p_qty;
    v_fee := (v_gross * (gs.settings->>'fee_bps')::BIGINT + 9999) / 10000;   -- fees round up
    IF p_side = 'buy' THEN
      v_delta := -(v_gross + v_fee);
      IF v_cash + v_delta < 0 THEN
        v_reason := format('Insufficient cash: need ₹%s, have ₹%s',
          to_char((v_gross + v_fee) / 100.0, 'FM9999999999999990.00'), to_char(v_cash / 100.0, 'FM9999999999999990.00'));
      ELSIF co.exchange_inventory < p_qty THEN
        v_reason := format('Only %s %s shares left on the exchange', co.exchange_inventory, co.ticker);
      END IF;
    ELSE
      SELECT * INTO h FROM holdings WHERE team_id = p_team AND company_id = co.id FOR NO KEY UPDATE;
      v_free := COALESCE(h.quantity - h.pledged_quantity, 0);
      IF v_free < p_qty THEN
        v_reason := format('You can sell at most %s %s shares', v_free, co.ticker)
          || CASE WHEN COALESCE(h.pledged_quantity, 0) > 0 THEN format(' (%s are pledged as loan collateral)', h.pledged_quantity) ELSE '' END;
      ELSE
        v_delta := v_gross - v_fee;
        v_basis := round(h.cost_basis::NUMERIC * p_qty / h.quantity);   -- half away from zero
        v_real := v_delta - v_basis;
      END IF;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO orders (team_id, round_id, company_id, side, quantity, status, idempotency_key, placed_by, rejection_reason)
    VALUES (p_team, NULLIF(gs.current_round, 0), (SELECT id FROM companies WHERE id = p_company), left(COALESCE(p_side, ''), 10),
            p_qty, 'rejected', p_key, p_placed_by, v_reason)
    RETURNING id INTO v_order;
    RETURN QUERY SELECT v_order, false;
    RETURN;
  END IF;

  IF p_side = 'buy' THEN
    INSERT INTO holdings (team_id, company_id, quantity, cost_basis) VALUES (p_team, co.id, p_qty, v_gross + v_fee)
    ON CONFLICT (team_id, company_id) DO UPDATE SET quantity = holdings.quantity + EXCLUDED.quantity,
                                                    cost_basis = holdings.cost_basis + EXCLUDED.cost_basis;
    UPDATE companies SET exchange_inventory = exchange_inventory - p_qty WHERE id = co.id;
  ELSE
    UPDATE holdings SET quantity = quantity - p_qty, cost_basis = cost_basis - v_basis WHERE team_id = p_team AND company_id = co.id;
    UPDATE companies SET exchange_inventory = exchange_inventory + p_qty WHERE id = co.id;
  END IF;

  INSERT INTO orders (team_id, round_id, company_id, side, quantity, status, idempotency_key, placed_by, executed_at)
  VALUES (p_team, rnd.id, co.id, p_side, p_qty, 'executed', p_key, p_placed_by, clock_timestamp())
  RETURNING id INTO v_order;
  UPDATE teams SET cash = cash + v_delta, realized_pnl = realized_pnl + v_real WHERE id = p_team RETURNING cash INTO v_after;
  INSERT INTO ledger_entries (team_id, transaction_type, amount, balance_after, reference_type, reference_id, memo, created_by)
  VALUES (p_team, CASE p_side WHEN 'buy' THEN 'trade_buy' ELSE 'trade_sell' END, v_delta, v_after, 'order', v_order::TEXT,
          format('%s %s %s @ %s', upper(p_side), p_qty, co.ticker, v_price),
          CASE WHEN p_placed_by IS NULL THEN 'team' ELSE 'team:' || p_placed_by END);
  INSERT INTO trades (order_id, team_id, round_id, company_id, side, quantity, execution_price, gross, fee, cash_delta, cash_after, realized_pnl)
  VALUES (v_order, p_team, rnd.id, co.id, p_side, p_qty, v_price, v_gross, v_fee, v_delta, v_after, v_real);
  RETURN QUERY SELECT v_order, false;
END;
$$ LANGUAGE plpgsql;

-- Same as mv_place_order, plus the resulting order (with its trade, if any) as JSON, so the app
-- needs no second round trip. Read inside the function: an outer join would use the calling
-- statement's snapshot and not see the rows just inserted.
CREATE OR REPLACE FUNCTION mv_place_order_json(p_team INT, p_key TEXT, p_company INT, p_side TEXT, p_qty BIGINT, p_placed_by TEXT)
RETURNS TABLE (duplicate BOOLEAN, ord JSON) AS $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM mv_place_order(p_team, p_key, p_company, p_side, p_qty, p_placed_by);
  RETURN QUERY SELECT r.duplicate, (SELECT row_to_json(x) FROM (
    SELECT o.*, t.execution_price, t.gross, t.fee, t.cash_delta, t.cash_after, t.id AS trade_id
      FROM orders o LEFT JOIN trades t ON t.order_id = o.id WHERE o.id = r.order_id) x);
END;
$$ LANGUAGE plpgsql;

-- Supabase publishes every table and function in the public schema through its Data API (REST and
-- GraphQL) to anyone holding the project's anon key, which is public by design. This app only talks
-- to the database directly, so shut that door: row level security on with no policies (the app's
-- role owns the tables and is not subject to it), and no privileges for the API roles. Without
-- this, anyone could read password hashes and session tokens or call mv_place_order for any team.
-- Each step runs only if still needed, so restarts take no table locks. No-op on plain PostgreSQL.
DO $$
DECLARE r RECORD;
BEGIN
  IF (SELECT COUNT(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) < 2 THEN RETURN; END IF;
  FOR r IN SELECT c.oid::regclass AS rel, c.relkind, c.relrowsecurity FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S') AND pg_has_role(c.relowner, 'USAGE') LOOP
    -- Nested IFs: SQL does not short-circuit AND, and has_sequence_privilege rejects tables.
    IF r.relkind = 'r' THEN
      IF NOT r.relrowsecurity THEN
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.rel);
      END IF;
      IF has_table_privilege('anon', r.rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_table_privilege('authenticated', r.rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM anon, authenticated', r.rel);
      END IF;
    ELSIF has_sequence_privilege('anon', r.rel, 'USAGE,SELECT,UPDATE') OR has_sequence_privilege('authenticated', r.rel, 'USAGE,SELECT,UPDATE') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon, authenticated', r.rel);
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND pg_has_role(p.proowner, 'USAGE')
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
  END LOOP;
END $$;
