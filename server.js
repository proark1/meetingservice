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
const { sendEmail, passwordResetEmail, lowBalanceEmail, welcomeEmail, passwordChangedEmail, meetingReceiptEmail } = require('./email');
const crypto = require('crypto');
const multer = require('multer');
const fs     = require('fs');

// ─── Structured logging ─────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === 'error') process.stderr.write(entry + '\n');
  else process.stdout.write(entry + '\n');
}

// ─── Recording upload storage ────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${file.originalname.slice(0, 100)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only video/audio files are allowed'));
  },
});

// ─── Meeting file upload storage ─────────────────────────────────────────────
const FILES_DIR = path.join(__dirname, 'uploads', 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FILES_DIR),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${file.originalname.slice(0, 100)}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image|application\/pdf|application\/msword|application\/vnd\.openxmlformats|text\/)/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images, PDFs, documents, and text files are allowed'));
  },
});

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
  return pool.query(
    `INSERT INTO analytics_events (event_type, user_id, company_id, meta) VALUES ($1,$2,$3,$4)`,
    [eventType, userId || null, companyId || null, JSON.stringify(meta)]
  ).catch(err => console.error(`trackEvent [${eventType}]:`, err.message));
}

function trackAiUsage(model, module, endpoint, promptTokens, completionTokens, costUsd = 0) {
  return pool.query(
    `INSERT INTO ai_usage_log (model, module, endpoint, prompt_tokens, completion_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6)`,
    [model, module, endpoint, promptTokens, completionTokens, costUsd]
  ).catch(err => console.error(`trackAiUsage [${module}]:`, err.message));
}

function auditLog(userId, action, targetType, targetId, meta = {}, ip = null) {
  return pool.query(
    `INSERT INTO audit_log (user_id, action, target_type, target_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId || null, action, targetType || null, targetId || null, JSON.stringify(meta), ip]
  ).catch(err => console.error(`auditLog [${action}]:`, err.message));
}

const app    = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// If ALLOWED_ORIGINS is set, enforce the whitelist.
// If not set, allow all origins (works for self-hosted / Railway with no extra config).
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null;

const io = new Server(server, {
  cors: { origin: allowedOrigins || true, credentials: true },
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'], // prefer WebSocket, polling as fallback
});

app.set('trust proxy', 1); // trust first proxy (Railway, nginx, etc.) for correct IP in rate limiters

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin or non-browser requests
    if (!allowedOrigins || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// ─── Security, compression, logging ──────────────────────────────────────────
const frameAncestors = process.env.ALLOWED_FRAME_ANCESTORS || '*';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      workerSrc: ["'self'", "blob:"],
      frameAncestors: [frameAncestors],
    },
  },
  frameguard: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));
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
      // Atomic idempotency: only mark completed if still pending (prevents double-credit)
      const { rowCount } = await pool.query(
        `UPDATE stripe_topups SET status = 'completed' WHERE session_id = $1 AND status = 'pending'`, [session.id]
      );
      if (rowCount === 0) {
        // Already completed or doesn't exist — skip
        return res.json({ received: true });
      }
      if (companyId) {
        await pool.query(`UPDATE companies SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, companyId]);
      } else if (userId) {
        await pool.query(`UPDATE users SET credits_usd = credits_usd + $1 WHERE id = $2`, [amt, userId]);
      }
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

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    // No cache on HTML files — prevents stale code after deploys
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day for assets
    }
  },
}));
app.use(express.json({ limit: '1mb' }));

// ─── Health checks ────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), meetings: meetings.size });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database unavailable' });
  }
});
app.get('/health/liveness', (_req, res) => {
  res.json({ status: 'ok' });
});
app.get('/health/readiness', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unavailable' });
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
  secret:            process.env.SESSION_SECRET || 'onepizza-secret-2024',
  resave:            false,
  saveUninitialized: false,
  proxy: true, // trust proxy for secure cookies behind Railway/nginx
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
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
    ownerId: scheduled.ownerId || null,
    ownerCompanyId: scheduled.ownerCompanyId || null,
    settings: { ...scheduled.settings },
    attendance: [], polls: new Map(), questions: new Map(),
    notes: { content: '', lastUpdatedBy: '', lastUpdatedAt: null },
  };
  meetings.set(scheduled.id, meeting);
  scheduled.status = 'active';
  scheduledMeetings.delete(scheduled.id);
}

// Check every 15s for scheduled meetings that need activating
const scheduledMeetingPoller = setInterval(() => {
  if (scheduledMeetings.size === 0) return; // skip iteration when empty
  const now = Date.now();
  for (const [id, s] of scheduledMeetings) {
    if (s.status === 'scheduled' && s.scheduledAt <= now) {
      activateScheduledMeeting(s);
    }
  }
}, 15000);

