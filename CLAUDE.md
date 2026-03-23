# CLAUDE.md — meetingservice (onepizza.io)

## Project overview

onepizza.io is a SaaS video-meeting platform (Zoom/Meet-style). Users create meetings, share a link, and join via WebRTC. Features: video/audio, screen share, recording (with upload), chat (persisted), live captions, virtual backgrounds (MediaPipe ML), reactions, waiting room, admin controls, MCP server for AI agent integration, and comprehensive analytics. Billing is usage-based (per-participant per-minute) charged at meeting end.

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
| AI Integration | MCP server (Model Context Protocol) |
| Deploy | Railway / Docker (Alpine) |

## Key files

| File | Role |
|---|---|
| `server.js` | Everything server-side: Express routes, Socket.IO handlers, billing, webhooks, analytics (~2400 lines) |
| `db.js` | PostgreSQL pool, schema init (`initDB()`), settings cache with stampede protection |
| `email.js` | Transactional email templates (Resend) |
| `mcp-server.js` | MCP server for AI agent/bot integration — 13 tools, dual transport (stdio/HTTP) |
| `public/meeting.html` | Full meeting UI: WebRTC, Socket.IO client, MediaPipe, all meeting features (~2600 lines) |
| `public/dashboard.html` | User dashboard: meetings, API keys, billing, recordings, transcripts, bot guide |
| `public/admin.html` | Admin panel: users, companies, billing, analytics (6 tabs), settings |
| `public/index.html` | Landing page with Teams/Developers mode toggle |
| `public/docs.html` | Full API documentation (20 sections, ~90 endpoints) |
| `public/styles.css` | Unified stylesheet for meeting page |
| `eslint.config.js` | ESLint v10 flat config (server-side only, ignores `public/`) |
| `tests/` | Jest test suite: API, billing, rate-limiter, security |
| `.env.example` | All environment variable definitions |
| `.github/workflows/ci.yml` | GitHub Actions CI: lint + test with PostgreSQL service |
| `docker-compose.yml` | Local dev: PostgreSQL 16 + app with healthcheck |

## Development

```bash
npm run dev      # node --watch server.js (auto-reload)
npm start        # node server.js (production)
npm test         # Jest test suite
npm run lint     # ESLint (ignores public/)
npm run mcp      # MCP server via stdio (for Claude Code / local agents)
npm run mcp:http # MCP server via HTTP/SSE on port 3100 (for remote agents)
```

**Minimum `.env` for local dev:**
```
DATABASE_PUBLIC_URL=postgres://...
SESSION_SECRET=any-local-string
```

The DB schema is auto-created on first start (`initDB()` in `db.js`). Default admin: `assad.dar@gmail.com` / `Test321!`.

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
  ownerId, ownerCompanyId,   // cached for webhooks/analytics (avoids DB lookup)
  gracePeriodTimer,          // setTimeout handle for 60s post-empty charge
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
| Dual auth | `authApiOrSession` middleware — accepts either API key or session (for transcript/recording endpoints) |

### Settings cache

`db.js` caches settings in memory for 60 seconds with stampede protection (concurrent `getSettings()` calls share one pending DB query). After admin changes settings via `PATCH /admin/api/settings`, the cache is invalidated immediately.

### Graceful shutdown

On `SIGTERM`/`SIGINT`, the server charges all active meetings before exiting. It clears the scheduled meeting polling interval, emits `meeting:ended` to all rooms, runs `chargeMeeting()` via `Promise.allSettled`, then closes HTTP server and DB pool. Force-exit after 30s.

## MCP server (`mcp-server.js`)

Model Context Protocol server for AI agent/bot integration. Allows bots to create meetings, join via Socket.IO, send chat, react, and manage participants programmatically.

### Configuration
```bash
ONEPIZZA_API_URL=http://localhost:3000  # API base URL
ONEPIZZA_API_KEY=mk_...                # API key for auth
```

