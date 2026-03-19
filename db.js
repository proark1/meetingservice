const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  ssl: process.env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        email        VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin     BOOLEAN DEFAULT FALSE,
        is_active    BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
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

    // Default settings (INSERT IGNORE if already exists)
    const defaults = [
      ['recording_enabled',          'true'],
      ['screen_share_enabled',       'true'],
      ['blur_enabled',               'true'],
      ['registration_enabled',       'true'],
      ['max_participants_default',   '50'],
      ['meeting_auto_delete_minutes','60'],
    ];
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    // Seed admin user
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

    // Seed default API key for the admin
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
