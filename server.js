const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const morgan     = require('morgan');
const { pool, initDB, getSettings, invalidateSettingsCache } = require('./db');
const { sendEmail, passwordResetEmail, lowBalanceEmail, welcomeEmail, passwordChangedEmail } = require('./email');
const crypto = require('crypto');

// ─── Environment validation ───────────────────────────────────────────────────
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('FATAL: DATABASE_PUBLIC_URL is not set');
  process.exit(1);
}
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: SESSION_SECRET must be set in production');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET not set — using insecure default. Set SESSION_SECRET env var.');
}
if (process.env.NODE_ENV === 'production' &&
    (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'Test321!')) {
  console.error('FATAL: ADMIN_PASSWORD must be set in production and cannot be the default value.');
  process.exit(1);
}

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

let ethersHD = null;
try {
  const { ethers } = require('ethers');
  const mnemonic = process.env.CRYPTO_MNEMONIC;
  if (mnemonic) {
    ethersHD = ethers.HDNodeWallet.fromPhrase(mnemonic);
  }
} catch(e) { console.warn('ethers not available:', e.message); }

function getHDAddress(index) {
  if (!ethersHD) return null;
  return ethersHD.derivePath(`m/44'/60'/0'/0/${index}`).address;
}

function generateInviteCode() {
  // 96 bits of entropy — brute-force resistant
  return crypto.randomBytes(9).toString('base64url');
}

// ─── Analytics helpers ────────────────────────────────────────────────────────
function trackEvent(userId, companyId, eventType, meta = {}) {
  pool.query(
    `INSERT INTO analytics_events (event_type, user_id, company_id, meta) VALUES ($1,$2,$3,$4)`,
    [eventType, userId || null, companyId || null, JSON.stringify(meta)]
  ).catch(() => {});
}

function trackAiUsage(model, module, endpoint, promptTokens, completionTokens, costUsd = 0) {
  pool.query(
    `INSERT INTO ai_usage_log (model, module, endpoint, prompt_tokens, completion_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6)`,
    [model, module, endpoint, promptTokens, completionTokens, costUsd]
  ).catch(() => {});
}

const app    = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];  // safe dev default — set ALLOWED_ORIGINS in production

const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true },
  pingTimeout:  60000,
  pingInterval: 25000,
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS: origin not allowed'));
    }
  },
  credentials: true,
}));

// ─── Security, compression, logging ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, frameguard: false, crossOriginEmbedderPolicy: false }));
// Allow embedding from lovable.app; omit X-Frame-Options so this CSP takes precedence
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.lovable.app https://onetabai.lovable.app");
  next();
});
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Request timeout ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setTimeout(30000, () => res.status(503).json({ error: 'Request timeout' }));
  next();
});

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts — please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Too many reset requests — please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const guestMeetingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many guest meetings — please create a free account for more' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stripe webhook — must be raw body, before express.json()
app.post('/api/billing/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).json({ error: 'Stripe not configured' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, companyId, amountUsd } = session.metadata;
    const amt = parseFloat(amountUsd);
    try {
      // Idempotency: skip if already completed
      const { rows: existing } = await pool.query(
        `SELECT status FROM stripe_topups WHERE session_id = $1`, [session.id]
      );
      if (existing[0]?.status === 'completed') {
        return res.json({ received: true });
      }
      if (companyId) {
        await pool.query(`UPDATE companies SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, companyId]);
      } else if (userId) {
        await pool.query(`UPDATE users SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, userId]);
      }
      await pool.query(`UPDATE stripe_topups SET status = 'completed' WHERE session_id = $1`, [session.id]);
      await pool.query(
        `INSERT INTO credit_transactions (user_id, company_id, amount_usd, type, reference_id, description) VALUES ($1, $2, $3, 'stripe_topup', $4, $5)`,
        [userId || null, companyId || null, amt, session.id, `Stripe top-up $${amt}`]
      );
      console.log(`Credits added: $${amt} to ${companyId ? 'company '+companyId : 'user '+userId}`);
      trackEvent(userId || null, companyId || null, 'billing.topup', { method: 'stripe', amountUsd: parseFloat(amt) });
    } catch(err) { console.error('Credit add error:', err); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), meetings: meetings.size });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database unavailable' });
  }
});

// ─── General API rate limiter ──────────────────────────────────────────────────
app.use('/api/', apiLimiter);

// ─── Sessions ────────────────────────────────────────────────────────────────
app.use(session({
  store: new pgSession({
    pool,
    createTableIfMissing: true,
  }),
  secret:            process.env.SESSION_SECRET || 'meetingservice-secret-2024',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
  },
}));

// ─── In-memory store (meetings stay ephemeral) ───────────────────────────────
const meetings = new Map();
const scheduledMeetings = new Map(); // meetingId -> { id, adminToken, title, scheduledAt, settings, status }

// ─── Scheduled meeting activation ───────────────────────────────────────────
function activateScheduledMeeting(scheduled) {
  const meeting = {
    id: scheduled.id,
    adminToken: scheduled.adminToken,
    title: scheduled.title,
    createdAt: Date.now(),
    participants: new Map(),
    waitingRoom: new Map(),
    peakParticipants: 0,
    logId: null,
    settings: { ...scheduled.settings },
  };
  meetings.set(scheduled.id, meeting);
  scheduled.status = 'active';
}

// Check every 15s for scheduled meetings that need activating
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of scheduledMeetings) {
    if (s.status === 'scheduled' && s.scheduledAt <= now) {
      activateScheduledMeeting(s);
    }
  }
}, 15000);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateMeetingId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const pick  = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

