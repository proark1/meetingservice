const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const { pool, initDB, getSettings } = require('./db');

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
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());

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
    } catch(err) { console.error('Credit add error:', err); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  if (!key) return res.status(401).json({ error: 'Invalid or missing API key' });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM api_keys WHERE key = $1 AND is_active = TRUE`, [key]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid or missing API key' });
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

// Checks x-admin-token for meeting-level admin actions
function requireMeetingAdmin(req, res, next) {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== req.meeting.adminToken) {
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
app.post('/api/auth/register', async (req, res) => {
  const { email, password, accountType, companyName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (accountType === 'company' && !companyName) return res.status(400).json({ error: 'Company name required' });

  try {
    const settings = await getSettings();
    if (settings.registration_enabled === 'false') {
      return res.status(403).json({ error: 'Registration is currently disabled' });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, account_type) VALUES ($1, $2, $3) RETURNING id, email, is_admin`,
      [email.toLowerCase().trim(), hash, accountType === 'company' ? 'company' : 'personal']
    );
    const user = rows[0];

    let companyId = null;
    let inviteCode = null;

    if (accountType === 'company') {
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
    res.json({ message: 'Account created', email: user.email, apiKey: key, inviteCode, accountType: accountType || 'personal' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, is_admin, is_active FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account is disabled' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.userId  = user.id;
    req.session.email   = user.email;
    req.session.isAdmin = user.is_admin;
    // Get company_id for session
    const { rows: compRows } = await pool.query(`SELECT company_id FROM users WHERE id = $1`, [user.id]);
    req.session.companyId = compRows[0]?.company_id || null;
    res.json({ message: 'Logged in', isAdmin: user.is_admin });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
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
});

app.delete('/api/user/keys/:id', requireUserSession, async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.session.userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ message: 'API key revoked' });
});

// ─── Admin Auth ───────────────────────────────────────────────────────────────
app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, is_active FROM users WHERE email = $1 AND is_admin = TRUE`,
      [email?.toLowerCase().trim()]
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
  req.session.destroy(() => res.redirect('/admin'));
});

// ─── Admin API ────────────────────────────────────────────────────────────────
app.get('/admin/api/stats', requireAdminSession, async (_req, res) => {
  const [users, keys] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE is_active = TRUE`),
    pool.query(`SELECT COUNT(*) AS cnt FROM api_keys WHERE is_active = TRUE`),
  ]);
  res.json({
    activeMeetings:  meetings.size,
    totalUsers:      parseInt(users.rows[0].cnt),
    activeApiKeys:   parseInt(keys.rows[0].cnt),
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
           COUNT(k.id) FILTER (WHERE k.is_active) AS active_key_count
    FROM users u
    LEFT JOIN api_keys k ON k.user_id = u.id
    GROUP BY u.id
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
  res.json({ message: 'Settings updated' });
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
  } catch(err) {
    res.status(500).json({ error: 'Failed to join company' });
  }
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
  const meeting    = {
    id,
    adminToken,
    title:    req.body.title || 'Untitled Meeting',
    createdAt: Date.now(),
    participants: new Map(),
    settings: {
      muteOnJoin:      req.body.muteOnJoin      ?? false,
      videoOffOnJoin:  req.body.videoOffOnJoin  ?? false,
      maxParticipants: req.body.maxParticipants ?? maxDefault,
      locked:          false,
    },
  };
  meetings.set(id, meeting);
  res.status(201).json({
    meetingId: id, adminToken, joinUrl: `/join/${id}`,
    title: meeting.title, settings: meeting.settings,
  });
});

app.get('/api/meetings', authApi, (_req, res) => {
  const list = [...meetings.values()].map(m => ({
    meetingId: m.id, title: m.title, createdAt: m.createdAt,
    participantCount: m.participants.size,
  }));
  res.json({ meetings: list });
});

app.get('/api/meetings/:meetingId', authApi, findMeeting, (req, res) => {
  const m = req.meeting;
  res.json({
    meetingId: m.id, title: m.title, createdAt: m.createdAt,
    participantCount: m.participants.size,
    participants: [...m.participants.values()].map(p => ({
      participantId: p.id, name: p.name, isMuted: p.isMuted,
      isVideoOff: p.isVideoOff, isScreenSharing: p.isScreenSharing, joinedAt: p.joinedAt,
    })),
    settings: m.settings,
  });
});

app.delete('/api/meetings/:meetingId', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  io.to(req.meeting.id).emit('meeting:ended', { reason: 'Meeting ended by admin' });
  meetings.delete(req.meeting.id);
  res.json({ message: 'Meeting ended' });
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

app.post('/api/meetings/:meetingId/participants/:participantId/kick', authApi, findMeeting, requireMeetingAdmin, (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  io.to(p.socketId).emit('admin:kick', { reason: req.body.reason || 'Removed by admin' });
  req.meeting.participants.delete(p.id);
  io.to(req.meeting.id).emit('participant:left', { participantId: p.id, name: p.name });
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

// ─── HTML Routes ──────────────────────────────────────────────────────────────
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/docs',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
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
    if (!meeting) return socket.emit('error', { message: 'Meeting not found' });

    if (meeting.settings.locked && !(isAdmin && adminToken === meeting.adminToken)) {
      return socket.emit('error', { message: 'Meeting is locked' });
    }
    if (meeting.participants.size >= meeting.settings.maxParticipants) {
      return socket.emit('error', { message: 'Meeting is full' });
    }

    const participantId = uuidv4().slice(0, 8);
    const participant   = {
      id: participantId, socketId: socket.id,
      name: name || 'Anonymous',
      isMuted:       meeting.settings.muteOnJoin,
      isVideoOff:    meeting.settings.videoOffOnJoin,
      isScreenSharing: false,
      isHandRaised:  false,
      isAdmin:       isAdmin && adminToken === meeting.adminToken,
      joinedAt:      Date.now(),
    };

    meeting.participants.set(participantId, participant);
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

  socket.on('chat:message', ({ text }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    io.to(currentMeetingId).emit('chat:message', {
      from: currentParticipantId, name: p.name, text, timestamp: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    if (!currentMeetingId || !currentParticipantId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    meeting.participants.delete(currentParticipantId);
    socket.to(currentMeetingId).emit('participant:left', {
      participantId: currentParticipantId, name: p ? p.name : 'Unknown',
    });
    if (meeting.participants.size === 0) {
      setTimeout(() => {
        const m = meetings.get(currentMeetingId);
        if (m && m.participants.size === 0) meetings.delete(currentMeetingId);
      }, 60000);
    }
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