### 13 tools available
- `create_meeting`, `list_meetings`, `get_meeting`, `end_meeting` — meeting CRUD
- `schedule_meeting` — create a future meeting
- `update_settings` — change meeting settings (mute on join, etc.)
- `mute_participant`, `kick_participant`, `mute_all` — participant management
- `bot_join`, `bot_leave` — join/leave a meeting via Socket.IO
- `bot_chat`, `bot_react` — send chat messages and emoji reactions

### Resources
- `meetings://active` — dynamic resource listing all active meetings

### Socket.IO connection manager
`botJoin()` creates a persistent Socket.IO connection with event buffering. Events received (participant joins, chat messages, etc.) are buffered and returned on `bot_leave`. This enables bots to join meetings, listen to events, and interact in real time.

## Recording system

### Browser-side recording
- `MediaRecorder` captures canvas (composited video tiles) + mixed audio via `AudioContext`
- Chunks stored in `recordingChunks[]` array, assembled into WebM blob on stop
- Recording consent banner shown to all participants via Socket.IO broadcast

### Server-side storage
- `POST /api/meetings/:id/recordings` — upload recording (multipart, max 500MB)
- `GET /api/meetings/:id/recordings` — list recordings for a meeting
- `GET /api/recordings/:id/download` — download recording file
- Files stored in `uploads/recordings/` directory
- Recordings table: `id, meeting_id, user_id, filename, size_bytes, storage_path, created_at`

## Chat & transcripts

### Chat persistence
Messages are stored in `chat_messages` DB table alongside real-time Socket.IO relay. Both API key and session auth are accepted via `authApiOrSession` middleware.

### Transcript endpoints
- `GET /api/meetings/:id/transcript` — JSON transcript (all messages)
- `GET /api/meetings/:id/transcript/download` — plain text file download

### Client-side
- Chat log capped at 500 messages in memory
- Chat reactions with emoji picker (event delegation on container)
- Unread badge counter on chat tab

## Analytics & monitoring

### Database tables
- `analytics_events` — event tracking (event_type, user_id, company_id, meta JSONB)
- `ai_usage_log` — AI token usage (model, module, prompt/completion tokens, cost)

### Tracked event types
`meeting.created`, `meeting.participant_joined`, `meeting.ended`, `guest_meeting.created`, `feature.screen_share`, `feature.recording`, `feature.chat`, `feature.reaction`, `feature.captions`, `feature.hand_raise`, `feature.waiting_room`, `feature.background_effect`

### Admin analytics (6 tabs)
1. **Overview** — total users, meetings, revenue, event counts (1d/7d/30d)
2. **Features** — usage breakdown by feature type with bar charts
3. **Users** — top 100 users with meeting count, minutes, credits spent
4. **Meetings** — trends by day (meetings, participants, revenue)
5. **AI Usage** — token counts and costs by model and module
6. **Health** — realtime meeting stats, error rates, retention, peak hours heatmap

### Analytics API endpoints (admin auth required)
- `GET /admin/api/analytics/overview` — aggregate stats
- `GET /admin/api/analytics/events?days=N` — event breakdown
- `GET /admin/api/analytics/trends?days=N` — daily meeting trends
- `GET /admin/api/analytics/users` — top users with aggregated metrics
- `GET /admin/api/analytics/ai` — AI usage by model/module/day
- `GET /admin/api/analytics/features?days=N` — feature usage counts
- `GET /admin/api/analytics/realtime` — live meeting state
- `GET /admin/api/analytics/retention` — weekly user retention
- `GET /admin/api/analytics/health` — system health metrics
- `GET /admin/api/analytics/peak-hours` — meeting heatmap by day/hour
- `GET /admin/api/analytics/errors?days=N` — error event aggregation

### Helper functions
- `trackEvent(userId, companyId, eventType, meta)` — fire-and-forget analytics insert (logs errors)
- `trackAiUsage(model, module, endpoint, promptTokens, completionTokens, costUsd)` — AI usage tracking

## Performance patterns