function generateApiKey() {
  return 'mk_' + uuidv4().replace(/-/g, '').slice(0, 24);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Validates x-api-key against DB
async function authApi(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || typeof key !== 'string' || key.length > 100) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT ak.id, ak.user_id, u.company_id FROM api_keys ak JOIN users u ON u.id = ak.user_id WHERE ak.key = $1 AND ak.is_active = TRUE`,
      [key]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid or missing API key' });
    req.apiUser = { userId: rows[0].user_id, companyId: rows[0].company_id };
    // Track last use (fire-and-forget)
    pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE key = $1`, [key]).catch(() => {});
    next();
  } catch (err) {
    console.error('authApi DB error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

function findMeeting(req, res, next) {
  const meeting = meetings.get(req.params.meetingId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  req.meeting = meeting;
  next();
}

// Checks x-admin-token for meeting-level admin actions (timing-safe comparison)
function requireMeetingAdmin(req, res, next) {
  const provided = req.headers['x-admin-token'] || '';
  const expected = req.meeting.adminToken || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Admin token required' });
  }
  next();
}

// Checks session for site admin
function requireAdminSession(req, res, next) {
  if (!req.session?.userId || !req.session?.isAdmin) {
    if (req.path.startsWith('/admin/api')) {
      return res.status(401).json({ error: 'Admin login required' });
    }
    return res.redirect('/admin');
  }
  next();
}

// Checks session for any logged-in user
function requireUserSession(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

// ─── Public config (feature flags for clients) ───────────────────────────────
app.get('/api/config', async (_req, res) => {
  try {
    const s = await getSettings();
    res.json({
      recordingEnabled:    s.recording_enabled     !== 'false',
      screenShareEnabled:  s.screen_share_enabled  !== 'false',
      blurEnabled:         s.blur_enabled           !== 'false',
      registrationEnabled: s.registration_enabled  !== 'false',
    });
  } catch (err) {
    res.json({ recordingEnabled: true, screenShareEnabled: true, blurEnabled: true, registrationEnabled: true });
  }
});

// ─── User Auth ────────────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, accountType, companyName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email) || email.length > 255) return res.status(400).json({ error: 'Invalid email format' });
  if (password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (password.length > 128) return res.status(400).json({ error: 'Password too long' });
  const safeAccountType = accountType === 'company' ? 'company' : 'personal';
  if (safeAccountType === 'company' && !companyName) return res.status(400).json({ error: 'Company name required' });
  if (companyName && companyName.length > 100) return res.status(400).json({ error: 'Company name too long (max 100 chars)' });

  try {
    const settings = await getSettings();
    if (settings.registration_enabled === 'false') {
      return res.status(403).json({ error: 'Registration is currently disabled' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, account_type) VALUES ($1, $2, $3) RETURNING id, email, is_admin`,
      [normalizedEmail, hash, safeAccountType]
    );
    const user = rows[0];

    let companyId = null;
    let inviteCode = null;

    if (safeAccountType === 'company') {
      inviteCode = generateInviteCode();
      // Assign HD wallet index
      const { rows: idxRows } = await pool.query(`SELECT COALESCE(MAX(hd_wallet_index), -1) + 1 AS next FROM companies`);
      const hdIdx = idxRows[0].next;
      const walletAddr = getHDAddress(hdIdx);
      const { rows: compRows } = await pool.query(
        `INSERT INTO companies (name, owner_id, invite_code, hd_wallet_index, wallet_address) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyName.trim(), user.id, inviteCode, hdIdx, walletAddr]
      );
      companyId = compRows[0].id;
      await pool.query(`UPDATE users SET company_id = $1 WHERE id = $2`, [companyId, user.id]);
    }

    // Auto-create default API key
    const key = generateApiKey();
    await pool.query(
      `INSERT INTO api_keys (user_id, key, label) VALUES ($1, $2, $3)`,
      [user.id, key, 'Default Key']
    );

    req.session.userId    = user.id;
    req.session.email     = user.email;
    req.session.isAdmin   = user.is_admin;
    req.session.companyId = companyId;

    // Send welcome email (fire-and-forget)
    sendEmail({ to: user.email, subject: 'Welcome to MeetingService!', html: welcomeEmail(user.email, key) }).catch(() => {});

    res.json({ message: 'Account created', email: user.email, apiKey: key, inviteCode, accountType: safeAccountType });
    trackEvent(user.id, companyId || null, 'user.registered', { accountType: safeAccountType });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { password } = req.body;
  const email = (req.body.email || '').toLowerCase().trim().slice(0, 255);
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, is_admin, is_active, company_id FROM users WHERE email = $1`,
      [email]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account is disabled' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.userId    = user.id;
    req.session.email     = user.email;
    req.session.isAdmin   = user.is_admin;
    req.session.companyId = user.company_id || null;
    res.json({ message: 'Logged in', isAdmin: user.is_admin });
    trackEvent(user.id, user.company_id || null, 'user.login', {});
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Session destroy error:', err);
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

app.get('/api/auth/me', requireUserSession, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.is_admin, u.account_type, u.company_id, u.credits_usd, u.created_at,
            c.name AS company_name, c.credits_usd AS company_credits, c.invite_code, c.plan
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`, [req.session.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const u = rows[0];
  req.session.companyId = u.company_id;
  res.json(u);
});

// ─── Password Reset ───────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim().slice(0, 255);
  if (!email) return res.status(400).json({ error: 'Email required' });
  // Always respond 200 to prevent email enumeration
  try {
    const { rows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [email]);
    if (rows.length > 0) {
      const user  = rows[0];
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [user.id, token]
      );
      sendEmail({ to: user.email, subject: 'Reset your MeetingService password', html: passwordResetEmail(token) }).catch(() => {});
    }
  } catch (err) {
    console.error('Forgot password error:', err);
  }
  res.json({ message: 'If that email is registered, a reset link has been sent.' });
});

app.get('/api/auth/reset-password', resetLimiter, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const { rows } = await pool.query(
    `SELECT id FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
    [token]
  );
  if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired reset link' });
  res.json({ valid: true });
});

app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and newPassword required' });
  if (newPassword.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (newPassword.length > 128) return res.status(400).json({ error: 'Password too long' });
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const { id: tokenId, user_id } = rows[0];
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user_id]);
    await pool.query(`UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`, [tokenId]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

app.post('/api/auth/change-password', requireUserSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (newPassword.length > 128) return res.status(400).json({ error: 'Password too long' });
  try {
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.session.userId]);
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.session.userId]);
    // Send confirmation email (fire-and-forget)
    sendEmail({ to: req.session.email, subject: 'Your MeetingService password was changed', html: passwordChangedEmail(req.session.email) }).catch(() => {});
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ─── User API Keys ────────────────────────────────────────────────────────────
app.get('/api/user/keys', requireUserSession, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, key, label, is_active, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.session.userId]
  );
  res.json({ keys: rows });
});

app.post('/api/user/keys', requireUserSession, async (req, res) => {
  const label = (req.body.label || 'My API Key').slice(0, 100);
  // Max 5 keys per user
  const { rows: existing } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = $1 AND is_active = TRUE`, [req.session.userId]
  );
  if (parseInt(existing[0].cnt) >= 5) {
    return res.status(400).json({ error: 'Maximum 5 active API keys per account' });
  }
  const key = generateApiKey();
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, key, label) VALUES ($1, $2, $3) RETURNING id, key, label, created_at`,
    [req.session.userId, key, label]
  );
  res.status(201).json(rows[0]);
  trackEvent(req.session.userId, req.session.companyId || null, 'api_key.created', {});
});

app.delete('/api/user/keys/:id', requireUserSession, async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.session.userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ message: 'API key revoked' });
  trackEvent(req.session.userId, req.session.companyId || null, 'api_key.revoked', {});
});

// ─── Admin Auth ───────────────────────────────────────────────────────────────
app.post('/admin/login', authLimiter, async (req, res) => {
  const { password } = req.body;
  const email = (req.body.email || '').toLowerCase().trim().slice(0, 255);
  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, is_active FROM users WHERE email = $1 AND is_admin = TRUE`,
      [email]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account disabled' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId  = user.id;
    req.session.email   = user.email;
    req.session.isAdmin = true;
    res.json({ message: 'Logged in' });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/admin');
  });
});

// ─── Admin API ────────────────────────────────────────────────────────────────
app.get('/admin/api/stats', requireAdminSession, async (_req, res) => {
  const [users, keys, companies, credits] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE is_active = TRUE`),
    pool.query(`SELECT COUNT(*) AS cnt FROM api_keys WHERE is_active = TRUE`),
    pool.query(`SELECT COUNT(*) AS cnt FROM companies`),
    pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS total FROM credit_transactions WHERE amount_usd > 0`),
  ]);
  res.json({
    activeMeetings:     meetings.size,
    totalUsers:         parseInt(users.rows[0].cnt),
    activeApiKeys:      parseInt(keys.rows[0].cnt),
    totalCompanies:     parseInt(companies.rows[0].cnt),
    totalCreditsIssued: parseFloat(credits.rows[0].total),
  });
});

app.get('/admin/api/meetings', requireAdminSession, (_req, res) => {
  const list = [...meetings.values()].map(m => ({
    meetingId:        m.id,
    title:            m.title,
    createdAt:        m.createdAt,
    participantCount: m.participants.size,
    participants:     [...m.participants.values()].map(p => ({
      participantId: p.id, name: p.name, isMuted: p.isMuted, isVideoOff: p.isVideoOff,
    })),
    settings: m.settings,
  }));
  res.json({ meetings: list });
});

app.delete('/admin/api/meetings/:meetingId', requireAdminSession, (req, res) => {
  const m = meetings.get(req.params.meetingId);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  io.to(m.id).emit('meeting:ended', { reason: 'Meeting ended by administrator' });
  meetings.delete(m.id);
  res.json({ message: 'Meeting ended' });
});

app.get('/admin/api/users', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.is_admin, u.is_active, u.created_at,
           u.credits_usd, u.account_type,
           c.name AS company_name,
           COUNT(k.id) FILTER (WHERE k.is_active) AS active_key_count
    FROM users u
    LEFT JOIN api_keys k ON k.user_id = u.id
    LEFT JOIN companies c ON c.id = u.company_id
    GROUP BY u.id, c.name
    ORDER BY u.created_at DESC
  `);
  res.json({ users: rows });
});

app.patch('/admin/api/users/:id', requireAdminSession, async (req, res) => {
  const { isActive, isAdmin } = req.body;
  const updates = [];
  const values  = [];
  if (isActive !== undefined) { updates.push(`is_active = $${updates.length + 1}`); values.push(isActive); }
  if (isAdmin  !== undefined) { updates.push(`is_admin = $${updates.length + 1}`);  values.push(isAdmin); }
  if (updates.length === 0)   return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.params.id);
  await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  res.json({ message: 'User updated' });
});

app.delete('/admin/api/users/:id', requireAdminSession, async (req, res) => {
  // Prevent deleting own account
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
  res.json({ message: 'User deleted' });
});

app.get('/admin/api/keys', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT k.id, k.key, k.label, k.is_active, k.created_at, k.last_used_at, u.email AS user_email
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    ORDER BY k.created_at DESC
  `);
  res.json({ keys: rows });
});

