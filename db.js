const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  ssl: process.env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    // ─── Core tables ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin      BOOLEAN DEFAULT FALSE,
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        key          VARCHAR(255) UNIQUE NOT NULL,
        label        VARCHAR(255) DEFAULT 'My API Key',
        is_active    BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS settings (
        key        VARCHAR(255) PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ─── Additive columns on users (safe if already exist) ───────────────────
    for (const col of [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type  VARCHAR(20) DEFAULT 'personal'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id    INTEGER`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(200)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_usd   DECIMAL(10,4) DEFAULT 0`,
    ]) { await client.query(col); }

    // ─── Company accounts ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id             SERIAL PRIMARY KEY,
        name           VARCHAR(200) NOT NULL,
        owner_id       INTEGER NOT NULL REFERENCES users(id),
        credits_usd    DECIMAL(10,4) NOT NULL DEFAULT 0,
        plan           VARCHAR(20) NOT NULL DEFAULT 'free',
        invite_code    VARCHAR(24) UNIQUE NOT NULL,
        hd_wallet_index INTEGER UNIQUE,
        wallet_address VARCHAR(200),
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS credit_transactions (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        amount_usd   DECIMAL(10,4) NOT NULL,
        type         VARCHAR(40) NOT NULL,
        reference_id VARCHAR(200),
        description  TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stripe_topups (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id),
        company_id  INTEGER REFERENCES companies(id),
        amount_usd  DECIMAL(10,4) NOT NULL,
        session_id  VARCHAR(200) UNIQUE NOT NULL,
        status      VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usdc_deposits (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER REFERENCES users(id),
        company_id     INTEGER REFERENCES companies(id),
        amount_usd     DECIMAL(10,4),
        tx_hash        VARCHAR(200),
        wallet_address VARCHAR(200) NOT NULL,
        status         VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ─── Platform config & monitor state tables ───────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_config (
        key        VARCHAR(100) PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS monitor_state (
        key        VARCHAR(100) PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS unmatched_usdc_transfers (
        id              SERIAL PRIMARY KEY,
        tx_hash         VARCHAR(200) UNIQUE NOT NULL,
        from_address    VARCHAR(200) NOT NULL,
        amount_usdc     DECIMAL(18,6) NOT NULL,
        block_number    BIGINT,
        resolved        BOOLEAN DEFAULT FALSE,
        resolution_note TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed platform_config defaults
    for (const [key, value] of [['platform_wallet', ''], ['rpc_url', '']]) {
      await client.query(
        `INSERT INTO platform_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
    await client.query(
      `INSERT INTO monitor_state (key, value) VALUES ('usdc_last_block', '0') ON CONFLICT (key) DO NOTHING`
    );

    // ─── Default settings ─────────────────────────────────────────────────────
    const defaults = [
      ['recording_enabled',          'true'],
      ['screen_share_enabled',       'true'],
      ['blur_enabled',               'true'],
      ['registration_enabled',       'true'],
      ['max_participants_default',   '50'],
      ['meeting_auto_delete_minutes','60'],
      ['stripe_enabled',             'true'],
      ['crypto_enabled',             'true'],
    ];
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    // ─── Seed admin user ──────────────────────────────────────────────────────
    const adminEmail    = process.env.ADMIN_EMAIL    || 'assad.dar@gmail.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Test321!';
    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE email = $1', [adminEmail]
    );

    let adminId;
    if (existing.length === 0) {
      const hash = await bcrypt.hash(adminPassword, 12);
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, TRUE) RETURNING id`,
        [adminEmail, hash]
      );
      adminId = rows[0].id;
      console.log(`Admin user created: ${adminEmail}`);
    } else {
      adminId = existing[0].id;
    }

    await client.query(
      `INSERT INTO api_keys (user_id, key, label) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [adminId, 'mk_default_test_key', 'Default Test Key']
    );

  } finally {
    client.release();
  }
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

module.exports = { pool, initDB, getSettings };
