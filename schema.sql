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
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-variant line items of one delivery
CREATE TABLE IF NOT EXISTS delivery_items (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES bottle_variants(id),
  quantity INTEGER NOT NULL,
  price_per_bottle DECIMAL(12,2) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  category VARCHAR(30) NOT NULL CHECK (category IN ('bottles_purchase','petrol','maintenance','electricity','other')),
  amount DECIMAL(12,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  "key" VARCHAR(100) PRIMARY KEY,
  value TEXT
);