app.post('/admin/api/keys', requireAdminSession, async (req, res) => {
  const { userId, label } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const key = generateApiKey();
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, key, label) VALUES ($1, $2, $3) RETURNING id, key, label, created_at`,
    [userId, key, label || 'Admin-created Key']
  );
  res.status(201).json(rows[0]);
});

app.delete('/admin/api/keys/:id', requireAdminSession, async (req, res) => {
  await pool.query(`UPDATE api_keys SET is_active = FALSE WHERE id = $1`, [req.params.id]);
  res.json({ message: 'API key revoked' });
});

app.get('/admin/api/settings', requireAdminSession, async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.patch('/admin/api/settings', requireAdminSession, async (req, res) => {
  const allowed = [
    'recording_enabled','screen_share_enabled','blur_enabled',
    'registration_enabled','max_participants_default','meeting_auto_delete_minutes',
    'stripe_enabled','crypto_enabled',
  ];
  const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (entries.length === 0) return res.status(400).json({ error: 'No valid settings provided' });

  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, String(value)]
    );
  }
  invalidateSettingsCache();
  res.json({ message: 'Settings updated' });
});

// ─── Admin API — Billing ──────────────────────────────────────────────────────

app.get('/admin/api/billing/transactions', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT ct.id, ct.amount_usd, ct.type, ct.reference_id, ct.description, ct.created_at,
           u.email AS user_email, c.name AS company_name
    FROM credit_transactions ct
    LEFT JOIN users u ON u.id = ct.user_id
    LEFT JOIN companies c ON c.id = ct.company_id
    ORDER BY ct.created_at DESC
    LIMIT 100
  `);
  res.json({ transactions: rows });
});

app.get('/admin/api/billing/stripe', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT st.id, st.amount_usd, st.session_id, st.status, st.created_at,
           u.email AS user_email, c.name AS company_name
    FROM stripe_topups st
    LEFT JOIN users u ON u.id = st.user_id
    LEFT JOIN companies c ON c.id = st.company_id
    ORDER BY st.created_at DESC
  `);
  res.json({ topups: rows });
});

app.post('/admin/api/billing/credit', requireAdminSession, async (req, res) => {
  const { email, amountUsd, note } = req.body;
  if (!email || !amountUsd) return res.status(400).json({ error: 'email and amountUsd required' });
  const amt = parseFloat(amountUsd);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amountUsd must be a positive number' });

  const { rows } = await pool.query(
    `SELECT id, account_type, company_id FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const user = rows[0];

  if (user.company_id) {
    await pool.query(`UPDATE companies SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, user.company_id]);
    await pool.query(
      `INSERT INTO credit_transactions (user_id, company_id, amount_usd, type, description) VALUES ($1,$2,$3,'admin_grant',$4)`,
      [user.id, user.company_id, amt, note || `Admin credit grant to ${email}`]
    );
  } else {
    await pool.query(`UPDATE users SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, user.id]);
    await pool.query(
      `INSERT INTO credit_transactions (user_id, amount_usd, type, description) VALUES ($1,$2,'admin_grant',$3)`,
      [user.id, amt, note || `Admin credit grant to ${email}`]
    );
  }
  res.json({ message: `Credited $${amt.toFixed(2)} to ${email}` });
});

// ─── Admin API — Companies ────────────────────────────────────────────────────

app.get('/admin/api/companies', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.credits_usd, c.plan, c.invite_code, c.wallet_address, c.created_at,
           u.email AS owner_email,
           COUNT(m.id) AS member_count
    FROM companies c
    LEFT JOIN users u ON u.id = c.owner_id
    LEFT JOIN users m ON m.company_id = c.id
    GROUP BY c.id, u.email
    ORDER BY c.created_at DESC
  `);
  res.json({ companies: rows });
});

app.patch('/admin/api/companies/:id', requireAdminSession, async (req, res) => {
  const { plan } = req.body;
  const validPlans = ['free', 'starter', 'pro', 'business'];
  if (!plan || !validPlans.includes(plan)) {
    return res.status(400).json({ error: 'plan must be one of: ' + validPlans.join(', ') });
  }
  const { rowCount } = await pool.query(
    `UPDATE companies SET plan = $1 WHERE id = $2`, [plan, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Company not found' });
  res.json({ message: 'Company plan updated' });
});

app.delete('/admin/api/companies/:id', requireAdminSession, async (req, res) => {
  const companyId = parseInt(req.params.id);
  if (isNaN(companyId)) return res.status(400).json({ error: 'Invalid company id' });
  // Pre-nullify all FK references before deleting
  await pool.query(`UPDATE usdc_deposits SET company_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`UPDATE stripe_topups SET company_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`UPDATE credit_transactions SET company_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`UPDATE users SET company_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  res.json({ message: 'Company dissolved' });
});

// ─── Admin API — Crypto ───────────────────────────────────────────────────────

app.get('/admin/api/crypto/config', requireAdminSession, async (_req, res) => {
  const [cfg, state] = await Promise.all([
    pool.query(`SELECT key, value FROM platform_config`),
    pool.query(`SELECT key, value FROM monitor_state`),
  ]);
  const config = Object.fromEntries(cfg.rows.map(r => [r.key, r.value]));
  const mstate = Object.fromEntries(state.rows.map(r => [r.key, r.value]));
  res.json({
    platformWallet: config.platform_wallet || '',
    rpcUrl:         config.rpc_url || '',
    lastBlock:      mstate.usdc_last_block || '0',
    monitorActive:  false,
  });
});

app.put('/admin/api/crypto/wallet', requireAdminSession, async (req, res) => {
  const { address } = req.body;
  if (!address || !address.match(/^0x[0-9a-fA-F]{40}$/)) {
    return res.status(400).json({ error: 'Invalid Ethereum address (must be 0x + 40 hex chars)' });
  }
  await pool.query(
    `INSERT INTO platform_config (key, value, updated_at) VALUES ('platform_wallet', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [address]
  );
  res.json({ message: 'Platform wallet updated', address });
});

app.put('/admin/api/crypto/rpc', requireAdminSession, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }
  await pool.query(
    `INSERT INTO platform_config (key, value, updated_at) VALUES ('rpc_url', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [url]
  );
  res.json({ message: 'RPC URL updated' });
});

app.get('/admin/api/crypto/deposits', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT d.id, d.amount_usd, d.tx_hash, d.wallet_address, d.status, d.created_at,
           u.email AS user_email, c.name AS company_name
    FROM usdc_deposits d
    LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN companies c ON c.id = d.company_id
    ORDER BY d.created_at DESC
  `);
  res.json({ deposits: rows });
});