### Client-side caching (`meeting.html`)
- **`UI` object** — 25+ frequently-accessed DOM element refs cached after join via `cacheUIElements()`
- **`_tileCache`** — video tiles cached by PID, invalidated on `renderVideoGrid()`
- **`_avatarColorCache`** — avatar colors computed once per PID
- **Event delegation** — single click handler on video grid (pin, focus, filmstrip) + chat container (reactions)
- **`reconcileTiles()`** — single-pass tile diff using Map, replaces multiple `querySelectorAll` loops
- **`escapeHtml()`** — regex-based (no DOM element creation)

### Server-side caching
- **`ownerId`/`ownerCompanyId`** cached on meeting object — eliminates DB lookup on join/leave/charge
- **Settings cache** with stampede protection — concurrent calls share one pending query
- **Static files** served with `maxAge: '1d'` and ETags

## Coding conventions

### General
- **camelCase** for all JS variables, functions, and object keys
- **snake_case** for all PostgreSQL column names
- **async/await** everywhere — avoid raw `.then()` chains
- **Parameterized SQL** always — `pool.query('SELECT ... WHERE id = $1', [id])` — never interpolate
- Fire-and-forget pattern for non-critical ops: `somePromise().catch(err => console.error(...))`

### Error responses (HTTP)
```
200 OK, 201 Created, 400 Bad Request, 401 Unauthorized,
403 Forbidden, 404 Not Found, 409 Conflict, 500 Server Error, 503 Unavailable
```

### Security patterns to maintain
- **Timing-safe token comparison**: use `crypto.timingSafeEqual` for admin tokens (already in `requireMeetingAdmin` middleware and delete endpoint)
- **Parameterized queries**: never string-interpolate user input into SQL
- **Input sanitization**: always `.trim().slice(0, N)` on user-supplied strings before storing
- **Meeting IDs**: generated with `crypto.randomBytes` (not `Math.random`)
- **Rate limiting**: auth/reset/guest endpoints are rate-limited; do not remove these
- **SSRF protection**: webhook URLs validated against private/loopback/link-local IPs
- **CSP headers**: Helmet configured with allowlist for CDN dependencies

### Before every commit
- **Always** update `CHANGELOG.md` with a summary of changes under the current version heading
- Update the date in the `## [version] — date` heading to the current date and time
- If the version number in `package.json` changes, update the heading in `CHANGELOG.md` to match
- Group entries under `### Added`, `### Changed`, `### Fixed`, or `### Security` as appropriate

### Frontend (`public/*.html`)
- All frontend code is **inline JS in single HTML files** — no separate `.js` files, no bundler
- The `$()` helper is `document.querySelector` (defined at top of each file)
- ESLint does **not** run on `public/` — be careful with frontend code quality
- `meeting.html` uses Socket.IO client loaded from CDN and MediaPipe from JSDelivr CDN (async)

## Domain knowledge

### Billing
- Rate: `cost = durationMinutes × peakParticipants × rate_per_participant_minute`
- Default rate: `$0.01` per participant per minute
- Credits deducted in `chargeMeeting()` called 60s after last participant leaves
- Both personal (`users.credits_usd`) and company (`companies.credits_usd`) accounts
- `chargeMeeting()` uses DB transaction (BEGIN/COMMIT/ROLLBACK) with dedicated client
- Low balance email notification when credits cross threshold

### Feature flags
Settings in the `settings` DB table control feature availability. Check `getSettings()` before adding features that should be admin-toggleable. Current flags: `recording_enabled`, `screen_share_enabled`, `blur_enabled`, `captions_enabled`, `registration_enabled`, `guest_meetings_enabled`, `max_participants_default`, `meeting_cost_per_participant_minute`.

### Scheduled meetings
Stored in `scheduledMeetings` Map (in-memory, not DB). Individual `setTimeout` per meeting + backup `setInterval` every 15s. `activateScheduledMeeting()` moves them to the live `meetings` Map. Scheduled meetings carry `ownerId`/`ownerCompanyId` through activation.

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
- Do not use `querySelectorAll` in hot paths — use cached refs (`UI` object, `_tileCache`, tile child refs `tile._media` etc.)
- Do not create DOM elements in `escapeHtml()` — use the regex-based implementation
- Do not silently swallow errors in `trackEvent`/`trackAiUsage` — always log with `.catch(err => console.error(...))`
