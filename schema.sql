CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','worker')),
  daily_wage DECIMAL(12,2) NOT NULL DEFAULT 0,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The bottle "types" (e.g. sizes) you order
CREATE TABLE IF NOT EXISTS bottle_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  active SMALLINT NOT NULL DEFAULT 1,
  bottles_per_pet INTEGER NOT NULL DEFAULT 6,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The quality grades that apply to each type
CREATE TABLE IF NOT EXISTS bottle_qualities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every type x quality combination is a "variant" - the actual thing you count stock of
CREATE TABLE IF NOT EXISTS bottle_variants (
  id SERIAL PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES bottle_types(id),
  quality_id INTEGER NOT NULL REFERENCES bottle_qualities(id),
  active SMALLINT NOT NULL DEFAULT 1,
  UNIQUE (type_id, quality_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date DATE NOT NULL,
  present SMALLINT NOT NULL DEFAULT 1,
  bottles_filled INTEGER NOT NULL DEFAULT 0,
  wage_mode VARCHAR(20) NOT NULL,
  wage_rate DECIMAL(12,2) NOT NULL,
  wage_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by VARCHAR(20) NOT NULL DEFAULT 'worker',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, date)
);

-- Per-variant breakdown of bottles filled for one attendance entry
CREATE TABLE IF NOT EXISTS production (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES bottle_variants(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  UNIQUE (attendance_id, variant_id)
);

CREATE TABLE IF NOT EXISTS empty_bottle_purchases (
  id SERIAL PRIMARY KEY,
  variant_id INTEGER REFERENCES bottle_variants(id),
  date DATE NOT NULL,
  quantity INTEGER NOT NULL,
  cost_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  supplier VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Regular customers. Their balance owed is never stored - it is always worked out
-- from opening_balance + what was billed on deliveries - what was paid.
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address VARCHAR(255),
  notes TEXT,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Money received from a customer separately from a delivery (e.g. paying off an old balance later)
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- customer_id is empty for one-time customers.
-- previous_balance is a snapshot of what the customer owed just before this delivery, so the printed invoice never changes later.
-- amount_paid is what the customer paid at the time of this delivery.
CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  destination VARCHAR(255),
  bottles_count INTEGER NOT NULL DEFAULT 0,
  price_per_bottle DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  petrol_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  invoice_number VARCHAR(50),
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  previous_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-variant line items of one delivery.
-- quantity is always in bottles - the true stock/record unit.
-- crates/price_per_crate are filled in only when this row was entered as
-- crates ("pets" of 6 or 12 bottles), purely so the invoice can show it the way it
-- was agreed with the customer - quantity and subtotal are unaffected either way.
CREATE TABLE IF NOT EXISTS delivery_items (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES bottle_variants(id),
  quantity INTEGER NOT NULL,
  price_per_bottle DECIMAL(12,2) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  crates INTEGER,
  price_per_crate DECIMAL(12,2)
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  category VARCHAR(30) NOT NULL CHECK (category IN ('bottles_purchase','materials_purchase','petrol','maintenance','electricity','other')),
  amount DECIMAL(12,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Manual corrections to bottle stock, per type/quality. This is how you enter the stock you
-- already had before you started using the system (opening stock), or fix a count after a
-- physical stock-take. quantity is signed: + adds to stock, - removes from stock.
-- kind says which pile it applies to: 'empty' (empty bottles) or 'filled' (filled, ready to deliver).
-- These never touch expenses or revenue - they only move the stock numbers.
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  variant_id INTEGER NOT NULL REFERENCES bottle_variants(id),
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('empty','filled')),
  quantity INTEGER NOT NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Raw materials that are not bottles: PET sheets and labels (bought by weight, unit 'kg'),
-- bottle caps (bought by count, unit 'pcs'). low_stock_threshold of 0 means "no warning".
CREATE TABLE IF NOT EXISTS materials (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  unit VARCHAR(10) NOT NULL CHECK (unit IN ('kg','pcs')),
  low_stock_threshold DECIMAL(12,3) NOT NULL DEFAULT 0,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- expense_id links a purchase to the expense row it logged automatically, so deleting the
-- purchase also removes that expense instead of leaving it behind.
CREATE TABLE IF NOT EXISTS material_purchases (
  id SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  date DATE NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  cost_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  supplier VARCHAR(255),
  notes TEXT,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Everything that changes a material's stock other than a purchase. quantity is signed:
-- opening stock is +, used in production / wasted is -, a correction can be either.
CREATE TABLE IF NOT EXISTS material_adjustments (
  id SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  date DATE NOT NULL,
  reason VARCHAR(20) NOT NULL CHECK (reason IN ('opening','used','wasted','correction')),
  quantity DECIMAL(12,3) NOT NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  "key" VARCHAR(100) PRIMARY KEY,
  value TEXT
);