app.patch('/admin/api/crypto/deposits/:id/confirm', requireAdminSession, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE usdc_deposits SET status = 'confirmed' WHERE id = $1 AND status = 'pending' RETURNING user_id, company_id, amount_usd`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Deposit not found or already confirmed' });
  const d = rows[0];
  const amt = req.body.amountUsd || d.amount_usd;
  if (d.company_id) {
    await pool.query(`UPDATE companies SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, d.company_id]);
  } else {
    await pool.query(`UPDATE users SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, d.user_id]);
  }
  await pool.query(
    `INSERT INTO credit_transactions (user_id, company_id, amount_usd, type, description) VALUES ($1,$2,$3,'usdc_deposit','USDC deposit confirmed')`,
    [d.user_id, d.company_id, amt]
  );
  res.json({ ok: true, amountUsd: amt });
});

app.get('/admin/api/crypto/unmatched', requireAdminSession, async (req, res) => {
  let query = `SELECT * FROM unmatched_usdc_transfers`;
  if (req.query.resolved === 'false') query += ` WHERE resolved = FALSE`;
  query += ` ORDER BY created_at DESC`;
  const { rows } = await pool.query(query);
  res.json({ transfers: rows });
});

app.patch('/admin/api/crypto/unmatched/:id', requireAdminSession, async (req, res) => {
  const { resolved, note } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE unmatched_usdc_transfers SET resolved = $1, resolution_note = $2 WHERE id = $3`,
    [!!resolved, note || null, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Transfer not found' });
  res.json({ message: 'Transfer updated' });
});

app.post('/admin/api/crypto/rescan', requireAdminSession, async (req, res) => {
  const block = parseInt(req.body.fromBlock);
  if (isNaN(block) || block < 0) return res.status(400).json({ error: 'fromBlock must be a non-negative integer' });
  await pool.query(
    `INSERT INTO monitor_state (key, value, updated_at) VALUES ('usdc_last_block', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(block)]
  );
  res.json({ message: `Monitor checkpoint reset to block ${block}` });
});

// ─── Billing ──────────────────────────────────────────────────────────────────

app.post('/api/billing/stripe/checkout', requireUserSession, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe payments not configured' });
  const { amountUsd } = req.body;
  const amt = parseFloat(amountUsd);
  if (!amt || amt < 5 || amt > 1000) return res.status(400).json({ error: 'Amount must be between $5 and $1000' });

  try {
    const appUrl = process.env.APP_URL || 'https://meetingservice-production.up.railway.app';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Meeting Credits — $${amt}`, description: 'Credits for MeetingService usage' },
          unit_amount: Math.round(amt * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${appUrl}/billing?success=1`,
      cancel_url:  `${appUrl}/billing?cancel=1`,
      metadata: {
        userId:    String(req.session.userId),
        companyId: req.session.companyId ? String(req.session.companyId) : '',
        amountUsd: String(amt),
      },
    });
    await pool.query(
      `INSERT INTO stripe_topups (user_id, company_id, amount_usd, session_id) VALUES ($1, $2, $3, $4)`,
      [req.session.userId, req.session.companyId || null, amt, session.id]
    );
    res.json({ url: session.url });
    trackEvent(req.session.userId, req.session.companyId || null, 'billing.stripe_initiated', { amountUsd: amt });
  } catch(err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.get('/api/billing/usdc/address', requireUserSession, async (req, res) => {
  try {
    let address = null;
    if (req.session.companyId) {
      const { rows } = await pool.query(`SELECT wallet_address FROM companies WHERE id = $1`, [req.session.companyId]);
      address = rows[0]?.wallet_address;
    } else {
      const { rows } = await pool.query(`SELECT wallet_address FROM users WHERE id = $1`, [req.session.userId]);
      if (!rows[0]?.wallet_address) {
        // Assign a new HD address
        const { rows: idxRows } = await pool.query(`SELECT COALESCE(MAX(hd_wallet_index),-1)+1 AS next FROM companies`);
        const hdIdx = (idxRows[0].next || 0) + 10000; // offset to avoid collision with company indices
        const addr  = getHDAddress(hdIdx);
        if (addr) {
          await pool.query(`UPDATE users SET wallet_address = $1 WHERE id = $2`, [addr, req.session.userId]);
          address = addr;
        }
      } else {
        address = rows[0].wallet_address;
      }
    }
    res.json({ address: address || null });
  } catch(err) {
    console.error('USDC address error:', err);
    res.status(500).json({ error: 'Failed to get address' });
  }
});

app.get('/api/billing/history', requireUserSession, async (req, res) => {
  try {
    let balance, transactions;
    if (req.session.companyId) {
      const { rows: bRows } = await pool.query(`SELECT credits_usd FROM companies WHERE id = $1`, [req.session.companyId]);
      balance = bRows[0]?.credits_usd || 0;
      const { rows } = await pool.query(
        `SELECT * FROM credit_transactions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.session.companyId]
      );
      transactions = rows;
    } else {
      const { rows: bRows } = await pool.query(`SELECT credits_usd FROM users WHERE id = $1`, [req.session.userId]);
      balance = bRows[0]?.credits_usd || 0;
      const { rows } = await pool.query(
        `SELECT * FROM credit_transactions WHERE user_id = $1 AND company_id IS NULL ORDER BY created_at DESC LIMIT 50`,
        [req.session.userId]
      );
      transactions = rows;
    }
    res.json({ balance, transactions });
  } catch(err) {
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// Join a company via invite code
app.post('/api/company/join', requireUserSession, async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: 'Invite code required' });
  try {
    const { rows } = await pool.query(`SELECT id, name FROM companies WHERE invite_code = $1`, [inviteCode.toLowerCase().trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Invalid invite code' });
    const company = rows[0];
    // Check user doesn't already have a company
    const { rows: uRows } = await pool.query(`SELECT company_id FROM users WHERE id = $1`, [req.session.userId]);
    if (uRows[0]?.company_id) return res.status(400).json({ error: 'You are already part of a company' });
    await pool.query(`UPDATE users SET company_id = $1 WHERE id = $2`, [company.id, req.session.userId]);
    req.session.companyId = company.id;
    res.json({ message: `Joined ${company.name}`, companyId: company.id, companyName: company.name });
    trackEvent(req.session.userId, company.id, 'company.joined', {});
  } catch(err) {
    res.status(500).json({ error: 'Failed to join company' });
  }
});