// Cleanup abandoned meetings (no participants for 24h) every 30 minutes
const MEETING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, m] of meetings) {
    if (m.participants.size === 0 && now - m.createdAt > MEETING_MAX_AGE_MS && !m.gracePeriodTimer) {
      meetings.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateMeetingId() {
  const seg = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
  return `${seg(3)}-${seg(4)}-${seg(3)}`;
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
      // Assign HD wallet index (advisory lock prevents concurrent duplicate)
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(42)');
        const { rows: idxRows } = await client.query(`SELECT COALESCE(MAX(hd_wallet_index), -1) + 1 AS next FROM companies`);
        const hdIdx = idxRows[0].next;
        const walletAddr = getHDAddress(hdIdx);
        const { rows: compRows } = await client.query(
          `INSERT INTO companies (name, owner_id, invite_code, hd_wallet_index, wallet_address) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [companyName.trim(), user.id, inviteCode, hdIdx, walletAddr]
        );
        companyId = compRows[0].id;
        await client.query(`UPDATE users SET company_id = $1 WHERE id = $2`, [companyId, user.id]);
        await client.query('SELECT pg_advisory_unlock(42)');
      } finally {
        client.release();
      }
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

    auditLog(user.id, 'user.register', 'user', String(user.id), { email: user.email, accountType: safeAccountType }, req.ip);
    // Send welcome email (fire-and-forget)
    sendEmail({ to: user.email, subject: 'Welcome to onepizza.io!', html: welcomeEmail(user.email, key) }).catch(() => {});

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
    auditLog(user.id, 'user.login', 'user', String(user.id), { email: user.email }, req.ip);
    // Explicitly save the session before responding so the client's next
    // request (/api/auth/me) finds the session already in the store.
    req.session.save(err => {
      if (err) { console.error('Session save error:', err); return res.status(500).json({ error: 'Login failed' }); }
      res.json({ message: 'Logged in', isAdmin: user.is_admin });
      trackEvent(user.id, user.company_id || null, 'user.login', {});
    });
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
      sendEmail({ to: user.email, subject: 'Reset your onepizza.io password', html: passwordResetEmail(token) }).catch(() => {});
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
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.session.userId]);
    // Send confirmation email (fire-and-forget)
    sendEmail({ to: req.session.email, subject: 'Your onepizza.io password was changed', html: passwordChangedEmail(req.session.email) }).catch(() => {});
    auditLog(req.session.userId, 'user.password_changed', 'user', String(req.session.userId), {}, req.ip);
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
    req.session.save(err => {
      if (err) { console.error('Admin session save error:', err); return res.status(500).json({ error: 'Login failed' }); }
      res.json({ message: 'Logged in' });
    });
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

app.get('/admin/api/meetings', requireAdminSession, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const all = [...meetings.values()];
  const list = all.slice(offset, offset + limit).map(m => ({
    meetingId:        m.id,
    title:            m.title,
    createdAt:        m.createdAt,
    participantCount: m.participants.size,
    participants:     [...m.participants.values()].map(p => ({
      participantId: p.id, name: p.name, isMuted: p.isMuted, isVideoOff: p.isVideoOff,
    })),
    settings: m.settings,
  }));
  res.json({ meetings: list, total: all.length });
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
    LIMIT 200
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
    LIMIT 200
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
  const booleanSettings = new Set([
    'recording_enabled','screen_share_enabled','blur_enabled',
    'registration_enabled','stripe_enabled','crypto_enabled',
  ]);
  const numericSettings = new Set([
    'max_participants_default','meeting_auto_delete_minutes',
  ]);
  const allowed = new Set([...booleanSettings, ...numericSettings]);
  const entries = Object.entries(req.body).filter(([k]) => allowed.has(k));
  if (entries.length === 0) return res.status(400).json({ error: 'No valid settings provided' });

  // Validate all entries first, then batch-write in a single query
  const sanitized = [];
  for (const [key, value] of entries) {
    let safeValue = String(value);
    if (booleanSettings.has(key)) {
      if (safeValue !== 'true' && safeValue !== 'false') return res.status(400).json({ error: `${key} must be true or false` });
    } else if (numericSettings.has(key)) {
      const num = Number(safeValue);
      if (!Number.isFinite(num) || num < 0) return res.status(400).json({ error: `${key} must be a non-negative number` });
      safeValue = String(num);
    }
    sanitized.push([key, safeValue]);
  }
  const values = sanitized.flatMap(([k, v]) => [k, v]);
  const placeholders = sanitized.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, NOW())`).join(', ');
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ${placeholders}
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    values
  );
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
    LIMIT 200
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
    const appUrl = process.env.APP_URL || 'https://onepizza.io';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `onepizza.io Credits — $${amt}`, description: 'Credits for onepizza.io usage' },
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
        // Assign a new HD address (advisory lock prevents concurrent duplicate)
        const client = await pool.connect();
        try {
          await client.query('SELECT pg_advisory_lock(42)');
          const { rows: idxRows } = await client.query(`SELECT COALESCE(MAX(hd_wallet_index),-1)+1 AS next FROM companies`);
          const hdIdx = (idxRows[0].next || 0) + 10000; // offset to avoid collision with company indices
          const addr  = getHDAddress(hdIdx);
          if (addr) {
            await client.query(`UPDATE users SET wallet_address = $1 WHERE id = $2`, [addr, req.session.userId]);
            address = addr;
          }
          await client.query('SELECT pg_advisory_unlock(42)');
        } finally {
          client.release();
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
  if (meeting.attendance) {
    const rec = meeting.attendance.findLast(a => a.participantId === participantId && !a.leftAt);
    if (rec) rec.leftAt = Date.now();
  }
  // Clear recording state if the recorder disconnected without stopping
  if (meeting.recordingParticipantId === participantId) {
    meeting.isRecording = false;
    meeting.recordingHostName = '';
    meeting.recordingParticipantId = null;
    io.to(meeting.id).emit('recording:stopped');
  }
  // Clear streaming state if the streamer disconnected without stopping
  if (meeting.streamingParticipantId === participantId) {
    meeting.isStreaming = false;
    meeting.streamUrl = null;
    meeting.streamingParticipantId = null;
    io.to(meeting.id).emit('stream:stopped');
  }
  // Remove from breakout room if in one
  if (meeting.breakoutRooms) {
    for (const [, r] of meeting.breakoutRooms) {
      r.participants.delete(participantId);
    }
  }
  io.to(meeting.id).emit('participant:left', { participantId, name: p ? p.name : 'Unknown' });

  // Fire participant.left webhook — use cached owner IDs
  if (meeting.logId && meeting.ownerId) {
    deliverWebhook(meeting.logId, meeting.ownerId, meeting.ownerCompanyId, 'participant.left', {
      meetingId: meeting.id, participantId, name: p ? p.name : 'Unknown',
    }).catch(() => {});
  }

  // If room is empty, schedule charge and cleanup after 60s grace period
  if (meeting.participants.size === 0) {
    if (meeting.gracePeriodTimer) clearTimeout(meeting.gracePeriodTimer);
    meeting.gracePeriodTimer = setTimeout(() => {
      meeting.gracePeriodTimer = null;
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
  const client = await pool.connect();
  try {
    if (!meeting.logId) { client.release(); return; }
    const mins = (Date.now() - meeting.createdAt) / 60000;
    const s = await getSettings();
    const rate = parseFloat(s.meeting_cost_per_participant_minute) || 0.01;
    const cost = calculateMeetingCost(mins, meeting.peakParticipants || 1, rate);
    if (cost < 0.0001) { client.release(); return; }

    // Use cached owner IDs (set when meeting was created) — falls back to DB
    let user_id = meeting.ownerId, company_id = meeting.ownerCompanyId;
    if (!user_id) {
      const { rows } = await client.query(
        `SELECT user_id, company_id FROM meetings_log WHERE id = $1`, [meeting.logId]
      );
      if (!rows.length) { client.release(); return; }
      user_id = rows[0].user_id; company_id = rows[0].company_id;
    }

    await client.query('BEGIN');

    let newBal = 0, notifyEmail = null;
    if (company_id) {
      const { rows: bRows } = await client.query(
        `UPDATE companies SET credits_usd = GREATEST(credits_usd - $1, 0) WHERE id = $2 RETURNING credits_usd`,
        [cost, company_id]
      );
      newBal = parseFloat(bRows[0]?.credits_usd || 0);
      const { rows: uRows } = await client.query(`SELECT email FROM users WHERE id = $1`, [user_id]);
      const thresh = parseFloat(s.low_balance_threshold_usd) || 2.0;
      if ((newBal + cost) >= thresh && newBal < thresh && uRows[0]?.email) notifyEmail = uRows[0].email;
    } else if (user_id) {
      const { rows: bRows } = await client.query(
        `UPDATE users SET credits_usd = GREATEST(credits_usd - $1, 0) WHERE id = $2 RETURNING credits_usd, email`,
        [cost, user_id]
      );
      newBal = parseFloat(bRows[0]?.credits_usd || 0);
      const thresh = parseFloat(s.low_balance_threshold_usd) || 2.0;
      if ((newBal + cost) >= thresh && newBal < thresh && bRows[0]?.email) notifyEmail = bRows[0].email;
    }

    await client.query(
      `INSERT INTO credit_transactions (user_id, company_id, amount_usd, type, reference_id, description) VALUES ($1,$2,$3,'meeting_usage',$4,$5)`,
      [user_id, company_id, -cost, meeting.id, `Meeting ${meeting.id} — ${Math.round(mins)}m × ${meeting.peakParticipants || 1} participants`]
    );

    await client.query(
      `UPDATE meetings_log SET ended_at = NOW(), peak_participants = $1, duration_minutes = $2, cost_usd = $3 WHERE id = $4`,
      [meeting.peakParticipants || 1, parseFloat(mins.toFixed(2)), cost, meeting.logId]
    );

    // Look up receipt email before committing (avoids post-commit pool query)
    let receiptEmail = notifyEmail;
    if (!receiptEmail) {
      const { rows: emailRows } = await client.query('SELECT email FROM users WHERE id = $1', [user_id]);
      receiptEmail = emailRows[0]?.email;
    }

    await client.query('COMMIT');

    // Persist attendance records (fire-and-forget)
    if (meeting.attendance) {
      for (const a of meeting.attendance) {
        const durSec = a.leftAt ? Math.round((a.leftAt - a.joinedAt) / 1000) : Math.round((Date.now() - a.joinedAt) / 1000);
        pool.query(
          `INSERT INTO meeting_attendance (meeting_id, participant_id, participant_name, joined_at, left_at, duration_seconds) VALUES ($1,$2,$3,$4,$5,$6)`,
          [meeting.id, a.participantId, a.name, new Date(a.joinedAt), a.leftAt ? new Date(a.leftAt) : new Date(), durSec]
        ).catch(err => console.error('attendance save error:', err.message));
      }
    }

    // Non-transactional: email, webhook, analytics (fire-and-forget)
    if (notifyEmail) {
      sendEmail({ to: notifyEmail, subject: 'Low balance alert — onepizza.io', html: lowBalanceEmail(newBal, notifyEmail) }).catch(() => {});
    }
    if (receiptEmail && cost >= 0.01) {
      sendEmail({
        to: receiptEmail,
        subject: `Meeting receipt — ${meeting.title || meeting.id}`,
        html: meetingReceiptEmail({ to: receiptEmail, meetingId: meeting.id, title: meeting.title, durationMinutes: parseFloat(mins.toFixed(2)), cost }),
      }).catch(() => {});
    }
    deliverWebhook(meeting.logId, user_id, company_id, 'meeting.ended', {
      meetingId: meeting.id, title: meeting.title,
      durationMinutes: parseFloat(mins.toFixed(2)),
      peakParticipants: meeting.peakParticipants || 1,
      costUsd: cost,
    }).catch(() => {});

    trackEvent(user_id, company_id, 'meeting.ended', { durationMinutes: parseFloat(mins.toFixed(2)), peakParticipants: meeting.peakParticipants || 1, costUsd: parseFloat(cost) });

    // Persist attendance records (fire-and-forget)
    if (meeting.attendance && meeting.attendance.length > 0) {
      const now = Date.now();
      for (const a of meeting.attendance) {
        const left = a.leftAt || now;
        const dur = Math.round((left - a.joinedAt) / 1000);
        pool.query(
          `INSERT INTO meeting_attendance (meeting_id, participant_id, participant_name, joined_at, left_at, duration_seconds)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [meeting.id, a.participantId, a.name, new Date(a.joinedAt), new Date(left), dur]
        ).catch(err => console.error('attendance persist error:', err.message));
      }
    }

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('chargeMeeting error (revenue may be lost):', err);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Webhook delivery ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
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
      // Persist delivery before sending
      const { rows: delRows } = await pool.query(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
        [wh.id, event, JSON.stringify(payload)]
      ).catch(() => ({ rows: [] }));
      const deliveryId = delRows[0]?.id;
      const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
      try {
        await fetchWithRetry(wh.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-OnePizza-Event': event },
          body,
        });
        if (deliveryId) pool.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_attempt_at = NOW() WHERE id = $1`, [deliveryId]).catch(() => {});
      } catch (err) {
        if (deliveryId) pool.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, last_attempt_at = NOW() WHERE id = $1`, [deliveryId]).catch(() => {});
      }
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
    attendance: [], polls: new Map(), questions: new Map(),
    notes: { content: '', lastUpdatedBy: '', lastUpdatedAt: null },
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
      ownerId: req.apiUser?.userId || null,
      ownerCompanyId: req.apiUser?.companyId || null,
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
    ownerId:          null,  // cached for webhook/analytics (avoids DB lookup on join)
    ownerCompanyId:   null,
    settings,
    attendance: [], polls: new Map(), questions: new Map(),
    notes: { content: '', lastUpdatedBy: '', lastUpdatedAt: null },
  };

  // Apply template if specified
  if (req.body.templateId) {
    try {
      const { rows: tplRows } = await pool.query(
        `SELECT settings FROM meeting_templates WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
        [req.body.templateId, req.apiUser?.userId || null]
      );
      if (tplRows.length) {
        const ts = tplRows[0].settings;
        if (ts.muteOnJoin !== undefined) meeting.settings.muteOnJoin = ts.muteOnJoin;
        if (ts.videoOffOnJoin !== undefined) meeting.settings.videoOffOnJoin = ts.videoOffOnJoin;
        if (ts.maxParticipants !== undefined) meeting.settings.maxParticipants = Math.min(Math.max(ts.maxParticipants, 2), 500);
        if (ts.waitingRoom !== undefined) meeting.settings.waitingRoom = ts.waitingRoom;
      }
    } catch (_e) { /* ignore template errors */ }
  }

  meetings.set(id, meeting);

  // Persist to meetings_log — use user already resolved by authApi middleware
  if (req.apiUser) {
    try {
      const { userId: user_id, companyId: company_id } = req.apiUser;
      meeting.ownerId = user_id;
      meeting.ownerCompanyId = company_id;
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
    const provided = Buffer.from(req.headers['x-admin-token'] || '');
    const expected = Buffer.from(m.adminToken || '');
    if (provided.length === 0 || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
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

// ─── Polls ────────────────────────────────────────────────────────────────────
app.post('/api/meetings/:meetingId/polls', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const { question, options } = req.body;
  if (!question || !Array.isArray(options) || options.length < 2 || options.length > 10) return res.status(400).json({ error: 'Provide question and 2-10 options' });
  const pollId = crypto.randomUUID();
  const poll = { id: pollId, question: (question + '').trim().slice(0, 500), options: options.slice(0, 10).map((o, i) => ({ id: `opt_${i}`, text: (o + '').trim().slice(0, 200) })), votes: new Map(), isActive: true, createdAt: Date.now() };
  req.meeting.polls.set(pollId, poll);
  io.to(req.meeting.id).emit('poll:created', { id: poll.id, question: poll.question, options: poll.options, isActive: true });
  trackEvent(req.apiUser?.userId, req.apiUser?.companyId, 'feature.poll', { action: 'create' });
  res.status(201).json({ pollId: poll.id, question: poll.question, options: poll.options });
});
app.post('/api/meetings/:meetingId/polls/:pollId/vote', authApi, findMeeting, (req, res) => {
  const poll = req.meeting.polls.get(req.params.pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!poll.isActive) return res.status(400).json({ error: 'Poll is closed' });
  const { optionId, participantId } = req.body;
  if (!optionId || !poll.options.find(o => o.id === optionId)) return res.status(400).json({ error: 'Invalid option' });
  poll.votes.set(participantId || req.apiUser?.userId?.toString() || 'api', optionId);
  const results = poll.options.map(o => ({ ...o, count: [...poll.votes.values()].filter(v => v === o.id).length }));
  io.to(req.meeting.id).emit('poll:updated', { pollId: poll.id, results, totalVotes: poll.votes.size });
  res.json({ voted: true });
});
app.post('/api/meetings/:meetingId/polls/:pollId/end', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const poll = req.meeting.polls.get(req.params.pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  poll.isActive = false;
  const results = poll.options.map(o => ({ ...o, count: [...poll.votes.values()].filter(v => v === o.id).length }));
  io.to(req.meeting.id).emit('poll:ended', { pollId: poll.id, results, totalVotes: poll.votes.size });
  res.json({ pollId: poll.id, results, totalVotes: poll.votes.size });
});
app.get('/api/meetings/:meetingId/polls', authApi, findMeeting, (req, res) => {
  const polls = [...req.meeting.polls.values()].map(p => ({
    id: p.id, question: p.question, options: p.options, isActive: p.isActive, totalVotes: p.votes.size,
    results: p.options.map(o => ({ ...o, count: [...p.votes.values()].filter(v => v === o.id).length })),
  }));
  res.json({ polls });
});

// ─── Q&A ──────────────────────────────────────────────────────────────────────
app.post('/api/meetings/:meetingId/questions', authApi, findMeeting, (req, res) => {
  const { text, participantName } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const questionId = crypto.randomUUID();
  const question = { id: questionId, text: text.trim().slice(0, 500), askedBy: { name: (participantName || 'Anonymous').slice(0, 60) }, upvotes: new Set(), isAnswered: false, answer: null, answeredBy: null, createdAt: Date.now(), dismissed: false };
  req.meeting.questions.set(questionId, question);
  io.to(req.meeting.id).emit('qa:new', { id: question.id, text: question.text, askedBy: question.askedBy, upvoteCount: 0, isAnswered: false, createdAt: question.createdAt });
  trackEvent(req.apiUser?.userId, req.apiUser?.companyId, 'feature.qa', { action: 'ask' });
  res.status(201).json({ questionId: question.id });
});
app.post('/api/meetings/:meetingId/questions/:questionId/upvote', authApi, findMeeting, (req, res) => {
  const q = req.meeting.questions.get(req.params.questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const voterId = req.body.participantId || req.apiUser?.userId?.toString() || 'api';
  if (q.upvotes.has(voterId)) q.upvotes.delete(voterId); else q.upvotes.add(voterId);
  io.to(req.meeting.id).emit('qa:updated', { questionId: q.id, upvoteCount: q.upvotes.size });
  res.json({ upvoteCount: q.upvotes.size });
});
app.post('/api/meetings/:meetingId/questions/:questionId/answer', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const q = req.meeting.questions.get(req.params.questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  q.isAnswered = true; q.answer = (req.body.answer || '').slice(0, 1000); q.answeredBy = (req.body.answeredBy || 'Host').slice(0, 60);
  io.to(req.meeting.id).emit('qa:updated', { questionId: q.id, isAnswered: true, answer: q.answer, answeredBy: q.answeredBy });
  res.json({ answered: true });
});
app.post('/api/meetings/:meetingId/questions/:questionId/dismiss', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const q = req.meeting.questions.get(req.params.questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  q.dismissed = true;
  io.to(req.meeting.id).emit('qa:updated', { questionId: q.id, dismissed: true });
  res.json({ dismissed: true });
});
app.get('/api/meetings/:meetingId/questions', authApi, findMeeting, (req, res) => {
  const questions = [...req.meeting.questions.values()].filter(q => !q.dismissed)
    .map(q => ({ id: q.id, text: q.text, askedBy: q.askedBy, upvoteCount: q.upvotes.size, isAnswered: q.isAnswered, answer: q.answer, answeredBy: q.answeredBy, createdAt: q.createdAt }))
    .sort((a, b) => b.upvoteCount - a.upvoteCount);
  res.json({ questions });
});

// ─── Meeting Notes ────────────────────────────────────────────────────────────
app.get('/api/meetings/:meetingId/notes', authApi, findMeeting, (req, res) => {
  res.json({ content: req.meeting.notes.content, lastUpdatedBy: req.meeting.notes.lastUpdatedBy, lastUpdatedAt: req.meeting.notes.lastUpdatedAt });
});
app.put('/api/meetings/:meetingId/notes', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  if (typeof req.body.content !== 'string') return res.status(400).json({ error: 'content required' });
  req.meeting.notes.content = req.body.content.slice(0, 50000);
  req.meeting.notes.lastUpdatedBy = 'Host'; req.meeting.notes.lastUpdatedAt = Date.now();
  io.to(req.meeting.id).emit('notes:updated', { content: req.meeting.notes.content, lastUpdatedBy: 'Host' });
  pool.query(`INSERT INTO meeting_notes (meeting_id, content, updated_by) VALUES ($1,$2,$3) ON CONFLICT (meeting_id) DO UPDATE SET content=$2, updated_by=$3, updated_at=NOW()`,
    [req.meeting.id, req.meeting.notes.content, 'Host']).catch(err => console.error('notes save:', err.message));
  trackEvent(req.apiUser?.userId, req.apiUser?.companyId, 'feature.meeting_notes', {});
  res.json({ updated: true });
});

// ─── File sharing ─────────────────────────────────────────────────────────────
app.post('/api/meetings/:meetingId/files', authApiOrSession, (req, res) => {
  const meeting = meetings.get(req.params.meetingId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  fileUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const participantName = (req.body.participantName || 'Unknown').slice(0, 60);
    try {
      const { rows } = await pool.query(
        `INSERT INTO meeting_files (meeting_id, participant_name, filename, original_name, size_bytes, mime_type, storage_path) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, original_name, size_bytes, mime_type, created_at`,
        [req.params.meetingId, participantName, req.file.filename, req.file.originalname.slice(0, 255), req.file.size, req.file.mimetype, req.file.filename]);
      io.to(req.params.meetingId).emit('chat:file', { fileId: rows[0].id, name: rows[0].original_name, size: rows[0].size_bytes, mimeType: rows[0].mime_type, sender: participantName, timestamp: Date.now() });
      trackEvent(req.apiUser?.userId || req.session?.userId, null, 'feature.file_share', { size: req.file.size });
      res.status(201).json(rows[0]);
    } catch (dbErr) { console.error('File save error:', dbErr); res.status(500).json({ error: 'Failed to save file' }); }
  });
});
app.get('/api/meetings/:meetingId/files', authApiOrSession, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, original_name, size_bytes, mime_type, participant_name, created_at FROM meeting_files WHERE meeting_id=$1 ORDER BY created_at', [req.params.meetingId]);
    res.json({ files: rows });
  } catch (_err) { res.status(500).json({ error: 'Failed to list files' }); }
});
app.get('/api/meetings/files/:fileId/download', authApiOrSession, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT original_name, storage_path, mime_type FROM meeting_files WHERE id=$1', [req.params.fileId]);
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(FILES_DIR, rows[0].storage_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].original_name}"`);
    if (rows[0].mime_type) res.setHeader('Content-Type', rows[0].mime_type);
    res.sendFile(filePath);
  } catch (_err) { res.status(500).json({ error: 'Failed to download file' }); }
});

// ─── Attendance ───────────────────────────────────────────────────────────────
app.get('/api/meetings/:meetingId/attendance', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const report = (req.meeting.attendance || []).map(a => ({
    participantId: a.participantId, name: a.name,
    joinedAt: new Date(a.joinedAt).toISOString(),
    leftAt: a.leftAt ? new Date(a.leftAt).toISOString() : null,
    durationSeconds: a.leftAt ? Math.round((a.leftAt - a.joinedAt) / 1000) : Math.round((Date.now() - a.joinedAt) / 1000),
  }));
  res.json({ attendance: report, meetingId: req.meeting.id, title: req.meeting.title });
});
app.get('/api/meetings/:meetingId/attendance/download', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const lines = ['Name,Joined,Left,Duration (seconds)'];
  for (const a of (req.meeting.attendance || [])) {
    const dur = a.leftAt ? Math.round((a.leftAt - a.joinedAt) / 1000) : Math.round((Date.now() - a.joinedAt) / 1000);
    lines.push(`"${a.name}","${new Date(a.joinedAt).toISOString()}","${a.leftAt ? new Date(a.leftAt).toISOString() : 'Still in meeting'}",${dur}`);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${req.meeting.id}.csv"`);
  res.send(lines.join('\n'));
});

