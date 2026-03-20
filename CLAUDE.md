# CLAUDE.md — meetingservice (onepizza.io)

## Project overview

onepizza.io is a SaaS video-meeting platform (Zoom/Meet-style). Users create meetings, share a link, and join via WebRTC. Features: video/audio, screen share, recording, chat, live captions, virtual backgrounds (MediaPipe ML), reactions, waiting room, and admin controls. Billing is usage-based (per-participant per-minute) charged at meeting end.

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 22 |
| HTTP | Express 4 |
| Real-time | Socket.IO 4 |
| Database | PostgreSQL (node-pg) |
| Auth | express-session + connect-pg-simple |
| Payments | Stripe + USDC (ethers.js) |
| Email | Resend (optional, graceful no-op if absent) |
| Frontend | Vanilla JS — single-file HTML pages, no build step |
| Deploy | Railway / Docker (Alpine) |

## Key files

| File | Role |
|---|---|
| `server.js` | Everything server-side: Express routes, Socket.IO handlers, billing, webhooks (~2100 lines) |
| `db.js` | PostgreSQL pool, schema init, settings cache |
| `email.js` | Transactional email templates (Resend) |
| `public/meeting.html` | Full meeting UI: WebRTC, Socket.IO client, MediaPipe, all meeting features (~2500 lines) |
| `public/dashboard.html` | User dashboard: create/manage meetings, API keys, billing |
| `public/admin.html` | Admin panel: users, companies, billing, analytics, settings |
| `public/styles.css` | Unified stylesheet for all pages |
| `.env.example` | All environment variable definitions |

## Development

```bash
npm run dev   # node --watch server.js (auto-reload)
npm start     # node server.js (production)
npm run lint  # ESLint (ignores public/)
```

**Minimum `.env` for local dev:**
```
DATABASE_PUBLIC_URL=postgres://...
SESSION_SECRET=any-local-string
```

The DB schema is auto-created on first start (`initDB()` in `db.js`). Default admin: `admin@example.com` / `Test321!`.

## Architecture

### In-memory meeting state

Meetings live in a `Map` in memory — they are NOT persisted to the DB during the session. Only billing data (`meetings_log`, `credit_transactions`) goes to the DB, written at meeting end.

```js
meetings = Map<meetingId, {
  id, adminToken, title, createdAt,
  participants: Map<participantId, Participant>,
  waitingRoom: Map<socketId, { socketId, name }>,
  settings: { muteOnJoin, videoOffOnJoin, maxParticipants, locked, waitingRoom },
  isRecording, recordingHostName, recordingParticipantId,
  peakParticipants, logId,
}>
```

### WebRTC signaling flow

1. Client connects via Socket.IO and emits `join-meeting`
2. Server validates and sends `joined` (list of current participants + settings)
3. Server broadcasts `participant:joined` to the room
4. Clients exchange SDP/ICE via `signal:offer`, `signal:answer`, `signal:ice-candidate`
5. On disconnect: 60s grace period, then meeting is charged and deleted

### Socket.IO room naming

- Active meeting: `meetingId` (e.g., `abc-defg-hij`)
- Waiting room: `waiting:${meetingId}`

### Auth layers

| Context | Mechanism |
|---|---|
| Web sessions | `req.session.userId` (cookie, PostgreSQL-backed) |
| REST API | `x-api-key` header → `api_keys` table |
| Meeting admin | `x-admin-token` header → `meeting.adminToken` (timing-safe compare) |
| Socket admin | `adminToken` sent in `join-meeting` event, validated server-side |

### Settings cache

`db.js` caches settings (feature flags, billing rates, etc.) in memory for 60 seconds. Access via `getSettings()`. After admin changes settings via `PATCH /admin/api/settings`, the cache is invalidated immediately.

## Coding conventions

### General
- **camelCase** for all JS variables, functions, and object keys
- **snake_case** for all PostgreSQL column names
- **async/await** everywhere — avoid raw `.then()` chains
- **Parameterized SQL** always — `pool.query('SELECT ... WHERE id = $1', [id])` — never interpolate
- Fire-and-forget pattern for non-critical ops: `somePromise().catch(() => {})`

### Error responses (HTTP)
```
200 OK, 201 Created, 400 Bad Request, 401 Unauthorized,
403 Forbidden, 404 Not Found, 409 Conflict, 500 Server Error, 503 Unavailable
```

### Security patterns to maintain
- **Timing-safe token comparison**: use `crypto.timingSafeEqual` for admin tokens (already in `requireMeetingAdmin` middleware)
- **Parameterized queries**: never string-interpolate user input into SQL
- **Input sanitization**: always `.trim().slice(0, N)` on user-supplied strings before storing
- **Meeting IDs**: generated with `crypto.randomBytes` (not `Math.random`)
- **Rate limiting**: auth/reset/guest endpoints are rate-limited; do not remove these