// ─── Company Member Management ───────────────────────────────────────────────
app.get('/api/company/members', requireUserSession, async (req, res) => {
  if (!req.session.companyId) return res.status(400).json({ error: 'You are not part of a company' });
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.account_type, u.created_at,
            COALESCE(SUM(ABS(ct.amount_usd)) FILTER (WHERE ct.type = 'meeting_usage'), 0) AS credits_used
     FROM users u
     LEFT JOIN credit_transactions ct ON ct.user_id = u.id AND ct.company_id = $1 AND ct.type = 'meeting_usage'
     WHERE u.company_id = $1
     GROUP BY u.id
     ORDER BY u.created_at ASC`,
    [req.session.companyId]
  );
  // Is requester the owner?
  const { rows: cRows } = await pool.query(`SELECT owner_id FROM companies WHERE id = $1`, [req.session.companyId]);
  const isOwner = cRows[0]?.owner_id === req.session.userId;
  res.json({ members: rows, isOwner });
});

app.delete('/api/company/members/:id', requireUserSession, async (req, res) => {
  if (!req.session.companyId) return res.status(400).json({ error: 'You are not part of a company' });
  const { rows: cRows } = await pool.query(`SELECT owner_id FROM companies WHERE id = $1`, [req.session.companyId]);
  if (cRows[0]?.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only the company owner can remove members' });
  const memberId = parseInt(req.params.id);
  if (memberId === req.session.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  const { rowCount } = await pool.query(
    `UPDATE users SET company_id = NULL WHERE id = $1 AND company_id = $2`,
    [memberId, req.session.companyId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Member not found' });
  res.json({ message: 'Member removed' });
});

// ─── Participant removal helper (used by disconnect and kick handlers) ────────
async function removeParticipantFromMeeting(meeting, participantId, io) {
  const p = meeting.participants.get(participantId);
  meeting.participants.delete(participantId);
  io.to(meeting.id).emit('participant:left', { participantId, name: p ? p.name : 'Unknown' });

  // Fire participant.left webhook
  if (meeting.logId) {
    const { rows: lRows } = await pool.query(
      `SELECT user_id, company_id FROM meetings_log WHERE id = $1`, [meeting.logId]
    ).catch(() => ({ rows: [] }));
    if (lRows[0]) {
      deliverWebhook(meeting.logId, lRows[0].user_id, lRows[0].company_id, 'participant.left', {
        meetingId: meeting.id, participantId, name: p ? p.name : 'Unknown',
      }).catch(() => {});
    }
  }

  // If room is empty, schedule charge and cleanup after 60s grace period
  if (meeting.participants.size === 0) {
    setTimeout(() => {
      const m = meetings.get(meeting.id);
      if (m && m.participants.size === 0) {
        meetings.delete(meeting.id);
        chargeMeeting(m).catch(err => console.error('Failed to charge meeting', m.id, err));
      }
    }, 60000);
  }

  return p;
}

// ─── Meeting charge helper ────────────────────────────────────────────────────
function calculateMeetingCost(durationMinutes, peakParticipants, rate) {
  return Math.round(durationMinutes * peakParticipants * rate * 10000) / 10000;
}

async function chargeMeeting(meeting) {
  try {
    if (!meeting.logId) return; // not persisted
    const mins = (Date.now() - meeting.createdAt) / 60000;
    const s = await getSettings();
    const rate = parseFloat(s.meeting_cost_per_participant_minute) || 0.01;
    const cost = calculateMeetingCost(mins, meeting.peakParticipants || 1, rate);
    if (cost < 0.0001) return;

    // Look up who created the meeting to find user/company
    const { rows } = await pool.query(
      `SELECT user_id, company_id FROM meetings_log WHERE id = $1`, [meeting.logId]
    );
    if (!rows.length) return;
    const { user_id, company_id } = rows[0];

    if (company_id) {
      const { rows: bRows } = await pool.query(
        `UPDATE companies SET credits_usd = GREATEST(credits_usd - $1, 0) WHERE id = $2 RETURNING credits_usd`,
        [cost, company_id]
      );
      const newBal = parseFloat(bRows[0]?.credits_usd || 0);
      const { rows: uRows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [user_id]);
      const thresh = parseFloat(s.low_balance_threshold_usd) || 2.0;
      const prevBal = newBal + cost;
      if (prevBal >= thresh && newBal < thresh && uRows[0]?.email) {
        sendEmail({ to: uRows[0].email, subject: 'Low balance alert — MeetingService', html: lowBalanceEmail(newBal, uRows[0].email) }).catch(() => {});
      }
    } else if (user_id) {
      const { rows: bRows } = await pool.query(
        `UPDATE users SET credits_usd = GREATEST(credits_usd - $1, 0) WHERE id = $2 RETURNING credits_usd, email`,
        [cost, user_id]
      );
      const newBal = parseFloat(bRows[0]?.credits_usd || 0);
      const thresh = parseFloat(s.low_balance_threshold_usd) || 2.0;
      if ((newBal + cost) >= thresh && newBal < thresh && bRows[0]?.email) {
        sendEmail({ to: bRows[0].email, subject: 'Low balance alert — MeetingService', html: lowBalanceEmail(newBal, bRows[0].email) }).catch(() => {});
      }
    }

    await pool.query(
      `INSERT INTO credit_transactions (user_id, company_id, amount_usd, type, reference_id, description) VALUES ($1,$2,$3,'meeting_usage',$4,$5)`,
      [user_id, company_id, -cost, meeting.id, `Meeting ${meeting.id} — ${Math.round(mins)}m × ${meeting.peakParticipants || 1} participants`]
    );

    await pool.query(
      `UPDATE meetings_log SET ended_at = NOW(), peak_participants = $1, duration_minutes = $2, cost_usd = $3 WHERE id = $4`,
      [meeting.peakParticipants || 1, parseFloat(mins.toFixed(2)), cost, meeting.logId]
    );

    // Fire webhook
    deliverWebhook(meeting.logId, user_id, company_id, 'meeting.ended', {
      meetingId: meeting.id, title: meeting.title,
      durationMinutes: parseFloat(mins.toFixed(2)),
      peakParticipants: meeting.peakParticipants || 1,
      costUsd: cost,
    }).catch(() => {});

    trackEvent(user_id, company_id, 'meeting.ended', { durationMinutes: parseFloat(mins.toFixed(2)), peakParticipants: meeting.peakParticipants || 1, costUsd: parseFloat(cost) });

  } catch (err) {
    console.error('chargeMeeting error (revenue may be lost):', err);
    throw err;
  }
}

// ─── Webhook delivery ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) return; // success or client error — don't retry
    } catch (err) {
      if (i === retries - 1) {
        console.error(`Webhook ${url} failed after ${retries} attempts:`, err.message);
      } else {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
}

async function deliverWebhook(meetingLogId, userId, companyId, event, payload) {
  try {
    const { rows } = await pool.query(
      `SELECT id, url, secret FROM webhooks WHERE is_active = TRUE AND $1 = ANY(events) AND (user_id = $2 OR company_id = $3)`,
      [event, userId || null, companyId || null]
    );
    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    for (const wh of rows) {
      const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
      fetchWithRetry(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-MeetingService-Event': event },
        body,
        signal: AbortSignal.timeout(8000),
      });
    }
  } catch (err) {
    console.error('deliverWebhook error:', err);
  }
}

// ─── Guest meeting (no auth — rate limited, no billing) ──────────────────────
app.post('/api/meetings/guest', guestMeetingLimiter, async (req, res) => {
  const id         = generateMeetingId();
  const adminToken = uuidv4();
  const meeting    = {
    id,
    adminToken,
    title:    ((req.body.title || 'Untitled Meeting') + '').slice(0, 100),
    createdAt: Date.now(),
    participants:     new Map(),
    waitingRoom:      new Map(),
    peakParticipants: 0,
    logId:            null,
    settings: { muteOnJoin: false, videoOffOnJoin: false, maxParticipants: 50, locked: false, waitingRoom: false },
  };
  meetings.set(id, meeting);
  trackEvent(null, null, 'guest_meeting.created', {});
  res.status(201).json({ meetingId: id, adminToken, joinUrl: `/join/${id}`, title: meeting.title });
});

// ─── Meetings REST API ────────────────────────────────────────────────────────
app.post('/api/meetings', authApi, async (req, res) => {
  // Apply default max participants from settings
  let maxDefault = 50;
  try {
    const s = await getSettings();
    maxDefault = parseInt(s.max_participants_default) || 50;
  } catch (e) {}

  const id         = generateMeetingId();
  const adminToken = uuidv4();
  const settings   = {
    muteOnJoin:      req.body.muteOnJoin      ?? false,
    videoOffOnJoin:  req.body.videoOffOnJoin  ?? false,
    maxParticipants: Math.min(Math.max(parseInt(req.body.maxParticipants) || maxDefault, 2), 500),
    locked:          false,
    waitingRoom:     req.body.waitingRoom     ?? false,
  };

  // Handle scheduled meetings
  if (req.body.scheduledAt) {
    const scheduledAt = new Date(req.body.scheduledAt).getTime();
    if (isNaN(scheduledAt)) {
      return res.status(400).json({ error: 'Invalid scheduledAt date format. Use ISO 8601 (e.g. 2026-03-20T14:00:00Z)' });
    }
    if (scheduledAt <= Date.now()) {
      return res.status(400).json({ error: 'scheduledAt must be in the future' });
    }

    const scheduled = {
      id, adminToken,
      title: ((req.body.title || 'Untitled Meeting') + '').slice(0, 100),
      scheduledAt, createdAt: Date.now(),
      status: 'scheduled', settings,
    };
    scheduledMeetings.set(id, scheduled);

    // Set a timer for exact activation
    const delay = scheduledAt - Date.now();
    const timerId = setTimeout(() => {
      const s = scheduledMeetings.get(id);
      if (s && s.status === 'scheduled') activateScheduledMeeting(s);
    }, delay);
    scheduled.timerId = timerId;

    // Track analytics using user already resolved by authApi middleware
    if (req.apiUser) {
      trackEvent(req.apiUser.userId, req.apiUser.companyId, 'meeting.created', { scheduled: true, muteOnJoin: settings.muteOnJoin, waitingRoom: settings.waitingRoom });
    }

    return res.status(201).json({
      meetingId: id, adminToken, joinUrl: `/join/${id}`,
      title: scheduled.title,
      scheduledAt: new Date(scheduledAt).toISOString(),
      status: 'scheduled', settings,
    });
  }

  // Instant meeting
  const meeting    = {
    id,
    adminToken,
    title:    ((req.body.title || 'Untitled Meeting') + '').slice(0, 100),
    createdAt: Date.now(),
    participants:     new Map(),
    waitingRoom:      new Map(),
    peakParticipants: 0,
    logId:            null,
    settings,
  };
  meetings.set(id, meeting);

  // Persist to meetings_log — use user already resolved by authApi middleware
  if (req.apiUser) {
    try {
      const { userId: user_id, companyId: company_id } = req.apiUser;
      const keyFingerprint = crypto.createHash('sha256').update(req.headers['x-api-key']).digest('hex').slice(0, 16);
      const { rows: logRows } = await pool.query(
        `INSERT INTO meetings_log (meeting_id, title, created_by_key, user_id, company_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [id, meeting.title, keyFingerprint, user_id, company_id || null]
      );
      meeting.logId = logRows[0].id;

      // Fire meeting.started webhook
      deliverWebhook(logRows[0].id, user_id, company_id, 'meeting.started', {
        meetingId: id, title: meeting.title,
      }).catch(() => {});
    } catch (err) {
      console.error('meetings_log insert error:', err);
    }
  }

  res.status(201).json({
    meetingId: id, adminToken, joinUrl: `/join/${id}`,
    title: meeting.title, status: 'active', settings: meeting.settings,
  });
  if (req.apiUser) {
    trackEvent(req.apiUser.userId, req.apiUser.companyId, 'meeting.created', { scheduled: false, muteOnJoin: settings.muteOnJoin, waitingRoom: settings.waitingRoom, maxParticipants: settings.maxParticipants });
  }
});

