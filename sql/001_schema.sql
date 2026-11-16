-- Icepops database schema (PostgreSQL 14 or newer).
-- Safe to run more than once: every statement checks whether the object exists.
--
-- Tenancy: a business (the franchise brand or shop owner) has outlets and users.
-- Every sale, item and stock row belongs to one business, and the server
-- filters every query by the logged-in user's business.
-- Money is stored in paise (₹1 = 100 paise) so totals never have rounding errors.

-- ---------- Plans and subscriptions ----------

CREATE TABLE IF NOT EXISTS plans (
  id                  text PRIMARY KEY,                    -- 'lite', 'pro', 'enterprise'
  name                text NOT NULL,
  price_monthly_paise integer NOT NULL CHECK (price_monthly_paise >= 0),
  max_outlets         integer,                             -- NULL means no limit
  max_users           integer,
  max_items           integer,
  features            text[] NOT NULL DEFAULT '{}',
  razorpay_plan_id    text,                                -- plan_xxx from the Razorpay dashboard
  self_serve          boolean NOT NULL DEFAULT true,       -- false: "contact sales" instead of a buy button
  sort_order          integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS businesses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  address      text NOT NULL DEFAULT '',
  phone        text NOT NULL DEFAULT '',
  gstin        text NOT NULL DEFAULT '',
  timezone     text NOT NULL DEFAULT 'Asia/Kolkata',
  next_bill_no integer NOT NULL DEFAULT 1001,              -- bill numbers run across all outlets
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  business_id              uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id                  text NOT NULL REFERENCES plans(id),
  pending_plan_id          text REFERENCES plans(id),        -- plan being paid for at checkout
  status                   text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at            timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  provider                 text NOT NULL DEFAULT 'none' CHECK (provider IN ('none', 'test', 'razorpay')),
  provider_subscription_id text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_provider_id_idx ON subscriptions (provider_subscription_id);

CREATE TABLE IF NOT EXISTS payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id                  text REFERENCES plans(id),
  amount_paise             integer NOT NULL,
  status                   text NOT NULL,                  -- 'paid', 'test', 'failed'
  provider                 text NOT NULL,
  provider_payment_id      text,
  provider_subscription_id text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
-- Razorpay can send the same webhook twice; this stops a payment being recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_payment_key ON payments (provider, provider_payment_id);
CREATE INDEX IF NOT EXISTS payments_business_idx ON payments (business_id, created_at);

-- ---------- Outlets, users and logins ----------

CREATE TABLE IF NOT EXISTS outlets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  address     text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outlets_business_idx ON outlets (business_id);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outlet_id     uuid REFERENCES outlets(id) ON DELETE SET NULL,   -- the outlet a cashier works at
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  email         text NOT NULL,
  password_hash text NOT NULL,                                     -- scrypt, never the password itself
  role          text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_business_idx ON users (business_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,                                     -- SHA-256 of the cookie value
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outlet_id  uuid REFERENCES outlets(id) ON DELETE SET NULL,       -- outlet chosen in the switcher
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ---------- Menu and stock ----------

CREATE TABLE IF NOT EXISTS items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  price_paise integer NOT NULL CHECK (price_paise > 0),
  colour_a    text NOT NULL DEFAULT '#F2C230',
  colour_b    text NOT NULL DEFAULT '#F2C230',
  active      boolean NOT NULL DEFAULT true,                       -- false: off the menu, kept for past bills
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS items_active_name_key ON items (business_id, lower(name)) WHERE active;

CREATE TABLE IF NOT EXISTS outlet_stock (
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  item_id   uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  stock     integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  PRIMARY KEY (outlet_id, item_id)
);

CREATE TABLE IF NOT EXISTS stock_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outlet_id   uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_name   text NOT NULL,
  change      integer NOT NULL,
  reason      text NOT NULL,
  stock_after integer NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_log_outlet_idx ON stock_log (outlet_id, created_at);

-- ---------- Sales ----------

CREATE TABLE IF NOT EXISTS bills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outlet_id      uuid NOT NULL REFERENCES outlets(id),
  bill_no        integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  customer_name  text NOT NULL DEFAULT '',
  customer_phone text NOT NULL DEFAULT '',                         -- 10 digits, no +91
  payment_method text NOT NULL CHECK (payment_method IN ('Cash', 'UPI', 'Card')),
  qty            integer NOT NULL CHECK (qty > 0),
  total_paise    integer NOT NULL CHECK (total_paise >= 0),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (business_id, bill_no)
);
CREATE INDEX IF NOT EXISTS bills_business_time_idx ON bills (business_id, created_at);
CREATE INDEX IF NOT EXISTS bills_outlet_time_idx ON bills (outlet_id, created_at);

CREATE TABLE IF NOT EXISTS bill_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  item_id          uuid NOT NULL REFERENCES items(id),
  item_name        text NOT NULL,                                  -- name at the time of sale
  qty              integer NOT NULL CHECK (qty > 0),
  unit_price_paise integer NOT NULL CHECK (unit_price_paise >= 0),
  line_total_paise integer NOT NULL CHECK (line_total_paise >= 0)
);
CREATE INDEX IF NOT EXISTS bill_items_bill_idx ON bill_items (bill_id);