// ─── Meeting Templates ────────────────────────────────────────────────────────
app.get('/api/templates', authApiOrSession, async (req, res) => {
  const userId = req.apiUser?.userId || req.session?.userId;
  try {
    const { rows } = await pool.query(`SELECT id, name, description, settings, is_default, created_at FROM meeting_templates WHERE user_id=$1 OR is_default=TRUE ORDER BY is_default DESC, name`, [userId || null]);
    res.json({ templates: rows });
  } catch (_err) { res.status(500).json({ error: 'Failed to list templates' }); }
});
app.post('/api/templates', requireUserSession, async (req, res) => {
  const { name, description, settings } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(`INSERT INTO meeting_templates (user_id, name, description, settings) VALUES ($1,$2,$3,$4) RETURNING id, name, description, settings, created_at`,
      [req.session.userId, (name + '').slice(0, 100), (description || '').slice(0, 500), JSON.stringify(settings || {})]);
    res.status(201).json(rows[0]);
  } catch (_err) { res.status(500).json({ error: 'Failed to create template' }); }
});
app.put('/api/templates/:id', requireUserSession, async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE meeting_templates SET name=COALESCE($1,name), description=COALESCE($2,description), settings=COALESCE($3,settings) WHERE id=$4 AND user_id=$5 RETURNING id, name, description, settings`,
      [req.body.name?.slice(0, 100), req.body.description?.slice(0, 500), req.body.settings ? JSON.stringify(req.body.settings) : null, req.params.id, req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  } catch (_err) { res.status(500).json({ error: 'Failed to update template' }); }
});
app.delete('/api/templates/:id', requireUserSession, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM meeting_templates WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Template not found' });
  res.json({ deleted: true });
});

// ─── Recurring Meetings ───────────────────────────────────────────────────────
function computeNextOccurrence(recurrence, dayOfWeek, dayOfMonth, timeUtc) {
  const now = new Date();
  const [hours, minutes] = timeUtc.split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(hours, minutes, 0, 0);
  if (recurrence === 'daily') { if (next <= now) next.setUTCDate(next.getUTCDate() + 1); }
  else if (recurrence === 'weekly') { const d = (dayOfWeek ?? 1); const diff = (d - next.getUTCDay() + 7) % 7; next.setUTCDate(next.getUTCDate() + (diff === 0 && next <= now ? 7 : diff)); }
  else if (recurrence === 'biweekly') { const d = (dayOfWeek ?? 1); const diff = (d - next.getUTCDay() + 7) % 7; next.setUTCDate(next.getUTCDate() + (diff === 0 && next <= now ? 14 : diff)); }
  else if (recurrence === 'monthly') { const d = dayOfMonth ?? 1; next.setUTCDate(d); if (next <= now) next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(d); }
  return next;
}
app.get('/api/meetings/recurring', authApiOrSession, async (req, res) => {
  const userId = req.apiUser?.userId || req.session?.userId;
  try {
    const { rows } = await pool.query(`SELECT id, title, recurrence, day_of_week, day_of_month, time_utc, timezone, settings, meeting_id, is_active, next_occurrence, created_at FROM recurring_meetings WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    res.json({ recurringMeetings: rows });
  } catch (_err) { res.status(500).json({ error: 'Failed to list recurring meetings' }); }
});
app.post('/api/meetings/recurring', authApiOrSession, async (req, res) => {
  const userId = req.apiUser?.userId || req.session?.userId;
  const companyId = req.apiUser?.companyId || req.session?.companyId || null;
  const { title, recurrence, dayOfWeek, dayOfMonth, timeUtc, timezone, settings } = req.body;
  if (!title || !recurrence || !timeUtc) return res.status(400).json({ error: 'title, recurrence, and timeUtc required' });
  if (!['daily', 'weekly', 'biweekly', 'monthly'].includes(recurrence)) return res.status(400).json({ error: 'Invalid recurrence' });
  const meetingId = generateMeetingId(), adminToken = uuidv4();
  const nextOccurrence = computeNextOccurrence(recurrence, dayOfWeek, dayOfMonth, timeUtc);
  try {
    const { rows } = await pool.query(
      `INSERT INTO recurring_meetings (user_id, company_id, title, recurrence, day_of_week, day_of_month, time_utc, timezone, settings, meeting_id, admin_token, next_occurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, title, recurrence, meeting_id, admin_token, next_occurrence`,
      [userId, companyId, (title + '').slice(0, 100), recurrence, dayOfWeek ?? null, dayOfMonth ?? null, timeUtc, timezone || 'UTC', JSON.stringify(settings || {}), meetingId, adminToken, nextOccurrence]);
    trackEvent(userId, companyId, 'feature.recurring_meeting', { recurrence });
    res.status(201).json({ ...rows[0], joinUrl: `/join/${meetingId}` });
  } catch (err) { console.error('recurring create:', err); res.status(500).json({ error: 'Failed to create recurring meeting' }); }
});
app.put('/api/meetings/recurring/:id', authApiOrSession, async (req, res) => {
  const userId = req.apiUser?.userId || req.session?.userId;
  try {
    const { rows } = await pool.query(
      `UPDATE recurring_meetings SET title=COALESCE($1,title), recurrence=COALESCE($2,recurrence), day_of_week=COALESCE($3,day_of_week), day_of_month=COALESCE($4,day_of_month), time_utc=COALESCE($5,time_utc), timezone=COALESCE($6,timezone), settings=COALESCE($7,settings), is_active=COALESCE($8,is_active) WHERE id=$9 AND user_id=$10 RETURNING *`,
      [req.body.title?.slice(0, 100), req.body.recurrence, req.body.dayOfWeek, req.body.dayOfMonth, req.body.timeUtc, req.body.timezone, req.body.settings ? JSON.stringify(req.body.settings) : null, req.body.isActive, req.params.id, userId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (_err) { res.status(500).json({ error: 'Failed to update recurring meeting' }); }
});
app.delete('/api/meetings/recurring/:id', authApiOrSession, async (req, res) => {
  const userId = req.apiUser?.userId || req.session?.userId;
  const { rowCount } = await pool.query('DELETE FROM recurring_meetings WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

// ─── Recurring meeting activation ────────────────────────────────────────────
const recurringMeetingPoller = setInterval(async () => {
  try {
    const { rows } = await pool.query(`SELECT * FROM recurring_meetings WHERE is_active=TRUE AND next_occurrence <= NOW()`);
    for (const rm of rows) {
      if (!meetings.has(rm.meeting_id)) {
        const s = typeof rm.settings === 'string' ? JSON.parse(rm.settings) : (rm.settings || {});
        const meeting = {
          id: rm.meeting_id, adminToken: rm.admin_token, title: rm.title, createdAt: Date.now(),
          participants: new Map(), waitingRoom: new Map(), peakParticipants: 0, logId: null,
          ownerId: rm.user_id, ownerCompanyId: rm.company_id,
          settings: { muteOnJoin: s.muteOnJoin ?? false, videoOffOnJoin: s.videoOffOnJoin ?? false, maxParticipants: s.maxParticipants ?? 50, locked: false, waitingRoom: s.waitingRoom ?? false },
          attendance: [], polls: new Map(), questions: new Map(), notes: { content: '', lastUpdatedBy: '', lastUpdatedAt: null },
        };
        meetings.set(rm.meeting_id, meeting);
        pool.query(`INSERT INTO meetings_log (meeting_id, title, user_id, company_id) VALUES ($1,$2,$3,$4) RETURNING id`,
          [rm.meeting_id, rm.title, rm.user_id, rm.company_id]).then(({ rows: lr }) => { meeting.logId = lr[0].id; }).catch(err => console.error('recurring log:', err.message));
      }
      const nextOcc = computeNextOccurrence(rm.recurrence, rm.day_of_week, rm.day_of_month, rm.time_utc?.toString() || '09:00');
      pool.query(`UPDATE recurring_meetings SET next_occurrence=$1 WHERE id=$2`, [nextOcc, rm.id]).catch(() => {});
    }
  } catch (err) { console.error('recurringMeetingPoller error:', err.message); }
}, 60000);

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

// ─── Auth: API key or session ────────────────────────────────────────────────
function authApiOrSession(req, res, next) {
  if (req.session?.userId) return next();
  return authApi(req, res, next);
}

// ─── Chat transcript ─────────────────────────────────────────────────────────
app.get('/api/meetings/:meetingId/transcript', authApiOrSession, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT participant_name, text, created_at FROM chat_messages WHERE meeting_id = $1 ORDER BY created_at ASC',
      [req.params.meetingId]
    );
    res.json({ messages: rows });
  } catch (err) {
    console.error('Transcript fetch error:', err);
    res.status(500).json({ error: 'Failed to load transcript' });
  }
});

app.get('/api/meetings/:meetingId/transcript/download', authApiOrSession, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT participant_name, text, created_at FROM chat_messages WHERE meeting_id = $1 ORDER BY created_at ASC',
      [req.params.meetingId]
    );
    const lines = rows.map(r => {
      const t = new Date(r.created_at);
      const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
      return `[${ts}] ${r.participant_name}: ${r.text}`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${req.params.meetingId}.txt"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Transcript download error:', err);
    res.status(500).json({ error: 'Failed to download transcript' });
  }
});

// ─── Recording upload & download ─────────────────────────────────────────────
app.post('/api/meetings/:meetingId/recordings', authApiOrSession, (req, res) => {
  upload.single('recording')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO recordings (meeting_id, user_id, filename, size_bytes, storage_path)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, size_bytes, created_at`,
        [req.params.meetingId, req.apiUser?.userId || req.session?.userId || null, req.file.originalname.slice(0, 255),
         req.file.size, req.file.filename]
      );
      res.status(201).json(rows[0]);
    } catch (dbErr) {
      console.error('Recording save error:', dbErr);
      res.status(500).json({ error: 'Failed to save recording' });
    }
  });
});

app.get('/api/meetings/:meetingId/recordings', authApiOrSession, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, filename, size_bytes, created_at FROM recordings WHERE meeting_id = $1 ORDER BY created_at DESC',
      [req.params.meetingId]
    );
    res.json({ recordings: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

app.get('/api/recordings/:id/download', authApiOrSession, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename, storage_path FROM recordings WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Recording not found' });
    const filePath = path.join(UPLOADS_DIR, rows[0].storage_path);
    if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR))) return res.status(403).json({ error: 'Invalid path' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].filename}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Failed to download recording' });
  }
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
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  // Block SSRF: reject private/loopback/link-local hostnames
  const host = parsedUrl.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host) ||
      host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return res.status(400).json({ error: 'Webhook URL must not point to private/internal addresses' });
  }
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Webhook URL must use http or https' });
  }
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
  const keyHash = await bcrypt.hash(rawKey, 12);
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
    const [totals, eventCounts] = await Promise.all([
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
      // Single query with conditional aggregation instead of 3 separate queries
      pool.query(`SELECT
        SUM(CASE WHEN created_at > NOW() - INTERVAL '1 day' THEN 1 ELSE 0 END) AS events_1d,
        SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) AS events_7d,
        COUNT(*) AS events_30d
        FROM analytics_events WHERE created_at > NOW() - INTERVAL '30 days'
      `),
    ]);
    res.json({ ...totals.rows[0], ...eventCounts.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/events', requireAdminSession, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
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
  const days = Math.min(parseInt(req.query.days) || 30, 365);
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
    // Pre-aggregate in subqueries to avoid cartesian product from 5 LEFT JOINs
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.account_type, u.created_at,
             COALESCE(ml.meeting_count, 0) AS meeting_count,
             COALESCE(ml.total_minutes, 0) AS total_minutes,
             COALESCE(ct.credits_spent, 0) AS credits_spent,
             COALESCE(ak.api_key_count, 0) AS api_key_count,
             COALESCE(wh.webhook_count, 0) AS webhook_count,
             ae.last_active
      FROM users u
      LEFT JOIN (SELECT user_id, COUNT(*) AS meeting_count, COALESCE(SUM(duration_minutes),0) AS total_minutes FROM meetings_log GROUP BY user_id) ml ON ml.user_id = u.id
      LEFT JOIN (SELECT user_id, COALESCE(SUM(ABS(amount_usd)),0) AS credits_spent FROM credit_transactions WHERE type = 'meeting_charge' GROUP BY user_id) ct ON ct.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS api_key_count FROM api_keys WHERE is_active = TRUE GROUP BY user_id) ak ON ak.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS webhook_count FROM webhooks GROUP BY user_id) wh ON wh.user_id = u.id
      LEFT JOIN (SELECT user_id, MAX(created_at) AS last_active FROM analytics_events GROUP BY user_id) ae ON ae.user_id = u.id
      WHERE u.is_admin = FALSE
      ORDER BY COALESCE(ml.meeting_count, 0) DESC, u.created_at DESC
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
    // Find recent non-expired, unused keys (limit scope to reduce bcrypt iterations)
    const { rows } = await pool.query(`
      SELECT sk.id, sk.user_id, sk.key_hash, sk.expires_at, u.email, u.account_type, u.created_at AS user_created
      FROM support_keys sk JOIN users u ON u.id = sk.user_id
      WHERE sk.expires_at > NOW() AND sk.used_at IS NULL AND sk.created_at > NOW() - INTERVAL '7 days'
      ORDER BY sk.created_at DESC LIMIT 100
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

// ─── Analytics endpoints ──────────────────────────────────────────────────────
app.get('/admin/api/analytics/features', requireAdminSession, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    const { rows } = await pool.query(`
      SELECT event_type AS feature,
             COUNT(*) AS total_uses,
             COUNT(DISTINCT user_id) AS unique_users,
             COUNT(DISTINCT DATE(created_at)) AS active_days
      FROM analytics_events
      WHERE event_type LIKE 'feature.%'
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY event_type ORDER BY total_uses DESC
    `, [days]);
    res.json({ features: rows, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/errors', requireAdminSession, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    const { rows } = await pool.query(`
      SELECT event_type,
             meta->>'route' AS route,
             meta->>'message' AS message,
             COUNT(*) AS count,
             MAX(created_at) AS last_seen
      FROM analytics_events
      WHERE event_type LIKE 'error.%'
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY event_type, meta->>'route', meta->>'message'
      ORDER BY count DESC LIMIT 50
    `, [days]);
    res.json({ errors: rows, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/realtime', requireAdminSession, (_req, res) => {
  let totalParticipants = 0, activeRecordings = 0, activeScreenShares = 0;
  const meetingList = [];
  for (const [id, m] of meetings) {
    const pCount = m.participants.size;
    totalParticipants += pCount;
    if (m.isRecording) activeRecordings++;
    for (const p of m.participants.values()) {
      if (p.isScreenSharing) activeScreenShares++;
    }
    meetingList.push({
      id, title: m.title || 'Untitled',
      participantCount: pCount,
      duration: Math.round((Date.now() - m.createdAt) / 60000),
      isRecording: m.isRecording || false,
    });
  }
  res.json({
    activeMeetings: meetings.size,
    totalParticipants, activeRecordings, activeScreenShares,
    meetingList: meetingList.sort((a,b) => b.participantCount - a.participantCount).slice(0, 20),
  });
});

app.get('/admin/api/analytics/retention', requireAdminSession, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH weekly AS (
        SELECT DISTINCT user_id, DATE_TRUNC('week', started_at)::date AS week
        FROM meetings_log WHERE user_id IS NOT NULL
      )
      SELECT w1.week,
             COUNT(DISTINCT w1.user_id) AS users,
             COUNT(DISTINCT w2.user_id) AS retained
      FROM weekly w1
      LEFT JOIN weekly w2 ON w1.user_id = w2.user_id AND w2.week = w1.week + INTERVAL '1 week'
      WHERE w1.week > NOW() - INTERVAL '12 weeks'
      GROUP BY w1.week ORDER BY w1.week
    `);
    res.json({ retention: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/analytics/health', requireAdminSession, (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    dbPoolTotal: pool.totalCount,
    dbPoolIdle: pool.idleCount,
    dbPoolWaiting: pool.waitingCount,
    activeMeetings: meetings.size,
    scheduledMeetings: scheduledMeetings.size,
  });
});

app.get('/admin/api/analytics/peak-hours', requireAdminSession, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 90, 365);
  try {
    const { rows } = await pool.query(`
      SELECT EXTRACT(DOW FROM started_at) AS dow,
             EXTRACT(HOUR FROM started_at) AS hour,
             COUNT(*) AS count
      FROM meetings_log
      WHERE started_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY dow, hour ORDER BY dow, hour
    `, [days]);
    res.json({ peakHours: rows, days });
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
// ─── HTML routes (no-cache to prevent stale code after deploys) ──────────────
const sendHtml = (file) => (_req, res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(path.join(__dirname, 'public', file)); };
app.get('/',         sendHtml('index.html'));
app.get('/docs',     sendHtml('docs.html'));
app.get('/register', sendHtml('register.html'));
app.get('/reset',    sendHtml('reset.html'));
app.get('/dashboard', sendHtml('dashboard.html'));
app.get('/billing',  requireUserSession, sendHtml('billing.html'));
app.get('/join/:meetingId', sendHtml('meeting.html'));

app.get('/admin', (req, res) => {
  if (req.session?.userId && req.session?.isAdmin) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin/dashboard', requireAdminSession, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Socket.IO rate limiting ─────────────────────────────────────────────────
function createSocketRateLimiter(maxEvents, windowMs) {
  const buckets = new Map(); // socketId → [timestamps]
  return {
    check(socketId) {
      const now = Date.now();
      let timestamps = buckets.get(socketId);
      if (!timestamps) { timestamps = []; buckets.set(socketId, timestamps); }
      // Remove expired timestamps
      while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
      if (timestamps.length >= maxEvents) return false;
      timestamps.push(now);
      return true;
    },
    cleanup(socketId) { buckets.delete(socketId); },
  };
}

const chatLimiter     = createSocketRateLimiter(10, 10000); // 10 msgs / 10s
const reactLimiter    = createSocketRateLimiter(5,  10000); // 5 reactions / 10s
const chatReactLimiter = createSocketRateLimiter(10, 10000);
const captionLimiter  = createSocketRateLimiter(20, 10000); // 20 updates / 10s
const handLimiter     = createSocketRateLimiter(5,  10000);

// ─── Socket.IO signaling ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  log('info', 'ws:connect', { sid: socket.id, ip: socket.handshake.address });
  // Idle timeout: disconnect sockets that don't join a meeting within 30s
  const idleTimer = setTimeout(() => {
    if (!currentMeetingId && !currentWaitingRoomId) {
      log('info', 'ws:idle-timeout', { sid: socket.id });
      socket.disconnect(true);
    }
  }, 30000);
  let currentMeetingId      = null;
  let currentParticipantId  = null;
  let currentWaitingRoomId  = null; // set while in waiting room, cleared on admit/deny/join
  let currentUserId         = null;
  let currentCompanyId      = null;

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
    if (meeting.attendance) meeting.attendance.push({ participantId, name: safeName, joinedAt: Date.now(), leftAt: null });
    // Cancel grace-period timer if someone rejoins within 60s
    if (meeting.gracePeriodTimer) { clearTimeout(meeting.gracePeriodTimer); meeting.gracePeriodTimer = null; }
    if (meeting.participants.size > (meeting.peakParticipants || 0)) {
      meeting.peakParticipants = meeting.participants.size;
    }
    socket.join(meetingId);
    clearTimeout(idleTimer);
    currentMeetingId     = meetingId;
    currentParticipantId = participantId;
    log('info', 'ws:join', { sid: socket.id, meeting: meetingId, name: safeName, pid: participantId });

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
      isRecording: meeting.isRecording || false,
      recordingHostName: meeting.recordingHostName || '',
    });

    socket.to(meetingId).emit('participant:joined', {
      participantId, name: participant.name,
      isMuted: participant.isMuted, isVideoOff: participant.isVideoOff,
      isHandRaised: false, isAdmin: participant.isAdmin,
    });

    // Fire participant.joined webhook (fire-and-forget) — use cached owner IDs
    if (meeting.logId && meeting.ownerId) {
      currentUserId = meeting.ownerId;
      currentCompanyId = meeting.ownerCompanyId;
      trackEvent(currentUserId, currentCompanyId, 'meeting.participant_joined', { meetingId, participantCount: meeting.participants.size }).catch(() => {});
      deliverWebhook(meeting.logId, meeting.ownerId, meeting.ownerCompanyId, 'participant.joined', {
        meetingId, participantId, name: participant.name,
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
    clearTimeout(idleTimer);
    currentWaitingRoomId = mid;
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
    trackEvent(currentUserId, currentCompanyId, 'feature.waiting_room', { action: 'admit' });
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
    trackEvent(currentUserId, currentCompanyId, 'feature.waiting_room', { action: 'deny' });
  });

  // Helper: get breakout room ID for a participant (null if in main room)
  function getBreakoutRoomOf(meeting, pid) {
    if (!meeting.breakoutRooms) return null;
    for (const [roomId, r] of meeting.breakoutRooms) {
      if (r.participants.has(pid)) return roomId;
    }
    return null;
  }

  // Helper: check if two participants can signal each other (same room)
  function canSignal(meeting, pidA, pidB) {
    if (!meeting.breakoutRooms) return true; // no breakout rooms = everyone can signal
    return getBreakoutRoomOf(meeting, pidA) === getBreakoutRoomOf(meeting, pidB);
  }

  socket.on('signal:offer', ({ to, offer }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const target = meeting.participants.get(to);
    if (target && canSignal(meeting, currentParticipantId, to)) {
      io.to(target.socketId).emit('signal:offer', { from: currentParticipantId, offer });
    }
  });

  socket.on('signal:answer', ({ to, answer }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const target = meeting.participants.get(to);
    if (target && canSignal(meeting, currentParticipantId, to)) {
      io.to(target.socketId).emit('signal:answer', { from: currentParticipantId, answer });
    }
  });

  socket.on('signal:ice-candidate', ({ to, candidate }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const target = meeting.participants.get(to);
    if (target && canSignal(meeting, currentParticipantId, to)) {
      io.to(target.socketId).emit('signal:ice-candidate', { from: currentParticipantId, candidate });
    }
  });

  socket.on('media:toggle-audio', ({ isMuted }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    p.isMuted = isMuted;
    // Broadcast only to participants in the same breakout room (or main room)
    const myRoom = getBreakoutRoomOf(meeting, currentParticipantId);
    if (myRoom) {
      io.to(`breakout:${currentMeetingId}:${myRoom}`).emit('participant:updated', { participantId: currentParticipantId, isMuted });
    } else {
      socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isMuted });
    }
  });

  socket.on('media:toggle-video', ({ isVideoOff }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    p.isVideoOff = isVideoOff;
    const myRoom = getBreakoutRoomOf(meeting, currentParticipantId);
    if (myRoom) {
      io.to(`breakout:${currentMeetingId}:${myRoom}`).emit('participant:updated', { participantId: currentParticipantId, isVideoOff });
    } else {
      socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isVideoOff });
    }
  });

  socket.on('media:screen-share', ({ isScreenSharing }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) { p.isScreenSharing = isScreenSharing; socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isScreenSharing }); }
    trackEvent(currentUserId, currentCompanyId, 'feature.screen_share', { action: isScreenSharing ? 'start' : 'stop' });
  });

  socket.on('raise-hand', ({ isHandRaised }) => {
    if (!handLimiter.check(socket.id)) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) {
      p.isHandRaised = isHandRaised;
      p.handRaisedAt = isHandRaised ? Date.now() : null;
      io.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isHandRaised, handRaisedAt: p.handRaisedAt });
    }
    trackEvent(currentUserId, currentCompanyId, 'feature.hand_raise', { raised: isHandRaised });
  });

  socket.on('react', ({ emoji }) => {
    if (!reactLimiter.check(socket.id)) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    // Sanitize: only allow known emoji values
    const allowed = ['👍','❤️','😂','🎉','👏'];
    if (!allowed.includes(emoji)) return;
    io.to(currentMeetingId).emit('react', { participantId: currentParticipantId, emoji });
    trackEvent(currentUserId, currentCompanyId, 'feature.reaction', { emoji });
  });

  socket.on('recording:broadcast-started', ({ hostName }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const safeHost = (hostName || '').slice(0, 60);
    meeting.isRecording = true;
    meeting.recordingHostName = safeHost;
    meeting.recordingParticipantId = currentParticipantId;
    socket.to(currentMeetingId).emit('recording:started', { hostName: safeHost });
    trackEvent(currentUserId, currentCompanyId, 'feature.recording', { action: 'start' });
  });

  socket.on('recording:broadcast-stopped', () => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    meeting.isRecording = false;
    meeting.recordingHostName = '';
    meeting.recordingParticipantId = null;
    socket.to(currentMeetingId).emit('recording:stopped');
    trackEvent(currentUserId, currentCompanyId, 'feature.recording', { action: 'stop' });
  });

  socket.on('chat:message', ({ text, replyTo }) => {
    if (!chatLimiter.check(socket.id)) return socket.emit('error', { message: 'Rate limited — too many messages' });
    if (!text || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    const msgId = crypto.randomUUID();
    io.to(currentMeetingId).emit('chat:message', {
      from: currentParticipantId, name: p.name, text: trimmed,
      timestamp: Date.now(), msgId, replyTo: replyTo || null,
    });
    pool.query('INSERT INTO chat_messages (meeting_id, participant_name, text, reply_to) VALUES ($1,$2,$3,$4)',
      [currentMeetingId, p.name, trimmed, replyTo || null]).catch(() => {});
    trackEvent(currentUserId, currentCompanyId, 'feature.chat', { length: trimmed.length });
  });

  socket.on('chat:react', ({ msgId, emoji }) => {
    if (!chatReactLimiter.check(socket.id)) return;
    if (!currentMeetingId || !msgId || typeof emoji !== 'string') return;
    const safeEmoji = emoji.trim().slice(0, 4);
    if (!safeEmoji) return;
    socket.to(currentMeetingId).emit('chat:react', { pid: currentParticipantId, msgId, emoji: safeEmoji });
    trackEvent(currentUserId, currentCompanyId, 'feature.chat_reaction', { emoji: safeEmoji });
  });

  socket.on('captions:update', ({ pid, text, final }) => {
    if (!captionLimiter.check(socket.id)) return;
    if (!currentMeetingId || typeof text !== 'string') return;
    socket.to(currentMeetingId).emit('captions:update', {
      pid, text: text.slice(0, 300), final: !!final,
    });
    trackEvent(currentUserId, currentCompanyId, 'feature.captions', {});
  });

  // ─── Polls (socket) ──────────────────────────────────────────────────────────
  socket.on('poll:create', ({ question, options }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin) return;
    if (!question || !Array.isArray(options) || options.length < 2 || options.length > 10) return;
    const pollId = crypto.randomUUID();
    const poll = { id: pollId, question: (question + '').trim().slice(0, 500), options: options.slice(0, 10).map((o, i) => ({ id: `opt_${i}`, text: (o + '').trim().slice(0, 200) })), votes: new Map(), isActive: true, createdAt: Date.now() };
    meeting.polls.set(pollId, poll);
    io.to(currentMeetingId).emit('poll:created', { id: poll.id, question: poll.question, options: poll.options, isActive: true });
    trackEvent(currentUserId, currentCompanyId, 'feature.poll', { action: 'create' });
  });
  socket.on('poll:vote', ({ pollId, optionId }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const poll = meeting.polls.get(pollId);
    if (!poll || !poll.isActive || !poll.options.find(o => o.id === optionId)) return;
    poll.votes.set(currentParticipantId, optionId);
    const results = poll.options.map(o => ({ ...o, count: [...poll.votes.values()].filter(v => v === o.id).length }));
    io.to(currentMeetingId).emit('poll:updated', { pollId: poll.id, results, totalVotes: poll.votes.size });
  });
  socket.on('poll:end', ({ pollId }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin) return;
    const poll = meeting.polls.get(pollId);
    if (!poll) return;
    poll.isActive = false;
    const results = poll.options.map(o => ({ ...o, count: [...poll.votes.values()].filter(v => v === o.id).length }));
    io.to(currentMeetingId).emit('poll:ended', { pollId: poll.id, results, totalVotes: poll.votes.size });
  });

  // ─── Q&A (socket) ────────────────────────────────────────────────────────────
  socket.on('qa:ask', ({ text }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !text || typeof text !== 'string') return;
    const qId = crypto.randomUUID();
    const q = { id: qId, text: text.trim().slice(0, 500), askedBy: { participantId: currentParticipantId, name: p.name }, upvotes: new Set(), isAnswered: false, answer: null, answeredBy: null, createdAt: Date.now(), dismissed: false };
    meeting.questions.set(qId, q);
    io.to(currentMeetingId).emit('qa:new', { id: q.id, text: q.text, askedBy: q.askedBy, upvoteCount: 0, isAnswered: false, createdAt: q.createdAt });
    trackEvent(currentUserId, currentCompanyId, 'feature.qa', { action: 'ask' });
  });
  socket.on('qa:upvote', ({ questionId }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const q = meeting.questions.get(questionId);
    if (!q) return;
    if (q.upvotes.has(currentParticipantId)) q.upvotes.delete(currentParticipantId); else q.upvotes.add(currentParticipantId);
    io.to(currentMeetingId).emit('qa:updated', { questionId: q.id, upvoteCount: q.upvotes.size });
  });
  socket.on('qa:answer', ({ questionId, answer }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin) return;
    const q = meeting.questions.get(questionId);
    if (!q) return;
    q.isAnswered = true; q.answer = (answer || '').slice(0, 1000); q.answeredBy = p.name;
    io.to(currentMeetingId).emit('qa:updated', { questionId: q.id, isAnswered: true, answer: q.answer, answeredBy: q.answeredBy });
  });
  socket.on('qa:dismiss', ({ questionId }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin) return;
    const q = meeting.questions.get(questionId);
    if (!q) return;
    q.dismissed = true;
    io.to(currentMeetingId).emit('qa:updated', { questionId: q.id, dismissed: true });
  });

  // ─── Meeting Notes (socket) ───────────────────────────────────────────────────
  socket.on('notes:update', ({ content }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p?.isAdmin || typeof content !== 'string') return;
    meeting.notes.content = content.slice(0, 50000);
    meeting.notes.lastUpdatedBy = p.name; meeting.notes.lastUpdatedAt = Date.now();
    socket.to(currentMeetingId).emit('notes:updated', { content: meeting.notes.content, lastUpdatedBy: p.name });
    pool.query(`INSERT INTO meeting_notes (meeting_id, content, updated_by) VALUES ($1,$2,$3) ON CONFLICT (meeting_id) DO UPDATE SET content=$2, updated_by=$3, updated_at=NOW()`,
      [currentMeetingId, meeting.notes.content, p.name]).catch(err => console.error('notes save:', err.message));
  });

  // ─── Breakout rooms ────────────────────────────────────────────────────────
  socket.on('breakout:create', ({ rooms }) => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !p.isAdmin) return;
    if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 20) return;
    meeting.breakoutRooms = new Map();
    rooms.forEach((name, i) => {
      const roomId = `br-${i}`;
      meeting.breakoutRooms.set(roomId, {
        id: roomId,
        name: ((name || `Room ${i + 1}`) + '').slice(0, 60),
        participants: new Map(),
      });
    });
    io.to(currentMeetingId).emit('breakout:created', {
      rooms: [...meeting.breakoutRooms.values()].map(r => ({ id: r.id, name: r.name, participantCount: 0 })),
    });
    trackEvent(currentUserId, currentCompanyId, 'feature.breakout_rooms', { count: rooms.length });
  });

  socket.on('breakout:assign', ({ assignments }) => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting || !meeting.breakoutRooms) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !p.isAdmin) return;
    if (!Array.isArray(assignments)) return;
    // assignments: [{ participantId, roomId }]
    for (const { participantId: pid, roomId } of assignments) {
      const target = meeting.participants.get(pid);
      const room = meeting.breakoutRooms.get(roomId);
      if (!target || !room) continue;
      // Remove from previous breakout room
      for (const [, r] of meeting.breakoutRooms) r.participants.delete(pid);
      room.participants.set(pid, target);
      io.to(target.socketId).emit('breakout:assigned', { roomId, roomName: room.name });
    }
    // Broadcast updated room list
    io.to(currentMeetingId).emit('breakout:updated', {
      rooms: [...meeting.breakoutRooms.values()].map(r => ({
        id: r.id, name: r.name, participantCount: r.participants.size,
        participants: [...r.participants.values()].map(pt => ({ id: pt.id, name: pt.name })),
      })),
    });
  });

  socket.on('breakout:join', ({ roomId }) => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting || !meeting.breakoutRooms || meeting.closingBreakout) return;
    const room = meeting.breakoutRooms.get(roomId);
    if (!room) return;
    const breakoutRoomId = `breakout:${currentMeetingId}:${roomId}`;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    // Leave all other breakout rooms and update participant maps
    for (const [, r] of meeting.breakoutRooms) {
      const brId = `breakout:${currentMeetingId}:${r.id}`;
      socket.leave(brId);
      r.participants.delete(currentParticipantId);
    }
    // Join new room
    room.participants.set(currentParticipantId, p);
    socket.join(breakoutRoomId);
    // Signal to others in this breakout room
    socket.to(breakoutRoomId).emit('breakout:participant-joined', {
      participantId: currentParticipantId, roomId,
    });
  });

  socket.on('breakout:leave', () => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting || !meeting.breakoutRooms) return;
    for (const [, r] of meeting.breakoutRooms) {
      const brId = `breakout:${currentMeetingId}:${r.id}`;
      socket.leave(brId);
      socket.to(brId).emit('breakout:participant-left', { participantId: currentParticipantId });
    }
  });

  socket.on('breakout:broadcast', ({ message }) => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting || !meeting.breakoutRooms) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !p.isAdmin) return;
    const safeMsg = ((message || '') + '').trim().slice(0, 500);
    if (!safeMsg) return;
    // Broadcast to all breakout rooms
    for (const [, r] of meeting.breakoutRooms) {
      io.to(`breakout:${currentMeetingId}:${r.id}`).emit('breakout:message', {
        from: 'Host', text: safeMsg, timestamp: Date.now(),
      });
    }
  });

  socket.on('breakout:close', () => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting || !meeting.breakoutRooms) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !p.isAdmin) return;
    // Move everyone back to main room
    meeting.closingBreakout = true;
    for (const [, r] of meeting.breakoutRooms) {
      const brId = `breakout:${currentMeetingId}:${r.id}`;
      io.to(brId).emit('breakout:closed');
      io.in(brId).socketsLeave(brId);
      r.participants.clear();
    }
    meeting.breakoutRooms = null;
    meeting.closingBreakout = false;
    io.to(currentMeetingId).emit('breakout:all-closed');
  });

  // ─── Live streaming ────────────────────────────────────────────────────────
  socket.on('stream:start', ({ url }) => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    if (meeting.isStreaming) return socket.emit('error', { message: 'Stream already active' });
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !p.isAdmin) return;
    const safeUrl = ((url || '') + '').trim().slice(0, 500);
    if (!safeUrl) return;
    meeting.isStreaming = true;
    meeting.streamUrl = safeUrl;
    meeting.streamingParticipantId = currentParticipantId;
    io.to(currentMeetingId).emit('stream:started', { hostName: p.name });
    trackEvent(currentUserId, currentCompanyId, 'feature.live_stream', { started: true });
  });

  socket.on('stream:stop', () => {
    if (!currentMeetingId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p || !p.isAdmin) return;
    meeting.isStreaming = false;
    meeting.streamUrl = null;
    meeting.streamingParticipantId = null;
    io.to(currentMeetingId).emit('stream:stopped');
  });

  socket.on('disconnect', async () => {
    log('info', 'ws:disconnect', { sid: socket.id, meeting: currentMeetingId || undefined });
    // Clean up rate limiter state
    chatLimiter.cleanup(socket.id);
    reactLimiter.cleanup(socket.id);
    chatReactLimiter.cleanup(socket.id);
    captionLimiter.cleanup(socket.id);
    handLimiter.cleanup(socket.id);

    // Clean up waiting room entry if the socket disconnected while waiting
    if (currentWaitingRoomId) {
      const waitMeeting = meetings.get(currentWaitingRoomId);
      if (waitMeeting && waitMeeting.waitingRoom.has(socket.id)) {
        waitMeeting.waitingRoom.delete(socket.id);
        io.to(currentWaitingRoomId).emit('waiting-room:participant-waiting', {
          socketId: socket.id, name: '', count: waitMeeting.waitingRoom.size, removed: true,
        });
      }
    }
    if (!currentMeetingId || !currentParticipantId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    await removeParticipantFromMeeting(meeting, currentParticipantId, io);
  });
});

