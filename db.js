const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  ssl: process.env.DATABASE_PUBLIC_URL
    ? { rejectUnauthorized: process.env.NODE_ENV === 'production' }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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

    // ─── Password reset tokens ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_prt_token ON password_reset_tokens(token);
    `);

    // ─── Meeting persistence log ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS meetings_log (
        id                SERIAL PRIMARY KEY,
        meeting_id        VARCHAR(50) UNIQUE NOT NULL,
        title             VARCHAR(100),
        created_by_key    VARCHAR(255),
        user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        started_at        TIMESTAMPTZ DEFAULT NOW(),
        ended_at          TIMESTAMPTZ,
        peak_participants INTEGER DEFAULT 0,
        duration_minutes  DECIMAL(10,2),
        cost_usd          DECIMAL(10,4) DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mlog_user    ON meetings_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_mlog_company ON meetings_log(company_id);
      CREATE INDEX IF NOT EXISTS idx_mlog_started ON meetings_log(started_at DESC);
    `);

    // ─── Webhooks ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        url        VARCHAR(500) NOT NULL,
        events     TEXT[] NOT NULL,
        secret     VARCHAR(64) NOT NULL,
        is_active  BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_user    ON webhooks(user_id);
      CREATE INDEX IF NOT EXISTS idx_webhooks_company ON webhooks(company_id);
    `);

    // ─── Analytics & support tables ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id          BIGSERIAL PRIMARY KEY,
        event_type  VARCHAR(64) NOT NULL,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        company_id  INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        meta        JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_anevt_type    ON analytics_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_anevt_user    ON analytics_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_anevt_created ON analytics_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_usage_log (
        id                BIGSERIAL PRIMARY KEY,
        model             VARCHAR(64)  NOT NULL,
        module            VARCHAR(64)  NOT NULL,
        endpoint          VARCHAR(128),
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_aiu_model   ON ai_usage_log(model);
      CREATE INDEX IF NOT EXISTS idx_aiu_module  ON ai_usage_log(module);
      CREATE INDEX IF NOT EXISTS idx_aiu_created ON ai_usage_log(created_at DESC);

      CREATE TABLE IF NOT EXISTS support_keys (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash   VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sk_user    ON support_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_sk_expires ON support_keys(expires_at);
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

    // ─── Chat messages & recordings tables ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id              BIGSERIAL PRIMARY KEY,
        meeting_id      VARCHAR(50) NOT NULL,
        participant_name VARCHAR(60),
        text            TEXT NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_meeting ON chat_messages(meeting_id, created_at);

      CREATE TABLE IF NOT EXISTS recordings (
        id              SERIAL PRIMARY KEY,
        meeting_id      VARCHAR(50) NOT NULL,
        user_id         INTEGER REFERENCES users(id),
        filename        VARCHAR(255) NOT NULL,
        size_bytes      BIGINT,
        storage_path    VARCHAR(500) NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id);
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

    // ─── Safe schema migrations ───────────────────────────────────────────────
    // Add FK from users.company_id → companies(id) if not already present
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD CONSTRAINT fk_users_company
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // NOT NULL on financial amount columns
    await client.query(`ALTER TABLE stripe_topups ALTER COLUMN amount_usd SET NOT NULL`).catch(e => { if (!e.message.includes('already')) console.error('stripe_topups ALTER:', e.message); });
    await client.query(`ALTER TABLE usdc_deposits  ALTER COLUMN amount_usd SET NOT NULL`).catch(e => { if (!e.message.includes('already')) console.error('usdc_deposits ALTER:', e.message); });

    // CHECK constraints (all idempotent via exception handling)
    for (const stmt of [
      `ALTER TABLE stripe_topups       ADD CONSTRAINT chk_stripe_amount   CHECK (amount_usd > 0)`,
      `ALTER TABLE usdc_deposits        ADD CONSTRAINT chk_usdc_amount     CHECK (amount_usd > 0)`,
      `ALTER TABLE companies            ADD CONSTRAINT chk_credits_gte_zero CHECK (credits_usd >= 0)`,
      `ALTER TABLE credit_transactions  ADD CONSTRAINT chk_tx_amount       CHECK (amount_usd <> 0)`,
      `ALTER TABLE companies            ADD CONSTRAINT chk_plan            CHECK (plan IN ('free','starter','pro','business'))`,
      `ALTER TABLE stripe_topups        ADD CONSTRAINT chk_stripe_status   CHECK (status IN ('pending','completed','failed'))`,
      `ALTER TABLE usdc_deposits         ADD CONSTRAINT chk_usdc_status    CHECK (status IN ('pending','confirmed','failed'))`,
    ]) {
      await client.query(`DO $$ BEGIN ${stmt}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    }

    // ─── Indexes ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id      ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_key          ON api_keys(key);
      CREATE INDEX IF NOT EXISTS idx_users_email           ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_company         ON users(company_id);
      CREATE INDEX IF NOT EXISTS idx_companies_owner       ON companies(owner_id);
      CREATE INDEX IF NOT EXISTS idx_companies_invite      ON companies(invite_code);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_user_id     ON credit_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_company_id  ON credit_transactions(company_id);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_created     ON credit_transactions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_user_type   ON credit_transactions(user_id, type);
      CREATE INDEX IF NOT EXISTS idx_credit_tx_type_created ON credit_transactions(type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stripe_topups_user    ON stripe_topups(user_id);
      CREATE INDEX IF NOT EXISTS idx_stripe_topups_company ON stripe_topups(company_id);
      CREATE INDEX IF NOT EXISTS idx_usdc_deposits_user    ON usdc_deposits(user_id);
      CREATE INDEX IF NOT EXISTS idx_usdc_deposits_company ON usdc_deposits(company_id);
    `);

    // ─── Default settings ─────────────────────────────────────────────────────
    const defaults = [
      ['recording_enabled',          'true'],
      ['screen_share_enabled',       'true'],
      ['blur_enabled',               'true'],
      ['registration_enabled',       'true'],
      ['max_participants_default',   '50'],
      ['meeting_auto_delete_minutes',          '60'],
      ['stripe_enabled',                       'true'],
      ['crypto_enabled',                       'true'],
      ['meeting_cost_per_participant_minute',   '0.01'],
      ['low_balance_threshold_usd',            '2.00'],
    ];
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    // ─── Seed admin user ──────────────────────────────────────────────────────
    const adminEmail    = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      console.warn('[db] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed');
      return;
    }
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

    const defaultApiKey = process.env.DEFAULT_API_KEY || `mk_${require('crypto').randomBytes(24).toString('hex')}`;
    const { rows: existingKeys } = await client.query('SELECT id FROM api_keys WHERE user_id = $1 LIMIT 1', [adminId]);
    if (existingKeys.length === 0) {
      await client.query(
        `INSERT INTO api_keys (user_id, key, label) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
        [adminId, defaultApiKey, 'Default Key']
      );
    }

  } finally {
    client.release();
  }
}

let settingsCache = null;
let settingsCacheAt = 0;
let settingsCachePending = null; // prevents concurrent DB queries (cache stampede)
const SETTINGS_TTL = 60_000; // 60 seconds

async function getSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < SETTINGS_TTL) return settingsCache;
  if (settingsCachePending) return settingsCachePending;
  settingsCachePending = pool.query('SELECT key, value FROM settings').then(({ rows }) => {
    settingsCache = Object.fromEntries(rows.map(r => [r.key, r.value]));
    settingsCacheAt = Date.now();
    settingsCachePending = null;
    return settingsCache;
  }).catch(err => {
    settingsCachePending = null;
    throw err;
  });
  return settingsCachePending;
}

function invalidateSettingsCache() { settingsCache = null; settingsCachePending = null; }

module.exports = { pool, initDB, getSettings, invalidateSettingsCache };