app.get('/api/meetings', authApi, (_req, res) => {
  const active = [...meetings.values()].map(m => ({
    meetingId: m.id, title: m.title, createdAt: m.createdAt,
    status: 'active', participantCount: m.participants.size,
  }));
  const scheduled = [...scheduledMeetings.values()]
    .filter(s => s.status === 'scheduled')
    .map(s => ({
      meetingId: s.id, title: s.title, createdAt: s.createdAt,
      scheduledAt: new Date(s.scheduledAt).toISOString(),
      status: 'scheduled', participantCount: 0,
    }));
  res.json({ meetings: [...active, ...scheduled] });
});

// List only scheduled meetings
app.get('/api/meetings/scheduled/list', authApi, (_req, res) => {
  const list = [...scheduledMeetings.values()].map(s => ({
    meetingId: s.id, title: s.title,
    scheduledAt: new Date(s.scheduledAt).toISOString(),
    status: s.status, createdAt: s.createdAt,
  }));
  res.json({ meetings: list });
});

app.get('/api/meetings/:meetingId', authApi, (req, res) => {
  const m = meetings.get(req.params.meetingId);
  if (m) {
    return res.json({
      meetingId: m.id, title: m.title, createdAt: m.createdAt,
      status: 'active', participantCount: m.participants.size,
      participants: [...m.participants.values()].map(p => ({
        participantId: p.id, name: p.name, isMuted: p.isMuted,
        isVideoOff: p.isVideoOff, isScreenSharing: p.isScreenSharing, joinedAt: p.joinedAt,
      })),
      settings: m.settings,
    });
  }
  const s = scheduledMeetings.get(req.params.meetingId);
  if (s) {
    return res.json({
      meetingId: s.id, title: s.title, createdAt: s.createdAt,
      scheduledAt: new Date(s.scheduledAt).toISOString(),
      status: s.status, settings: s.settings,
    });
  }
  return res.status(404).json({ error: 'Meeting not found' });
});

app.delete('/api/meetings/:meetingId', authApi, (req, res) => {
  const m = meetings.get(req.params.meetingId);
  const s = scheduledMeetings.get(req.params.meetingId);

  if (m) {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== m.adminToken) {
      return res.status(403).json({ error: 'Admin token required' });
    }
    io.to(m.id).emit('meeting:ended', { reason: 'Meeting ended by admin' });
    meetings.delete(m.id);
    scheduledMeetings.delete(m.id);
    chargeMeeting(m).catch(err => console.error('Failed to charge meeting', m.id, err));
    return res.json({ message: 'Meeting ended' });
  }

  if (s) {
    const provided = Buffer.from(req.headers['x-admin-token'] || '');
    const expected = Buffer.from(s.adminToken || '');
    if (provided.length === 0 || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(403).json({ error: 'Admin token required' });
    }
    if (s.timerId) clearTimeout(s.timerId);
    scheduledMeetings.delete(s.id);
    return res.json({ message: 'Scheduled meeting cancelled' });
  }

  return res.status(404).json({ error: 'Meeting not found' });
});

app.patch('/api/meetings/:meetingId/settings', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const allowed = ['muteOnJoin','videoOffOnJoin','maxParticipants','locked','title'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'title') req.meeting.title = req.body[key];
      else req.meeting.settings[key] = req.body[key];
    }
  }
  io.to(req.meeting.id).emit('meeting:settings-updated', req.meeting.settings);
  res.json({ settings: req.meeting.settings, title: req.meeting.title });
});

app.post('/api/meetings/:meetingId/participants/:participantId/mute', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  p.isMuted = true;
  io.to(p.socketId).emit('admin:mute');
  io.to(req.meeting.id).emit('participant:updated', { participantId: p.id, isMuted: true });
  res.json({ message: `${p.name} muted` });
});

app.post('/api/meetings/:meetingId/participants/:participantId/unmute', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  p.isMuted = false;
  io.to(p.socketId).emit('admin:unmute');
  io.to(req.meeting.id).emit('participant:updated', { participantId: p.id, isMuted: false });
  res.json({ message: `${p.name} unmuted` });
});

app.post('/api/meetings/:meetingId/participants/:participantId/kick', authApi, findMeeting, requireMeetingAdmin, async (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  io.to(p.socketId).emit('admin:kick', { reason: req.body.reason || 'Removed by admin' });
  await removeParticipantFromMeeting(req.meeting, p.id, io);
  res.json({ message: `${p.name} kicked` });
});

app.post('/api/meetings/:meetingId/mute-all', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  for (const p of req.meeting.participants.values()) {
    p.isMuted = true;
    io.to(p.socketId).emit('admin:mute');
  }
  io.to(req.meeting.id).emit('meeting:all-muted');
  res.json({ message: 'All participants muted' });
});

app.post('/api/meetings/:meetingId/invite', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const inviteToken = uuidv4().slice(0, 8);
  const joinUrl     = `/join/${req.meeting.id}?invite=${inviteToken}&name=${encodeURIComponent(req.body.name || '')}`;
  res.json({ joinUrl, inviteToken });
});

app.post('/api/meetings/:meetingId/lock', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  req.meeting.settings.locked = true;
  io.to(req.meeting.id).emit('meeting:settings-updated', req.meeting.settings);
  res.json({ locked: true });
});

app.post('/api/meetings/:meetingId/unlock', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  req.meeting.settings.locked = false;
  io.to(req.meeting.id).emit('meeting:settings-updated', req.meeting.settings);
  res.json({ locked: false });
});