// ─── 404 catch-all (must be last route) ───────────────────────────────────────
app.use((_req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'error.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => {
      log('info', 'server:start', { port: PORT, url: `http://localhost:${PORT}` });
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  clearInterval(scheduledMeetingPoller);
  clearInterval(recurringMeetingPoller);
  for (const s of scheduledMeetings.values()) { if (s.timerId) clearTimeout(s.timerId); }

  // 1. Charge all active meetings before closing
  const chargePromises = [];
  for (const meeting of meetings.values()) {
    if (meeting.gracePeriodTimer) clearTimeout(meeting.gracePeriodTimer);
    io.to(meeting.id).emit('meeting:ended', { reason: 'Server shutting down' });
    if (meeting.logId) {
      chargePromises.push(
        chargeMeeting(meeting).catch(err => console.error('Shutdown charge failed for', meeting.id, err))
      );
    }
  }
  meetings.clear();

  // Clear scheduled meeting timers
  for (const s of scheduledMeetings.values()) {
    if (s.timerId) clearTimeout(s.timerId);
  }
  scheduledMeetings.clear();

  Promise.allSettled(chargePromises).then(() => {
    if (chargePromises.length) console.log(`Charged ${chargePromises.length} active meeting(s) before shutdown`);
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
  });

  // Force-exit after 30s if not done
  setTimeout(() => {
    console.error('Forced exit after shutdown timeout');
    process.exit(1);
  }, 30000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err.stack || err);
  process.exit(1);
});

// ─── Exports for testing ─────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'test') {
  module.exports = { app, server, io, meetings, scheduledMeetings, calculateMeetingCost };
}