### Before every commit
- **Always** update `CHANGELOG.md` with a summary of changes under the current version heading
- Update the date in the `## [version] — date` heading to the current date and time
- If the version number in `package.json` changes, update the heading in `CHANGELOG.md` to match
- Group entries under `### Added`, `### Changed`, `### Fixed`, or `### Security` as appropriate

### Frontend (`public/*.html`)
- All frontend code is **inline JS in single HTML files** — no separate `.js` files, no bundler
- The `$()` helper is `document.querySelector` (defined at top of each file)
- ESLint does **not** run on `public/` — be careful with frontend code quality
- `meeting.html` uses Socket.IO client loaded from CDN and MediaPipe from JSDelivr CDN

## Domain knowledge

### Billing
- Rate: `cost = durationMinutes × peakParticipants × rate_per_participant_minute`
- Default rate: `$0.01` per participant per minute
- Credits deducted in `chargeMeeting()` called 60s after last participant leaves
- Both personal (`users.credits_usd`) and company (`companies.credits_usd`) accounts

### Feature flags
Settings in the `settings` DB table control feature availability. Check `getSettings()` before adding features that should be admin-toggleable. Current flags: `recording_enabled`, `screen_share_enabled`, `blur_enabled`, `captions_enabled`, `registration_enabled`, `guest_meetings_enabled`, `max_participants_default`, `meeting_cost_per_participant_minute`.

### Scheduled meetings
Stored in `scheduledMeetings` Map (in-memory, not DB). A `setInterval` every 15s calls `activateScheduledMeeting()` which moves them to the live `meetings` Map and deletes them from `scheduledMeetings`.

### Virtual backgrounds / blur
MediaPipe SelfieSegmentation runs in the browser. The processed canvas is captured as a `MediaStream` via `blurCanvas.captureStream(24)`. Peer track replacement uses `RTCRtpSender.replaceTrack()` wrapped in `Promise.allSettled`. The pipeline is started by `startBlur()` and stopped by `stopBlur()` which returns a Promise (await it in `setBgMode` to prevent race conditions).

### Push-to-talk
Space bar held while muted temporarily unmutes. `pushToTalkActive` flag prevents the mute button click from conflicting. Always check `if (pushToTalkActive) return;` before toggling mute state from the button.

## Common patterns

### Adding a new socket event (server-side)
```js
// Inside io.on('connection', ...) in server.js
socket.on('my:event', ({ param }) => {
  if (!currentMeetingId) return;                          // guard: not in meeting
  const meeting = meetings.get(currentMeetingId);
  if (!meeting) return;
  const p = meeting.participants.get(currentParticipantId);
  if (!p) return;
  // ... your logic ...
  socket.to(currentMeetingId).emit('my:event', { ... }); // relay to others
});
```

### Adding a new REST endpoint (API key auth)
```js
app.post('/api/meetings/:meetingId/my-action', authApi, requireMeetingAdmin, async (req, res) => {
  try {
    // req.meeting is set by requireMeetingAdmin middleware
    // req.apiUser is set by authApi middleware
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

### Adding a new client-side socket handler (`meeting.html`)
```js
socket.on('my:event', ({ data }) => {
  // ... handle event
  updateControlButtons(); // if UI state changed
  renderVideoGrid();      // if participant layout changed
});
```

### DB queries
```js
// Single row
const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
const user = rows[0]; // undefined if not found

// Multiple rows with error handling
const { rows } = await pool.query('SELECT ...').catch(() => ({ rows: [] }));

// Insert returning ID
const { rows } = await pool.query(
  'INSERT INTO table (col) VALUES ($1) RETURNING id', [value]
);
```

## What NOT to do

- Do not add `.js` files in `public/` — keep all frontend code inside the HTML files
- Do not use `Math.random()` for security-sensitive IDs — use `crypto.randomBytes` or `crypto.randomUUID()`
- Do not skip `Promise.allSettled` when doing `replaceTrack` across multiple peers — individual failures must not block others
- Do not call `stopBlur()` followed immediately by `startBlur()` without `await stopBlur()` first — causes a race condition with concurrent `replaceTrack` calls
- Do not string-interpolate user input into SQL queries
- Do not remove rate limiters from auth/reset/guest endpoints
- Do not store meeting participants in the database during the session — they live in the in-memory `meetings` Map only
- Do not `await` webhook delivery in request handlers — use fire-and-forget with `.catch(() => {})`