// ─── Meeting history ──────────────────────────────────────────────────────────
app.get('/api/meetings/history', requireUserSession, async (req, res) => {
  try {
    let rows;
    if (req.session.companyId) {
      ({ rows } = await pool.query(
        `SELECT meeting_id, title, started_at, ended_at, peak_participants, duration_minutes, cost_usd
         FROM meetings_log WHERE company_id = $1 ORDER BY started_at DESC LIMIT 50`,
        [req.session.companyId]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT meeting_id, title, started_at, ended_at, peak_participants, duration_minutes, cost_usd
         FROM meetings_log WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50`,
        [req.session.userId]
      ));
    }
    res.json({ meetings: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load meeting history' });
  }
});

app.get('/admin/api/meetings/history', requireAdminSession, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT ml.meeting_id, ml.title, ml.started_at, ml.ended_at, ml.peak_participants,
           ml.duration_minutes, ml.cost_usd, u.email AS user_email, c.name AS company_name
    FROM meetings_log ml
    LEFT JOIN users u ON u.id = ml.user_id
    LEFT JOIN companies c ON c.id = ml.company_id
    ORDER BY ml.started_at DESC LIMIT 100
  `);
  res.json({ meetings: rows });
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────
app.get('/api/webhooks', requireUserSession, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, url, events, is_active, created_at FROM webhooks WHERE user_id = $1 OR company_id = $2 ORDER BY created_at DESC`,
    [req.session.userId, req.session.companyId || null]
  );
  res.json({ webhooks: rows });
});

app.post('/api/webhooks', requireUserSession, async (req, res) => {
  const { url, events } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  const allowed = ['meeting.started','meeting.ended','participant.joined','participant.left'];
  const safeEvents = (Array.isArray(events) ? events : []).filter(e => allowed.includes(e));
  if (!safeEvents.length) return res.status(400).json({ error: 'At least one valid event required' });
  const secret = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO webhooks (user_id, company_id, url, events, secret) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, events, is_active, created_at`,
    [req.session.userId, req.session.companyId || null, url.slice(0,500), safeEvents, secret]
  );
  res.status(201).json({ ...rows[0], secret });
  trackEvent(req.session.userId, req.session.companyId || null, 'webhook.created', { eventCount: safeEvents.length });
});

app.delete('/api/webhooks/:id', requireUserSession, async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM webhooks WHERE id = $1 AND (user_id = $2 OR company_id = $3)`,
    [req.params.id, req.session.userId, req.session.companyId || null]
  );
  if (!rowCount) return res.status(404).json({ error: 'Webhook not found' });
  res.json({ message: 'Webhook deleted' });
  trackEvent(req.session.userId, req.session.companyId || null, 'webhook.deleted', {});
});

// ─── Support Keys ─────────────────────────────────────────────────────────────
app.post('/api/user/support-key', requireUserSession, async (req, res) => {
  // Invalidate any existing unexpired key for this user
  await pool.query(`DELETE FROM support_keys WHERE user_id = $1`, [req.session.userId]);
  // Generate a random 32-char key
  const rawKey = crypto.randomBytes(16).toString('hex');
  const keyHash = await bcrypt.hash(rawKey, 10);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await pool.query(
    `INSERT INTO support_keys (user_id, key_hash, expires_at) VALUES ($1,$2,$3)`,
    [req.session.userId, keyHash, expiresAt]
  );
  res.json({ key: rawKey, expiresAt, message: 'Share this key with support. It expires in 24 hours and cannot be retrieved again.' });
});

// ─── Admin Analytics ──────────────────────────────────────────────────────────
app.get('/admin/api/analytics/overview', requireAdminSession, async (_req, res) => {
  try {
    const [totals, today, week, month] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_7d,
        (SELECT COUNT(*) FROM meetings_log) AS total_meetings,
        (SELECT COUNT(*) FROM meetings_log WHERE started_at > NOW() - INTERVAL '7 days') AS meetings_7d,
        (SELECT COUNT(*) FROM meetings_log WHERE started_at > NOW() - INTERVAL '30 days') AS meetings_30d,
        (SELECT COALESCE(SUM(ABS(amount_usd)),0) FROM credit_transactions WHERE type = 'meeting_charge') AS total_revenue,
        (SELECT COALESCE(SUM(ABS(amount_usd)),0) FROM credit_transactions WHERE type = 'meeting_charge' AND created_at > NOW() - INTERVAL '30 days') AS revenue_30d,
        (SELECT COUNT(*) FROM api_keys WHERE is_active = TRUE) AS active_keys,
        (SELECT COUNT(*) FROM webhooks WHERE is_active = TRUE) AS active_webhooks,
        (SELECT COUNT(*) FROM companies) AS total_companies,
        (SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) FROM ai_usage_log) AS total_ai_tokens,
        (SELECT COALESCE(SUM(cost_usd),0) FROM ai_usage_log) AS total_ai_cost
      `),
      pool.query(`SELECT COUNT(*) AS count FROM analytics_events WHERE created_at > NOW() - INTERVAL '1 day'`),
      pool.query(`SELECT COUNT(*) AS count FROM analytics_events WHERE created_at > NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*) AS count FROM analytics_events WHERE created_at > NOW() - INTERVAL '30 days'`),
    ]);
    res.json({ ...totals.rows[0], events_1d: today.rows[0].count, events_7d: week.rows[0].count, events_30d: month.rows[0].count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/events', requireAdminSession, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const { rows } = await pool.query(`
      SELECT event_type, COUNT(*) AS count,
             COUNT(DISTINCT user_id) AS unique_users
      FROM analytics_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY event_type ORDER BY count DESC
    `, [days]);
    res.json({ events: rows, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/trends', requireAdminSession, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const { rows } = await pool.query(`
      SELECT date_trunc('day', started_at)::date AS day,
             COUNT(*) AS meetings,
             COALESCE(SUM(peak_participants),0) AS participants,
             COALESCE(SUM(duration_minutes),0) AS total_minutes,
             COALESCE(SUM(cost_usd),0) AS revenue
      FROM meetings_log
      WHERE started_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY day ORDER BY day ASC
    `, [days]);
    res.json({ trends: rows, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/users', requireAdminSession, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.account_type, u.created_at,
             COUNT(DISTINCT ml.id) AS meeting_count,
             COALESCE(SUM(ml.duration_minutes),0) AS total_minutes,
             COALESCE(SUM(ABS(ct.amount_usd)),0) AS credits_spent,
             COUNT(DISTINCT ak.id) AS api_key_count,
             COUNT(DISTINCT wh.id) AS webhook_count,
             MAX(ae.created_at) AS last_active
      FROM users u
      LEFT JOIN meetings_log ml ON ml.user_id = u.id
      LEFT JOIN credit_transactions ct ON ct.user_id = u.id AND ct.type = 'meeting_charge'
      LEFT JOIN api_keys ak ON ak.user_id = u.id AND ak.is_active = TRUE
      LEFT JOIN webhooks wh ON wh.user_id = u.id
      LEFT JOIN analytics_events ae ON ae.user_id = u.id
      WHERE u.is_admin = FALSE
      GROUP BY u.id ORDER BY meeting_count DESC, u.created_at DESC
      LIMIT 100
    `);
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/ai', requireAdminSession, async (req, res) => {
  try {
    const [byModel, byModule, daily] = await Promise.all([
      pool.query(`
        SELECT model,
               SUM(prompt_tokens) AS prompt_tokens,
               SUM(completion_tokens) AS completion_tokens,
               SUM(prompt_tokens + completion_tokens) AS total_tokens,
               SUM(cost_usd) AS cost_usd,
               COUNT(*) AS calls
        FROM ai_usage_log GROUP BY model ORDER BY total_tokens DESC
      `),
      pool.query(`
        SELECT module, endpoint,
               SUM(prompt_tokens) AS prompt_tokens,
               SUM(completion_tokens) AS completion_tokens,
               SUM(prompt_tokens + completion_tokens) AS total_tokens,
               SUM(cost_usd) AS cost_usd,
               COUNT(*) AS calls
        FROM ai_usage_log GROUP BY module, endpoint ORDER BY total_tokens DESC LIMIT 20
      `),
      pool.query(`
        SELECT date_trunc('day', created_at)::date AS day,
               model,
               SUM(prompt_tokens + completion_tokens) AS total_tokens,
               SUM(cost_usd) AS cost_usd
        FROM ai_usage_log
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY day, model ORDER BY day ASC
      `),
    ]);
    res.json({ byModel: byModel.rows, byModule: byModule.rows, daily: daily.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/analytics/support-key', requireAdminSession, async (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string' || key.length !== 32) {
    return res.status(400).json({ error: 'Invalid support key format' });
  }
  try {
    // Find all non-expired, unused keys and compare
    const { rows } = await pool.query(`
      SELECT sk.id, sk.user_id, sk.key_hash, sk.expires_at, u.email, u.account_type, u.created_at AS user_created
      FROM support_keys sk JOIN users u ON u.id = sk.user_id
      WHERE sk.expires_at > NOW() AND sk.used_at IS NULL
    `);
    let matched = null;
    for (const row of rows) {
      const ok = await bcrypt.compare(key, row.key_hash);
      if (ok) { matched = row; break; }
    }
    if (!matched) return res.status(404).json({ error: 'Support key not found, expired, or already used' });

    // Mark as used
    await pool.query(`UPDATE support_keys SET used_at = NOW() WHERE id = $1`, [matched.id]);

    // Fetch that user's meeting history (full detail, gated by key)
    const { rows: meetings } = await pool.query(`
      SELECT meeting_id, title, started_at, ended_at, peak_participants, duration_minutes, cost_usd
      FROM meetings_log WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50
    `, [matched.user_id]);

    const { rows: events } = await pool.query(`
      SELECT event_type, meta, created_at FROM analytics_events
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100
    `, [matched.user_id]);

    res.json({
      user: { id: matched.user_id, email: matched.email, accountType: matched.account_type, createdAt: matched.user_created },
      meetings,
      recentEvents: events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ICE server config ────────────────────────────────────────────────────────
app.get('/api/config/ice-servers', (_req, res) => {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    servers.push({
      urls:       process.env.TURN_URLS.split(',').map(u => u.trim()),
      username:   process.env.TURN_USERNAME   || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  res.json({ iceServers: servers });
});

// ─── HTML Routes ──────────────────────────────────────────────────────────────
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/docs',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/reset',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));
app.get('/dashboard',(_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/billing',  requireUserSession, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'billing.html')));
app.get('/join/:meetingId', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'meeting.html')));

app.get('/admin', (req, res) => {
  if (req.session?.userId && req.session?.isAdmin) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin/dashboard', requireAdminSession, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Socket.IO signaling ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentMeetingId      = null;
  let currentParticipantId  = null;

  socket.on('join-meeting', ({ meetingId, name, isAdmin, adminToken }) => {
    const meeting = meetings.get(meetingId);
    if (!meeting) {
      const scheduled = scheduledMeetings.get(meetingId);
      if (scheduled && scheduled.status === 'scheduled') {
        return socket.emit('error', { message: `This meeting is scheduled for ${new Date(scheduled.scheduledAt).toLocaleString()}. Please wait until it starts.` });
      }
      return socket.emit('error', { message: 'Meeting not found' });
    }

    if (meeting.settings.locked && !(isAdmin && adminToken === meeting.adminToken)) {
      return socket.emit('error', { message: 'Meeting is locked' });
    }
    if (meeting.participants.size >= meeting.settings.maxParticipants) {
      return socket.emit('error', { message: 'Meeting is full' });
    }

    const participantId = uuidv4();
    const safeName = ((name || 'Anonymous') + '').trim().slice(0, 60) || 'Anonymous';
    const participant   = {
      id: participantId, socketId: socket.id,
      name: safeName,
      isMuted:       meeting.settings.muteOnJoin,
      isVideoOff:    meeting.settings.videoOffOnJoin,
      isScreenSharing: false,
      isHandRaised:  false,
      isAdmin:       isAdmin && adminToken === meeting.adminToken,
      joinedAt:      Date.now(),
    };

    meeting.participants.set(participantId, participant);
    if (meeting.participants.size > (meeting.peakParticipants || 0)) {
      meeting.peakParticipants = meeting.participants.size;
    }
    socket.join(meetingId);
    currentMeetingId     = meetingId;
    currentParticipantId = participantId;

    const existing = [...meeting.participants.values()]
      .filter(p => p.id !== participantId)
      .map(p => ({
        participantId: p.id, name: p.name, isMuted: p.isMuted,
        isVideoOff: p.isVideoOff, isScreenSharing: p.isScreenSharing,
        isHandRaised: p.isHandRaised || false, isAdmin: p.isAdmin,
      }));

    socket.emit('joined', {
      participantId, participants: existing,
      settings: meeting.settings, title: meeting.title,
      isAdmin: participant.isAdmin,
      muteOnJoin: meeting.settings.muteOnJoin,
      videoOffOnJoin: meeting.settings.videoOffOnJoin,
    });

    socket.to(meetingId).emit('participant:joined', {
      participantId, name: participant.name,
      isMuted: participant.isMuted, isVideoOff: participant.isVideoOff,
      isHandRaised: false, isAdmin: participant.isAdmin,
    });

    // Fire participant.joined webhook (fire-and-forget)
    if (meeting.logId) {
      pool.query(`SELECT user_id, company_id FROM meetings_log WHERE id = $1`, [meeting.logId]).then(({ rows }) => {
        if (rows[0]) {
          deliverWebhook(meeting.logId, rows[0].user_id, rows[0].company_id, 'participant.joined', {
            meetingId, participantId, name: participant.name,
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  });

  // ─── Waiting room ───────────────────────────────────────────────────────────
  socket.on('waiting-room:join', ({ meetingId: mid, name }) => {
    const meeting = meetings.get(mid);
    if (!meeting) return socket.emit('error', { message: 'Meeting not found' });
    if (!meeting.settings.waitingRoom) {
      // No waiting room — just signal that they should join normally
      return socket.emit('waiting-room:admitted');
    }
    const safeName = ((name || 'Anonymous') + '').trim().slice(0, 60) || 'Anonymous';
    meeting.waitingRoom.set(socket.id, { socketId: socket.id, name: safeName });
    socket.join(`waiting:${mid}`);
    // Notify host(s) that someone is waiting
    socket.to(mid).emit('waiting-room:participant-waiting', { socketId: socket.id, name: safeName, count: meeting.waitingRoom.size });
    socket.emit('waiting-room:waiting', { message: 'Waiting for the host to admit you…' });
  });

  socket.on('waiting-room:admit', ({ meetingId: mid, socketId: targetSocketId }) => {
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin) return; // only meeting admin can admit
    const waiter = meeting.waitingRoom.get(targetSocketId);
    if (!waiter) return;
    meeting.waitingRoom.delete(targetSocketId);
    io.to(targetSocketId).emit('waiting-room:admitted');
    socket.to(mid).emit('waiting-room:participant-waiting', { socketId: targetSocketId, name: waiter.name, count: meeting.waitingRoom.size, removed: true });
  });

  socket.on('waiting-room:deny', ({ meetingId: mid, socketId: targetSocketId }) => {
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin) return;
    const waiter = meeting.waitingRoom.get(targetSocketId);
    if (!waiter) return;
    meeting.waitingRoom.delete(targetSocketId);
    io.to(targetSocketId).emit('waiting-room:denied', { message: 'The host did not admit you to this meeting.' });
    socket.to(mid).emit('waiting-room:participant-waiting', { socketId: targetSocketId, name: waiter.name, count: meeting.waitingRoom.size, removed: true });
  });

  socket.on('signal:offer', ({ to, offer }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const target = meeting.participants.get(to);
    if (target) io.to(target.socketId).emit('signal:offer', { from: currentParticipantId, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const target = meeting.participants.get(to);
    if (target) io.to(target.socketId).emit('signal:answer', { from: currentParticipantId, answer });
  });

  socket.on('signal:ice-candidate', ({ to, candidate }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const target = meeting.participants.get(to);
    if (target) io.to(target.socketId).emit('signal:ice-candidate', { from: currentParticipantId, candidate });
  });

  socket.on('media:toggle-audio', ({ isMuted }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) { p.isMuted = isMuted; socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isMuted }); }
  });

  socket.on('media:toggle-video', ({ isVideoOff }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) { p.isVideoOff = isVideoOff; socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isVideoOff }); }
  });

  socket.on('media:screen-share', ({ isScreenSharing }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) { p.isScreenSharing = isScreenSharing; socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isScreenSharing }); }
  });

  socket.on('raise-hand', ({ isHandRaised }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) { p.isHandRaised = isHandRaised; io.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isHandRaised }); }
  });

  socket.on('react', ({ emoji }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    // Sanitize: only allow known emoji values
    const allowed = ['👍','❤️','😂','🎉','👏'];
    if (!allowed.includes(emoji)) return;
    io.to(currentMeetingId).emit('react', { participantId: currentParticipantId, emoji });
  });

  socket.on('recording:broadcast-started', ({ hostName }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    socket.to(currentMeetingId).emit('recording:started', { hostName: (hostName || '').slice(0, 60) });
  });

  socket.on('chat:message', ({ text }) => {
    if (!text || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    io.to(currentMeetingId).emit('chat:message', {
      from: currentParticipantId, name: p.name, text: trimmed, timestamp: Date.now(),
    });
  });

  socket.on('disconnect', async () => {
    if (!currentMeetingId || !currentParticipantId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    await removeParticipantFromMeeting(meeting, currentParticipantId, io);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Meeting Service running on http://localhost:${PORT}`);
      console.log(`Admin panel at http://localhost:${PORT}/admin`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    console.log('HTTP server closed');
    try {
      await pool.end();
      console.log('Database pool closed');
    } catch (err) {
      console.error('Pool close error:', err);
    }
    process.exit(0);
  });
  // Force-exit after 10s if not done
  setTimeout(() => {
    console.error('Forced exit after shutdown timeout');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
