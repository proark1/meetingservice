# Changelog

All notable changes to onepizza.io are documented in this file.

## [1.0.0] — 2026-03-23T12:30:00+01:00

### Changed
- **Performance**: Event delegation on video grid — single click listener instead of 3 per tile (O(n)→O(1))
- **Performance**: Cache child element refs on video tiles — syncVideoTile drops from 6 queries to 0
- **Performance**: Single-pass tile reconciliation in renderVideoGrid — query DOM once, diff with Map
- **Performance**: Chat event delegation — single listener on container instead of per-message
- **Performance**: Analytics overview — 3 event count queries merged into 1 with conditional aggregation
- **Performance**: Analytics users — 5 LEFT JOINs replaced with pre-aggregated subqueries (no cartesian explosion)
- **Performance**: Support key verification — limited to recent keys (7 days, max 100), prevents O(n) bcrypt
- **Performance**: Settings cache stampede protection — concurrent getSettings() calls share one DB query
- **Performance**: Landing page nav — lighter backdrop-filter (blur 8px, no saturate)
- **Performance**: Admin analytics polling skips when page hidden (Page Visibility API)
- **Performance**: Admin analytics uses Promise.allSettled (one failed tab doesn't block all)
- **Performance**: Added compound indexes on credit_transactions(user_id,type) and (type,created_at)
- **Performance**: trackEvent/trackAiUsage now log errors instead of silently swallowing
- **Performance**: escapeHtml() now uses regex instead of creating a DOM element per call
- **Performance**: showToast() uses counter instead of querySelectorAll to track active toasts
- **Performance**: unpinBtn only rebuilds innerHTML when focus state actually changes
- **Performance**: Static files served with 1-day cache headers and ETags
- **Performance**: express.static() moved before express.json() — static files skip JSON parsing
- **Performance**: Scheduled meeting polling interval skips iteration when Map is empty
- **Performance**: Dashboard recordings+transcripts loaded in parallel (Promise.allSettled)
- **Performance**: CSS will-change on toast and reaction-float animations for GPU acceleration

### Added
- SEO meta tags on landing page: description, Open Graph, Twitter Card
- SVG favicon (`/favicon.svg`) added to all 10 HTML pages
- `robots.txt` (allow all, block /admin and /api) and `sitemap.xml`
- Structured JSON logging helper (`log(level, msg, meta)`) — replaces raw console.log for key events
- Socket.IO idle timeout: disconnect sockets that don't join a meeting within 30s
- Kubernetes health endpoints: `/health/liveness` (always 200), `/health/readiness` (checks DB)
- ESLint rules expanded: eqeqeq, no-unreachable, no-dupe-keys, no-duplicate-case, no-self-assign, no-throw-literal
- `trust proxy` configured for correct client IP behind reverse proxies (Railway, nginx)
- Session `proxy: true` for secure cookies behind load balancer (fixes login not working on Railway)
- Dashboard `initApp()` error handling — shows login page on crash instead of blank page
- Socket.IO transports: WebSocket first, polling fallback (faster initial connection)
- Admin settings batch write: N separate INSERT queries → single multi-value INSERT
- JSON body size limit: 1MB max to prevent OOM from malicious payloads
- Admin list queries capped: users, keys, companies LIMIT 200 (prevents DOM explosion)
- Socket.IO connection logging: connect/disconnect/join events with socket ID, IP, meeting ID
- 404 error page (`public/error.html`) with clean UI and catch-all route in server.js
- Hand raise queue ordering: raised hands sorted by timestamp, queue position shown in participants list
- Pre-commit hook enforcing CHANGELOG.md updates on every commit
- New test suites: `tests/scheduled-meetings.test.js` (5 tests), `tests/helpers.test.js` (20 tests)
- Tests cover: meeting ID generation, escapeHtml, hand raise sorting, avatar colors, scheduled meeting activation

### Changed
- CLAUDE.md fully rewritten: documents MCP server, recordings, chat persistence, analytics, graceful shutdown, performance patterns
- Dockerfile hardened: `npm ci --omit=dev`, `USER node` (non-root), `HEALTHCHECK`, pre-create uploads dir with correct ownership
- CI pipeline: `npm install` → `npm ci` for deterministic builds
- Support key bcrypt cost: 10 → 12 (consistent with password hashing)

### Fixed
- Memory leak: qualityState, _avatarColorCache, _tileCache cleaned up on participant leave
- Graceful shutdown now clears scheduled meeting polling interval and all scheduled timers

- **Performance**: Cache DOM element refs in meeting page — eliminates 30+ getElementById calls per updateControlButtons()
- **Performance**: Cache video tile refs by PID — speaking detection drops from 67 DOM queries/sec to ~0 with 10 participants
- **Performance**: Cache recording tile list (500ms TTL) — eliminates 300+ querySelectorAll calls/sec at 30fps
- **Performance**: Use DocumentFragment for participant list rebuild — single DOM reflow instead of N appends
- **Performance**: Fast average in speaking analyzer — sample every 4th frequency bin instead of all 128
- **Performance**: Break early in getStats() loop — stop iterating after finding first video inbound-rtp report
- **Performance**: Cache avatar colors — compute hash once per participant, reuse on every render
- **Performance**: Use cached UI refs in timer, recording timer, spotlight, and quality badge functions
- **Performance**: Add `async` attribute to MediaPipe script tag — unblocks HTML parsing on slow networks
- **Performance**: Eliminate N+1 DB query on participant join — cache ownerId/companyId in meeting object
- **Performance**: Remove DB lookup from participant.left webhook — use cached owner IDs
- **Performance**: Optimize chargeMeeting — use cached owner IDs, fall back to DB only if missing

### Fixed
- Timing-safe token comparison now used for active meeting deletion (was using plain `===`)
- Scheduled meetings now propagate ownerId/ownerCompanyId through activation

### Added
- MCP server (`mcp-server.js`) for AI agent integration via Model Context Protocol
  - 13 tools: meeting CRUD, participant management, and real-time bot interaction (join, chat, react)
  - Dual transport support: stdio (local/Claude Code) and HTTP/SSE (remote)
  - Socket.IO connection manager for persistent bot sessions with event buffering
  - `meetings://active` dynamic resource for listing active meetings
  - New npm scripts: `npm run mcp` (stdio) and `npm run mcp:http` (HTTP on port 3100)
- Chat persistence: messages stored in `chat_messages` DB table with transcript API endpoints
  - `GET /api/meetings/:id/transcript` — JSON transcript
  - `GET /api/meetings/:id/transcript/download` — plain text file download
- Recording upload & storage: server-side recording management
  - `POST /api/meetings/:id/recordings` — upload recording (multipart, max 500MB)
  - `GET /api/meetings/:id/recordings` — list recordings for a meeting
  - `GET /api/recordings/:id/download` — download recording file
  - "Upload recording" button in meeting UI after recording stops
- Automated test suite with Jest (`npm test`)
  - Unit tests: billing cost calculation, socket rate limiter logic
  - Integration tests: REST API endpoints (skipped without DB)
- CI/CD pipeline via GitHub Actions (`.github/workflows/ci.yml`)
  - Runs lint and tests on push/PR to main with PostgreSQL service container
- Docker Compose for local development (`docker-compose.yml`)
  - PostgreSQL 16 + app with healthcheck, auto-configured env vars
- `.dockerignore` to reduce Docker image size

### Changed
- Graceful shutdown now charges all active meetings before exiting
  - Emits `meeting:ended` to all rooms, runs `chargeMeeting()` via `Promise.allSettled`
  - Force-exit timeout increased from 10s to 30s
- Socket.IO rate limiting on high-frequency events
  - `chat:message` (10/10s), `react` (5/10s), `chat:react` (10/10s), `captions:update` (20/10s), `raise-hand` (5/10s)
  - Rate limiter state cleaned up on socket disconnect
- ESLint config added (`eslint.config.js`) for ESLint v10 compatibility

### Security
- Socket.IO event spam protection prevents DoS via rapid-fire chat/reaction events
- Fixed XSS vulnerabilities in `register.html` (API key/invite code display) and `billing.html` (transaction descriptions)
  - Replaced unsafe `innerHTML` interpolation with DOM API (`textContent`, `createElement`) and `esc()` helper
- Enabled Content Security Policy (CSP) via Helmet with allowlist for CDN dependencies
  - `script-src`: self, unsafe-inline, cdn.socket.io, cdn.jsdelivr.net
  - `style-src`: self, unsafe-inline, fonts.googleapis.com
  - `connect-src`: self, wss:, ws:
- Added security-focused tests: XSS escaping, input sanitization, emoji whitelist validation

### Added (UI/UX)
- Dark mode support via `prefers-color-scheme: dark` media query in `styles.css`
  - Full CSS custom property overrides for dark theme (backgrounds, text, borders, shadows)
- Mobile safe area padding for notched devices (iPhone 14+)
  - Controls bar and body respect `env(safe-area-inset-*)` values
- Accessibility improvements in `meeting.html`:
  - ARIA labels on all control buttons (mic, camera, screen share, chat, reactions, etc.)
  - `role="toolbar"` on controls bar, `role="dialog"` on shortcuts modal
  - `role="alert"` and `aria-live="polite"` on toast notifications and chat badge
  - `role="complementary"` on side panel, `role="menu"` on reactions tray
  - `aria-label` on chat input field
- Meeting receipt emails sent after billing via `meetingReceiptEmail()` template
- Recordings & Transcripts tab in dashboard with search-by-meeting-ID, download links
- API docs updated with 5 new endpoint sections: transcripts (2 endpoints) and recordings (3 endpoints)
- `authApiOrSession` middleware: transcript and recording endpoints accept both API key and session auth

- Landing page mode switcher: "For Teams" (UI-focused) and "For Developers" (API/Agent-focused)
- Developer-mode hero with terminal preview showing API + bot workflow
- Developer-mode features grid (REST API, Socket.IO, Agent support, Webhooks, Billing API, etc.)
- Developer-mode "Integrate in 4 steps" quick-start section
- Developer-mode stats row (REST, WS, API keys, latency)
- Developer-mode CTA banner focused on API key signup
- Mode preference persisted in localStorage, also activatable via #developers URL hash
- Smooth fade transition animation when switching between modes

### Changed
- Footer copyright updated to 2026
- Bot & Agent Integration guide on dashboard with 3-step flow and Node.js code example
- API Docs section in admin panel with endpoint table, bot quick-start, Socket.IO reference
- AI bots & agents bullet point on landing page API section
- New analytics endpoints documented in /docs: features, errors, realtime, retention, health, peak-hours
- Tracked event types documented in /docs (feature.screen_share, feature.recording, etc.)

### Changed
- Complete UI overhaul: modern light theme across all pages (white backgrounds, subtle shadows)
- New unified color palette: indigo-600 primary, emerald-500 success, consistent across all pages
- Meeting page converted from dark to light theme: white controls bar, light video tiles, clean side panels
- Modernized control buttons: soft gray pills with colored active states
- Refined typography: Inter font, antialiased rendering, consistent weight scale
- Improved mobile: horizontal-scroll controls, safe-area padding, 44px touch targets
- Polished components: cards with subtle shadows, softer badges, cleaner tables
- Custom scrollbar styling

### Added
- Comprehensive analytics dashboard with 6 sub-tabs: Overview, Features, Users, Meetings, AI Usage, Health
- Real-time live meeting monitoring (auto-refreshes every 30s) with participant/recording/screen share counts
- Feature usage tracking: screen share, recording, chat, reactions, captions, hand raise, waiting room, background effects
- 6 new analytics API endpoints: features, errors, realtime, retention, health, peak-hours
- Peak hours heatmap (7×24 grid showing meeting distribution by day and hour)
- Week-over-week user retention analysis
- System health monitoring: uptime, memory, heap, DB pool, active/scheduled meetings
- Error log aggregation with route/message grouping
- Live meetings table showing active meeting details
- 10+ new `trackEvent()` calls across socket handlers for granular feature tracking
- Per-connection `currentUserId`/`currentCompanyId` for accurate event attribution
- Add CHANGELOG.md with full project history
- Add pre-commit hook (Claude Code) to enforce CHANGELOG.md updates
- Add "Before every commit" section to CLAUDE.md

### Fixed
- Fix 16 bugs: race conditions, SSRF, transactions, null safety, cleanup
- Fix 12 bugs: memory leaks, race conditions, recording state, security
- Fix background effects: sharp edges, no more soft halo
- Fix background effects not visible to peers who join after blur is enabled
- Fix blur not visible to peers
- Fix login: CORS blocking same-origin POST requests in production
- Fix join URL `?name=` param and iframe embedding for API customers
- Fix login hang: session race condition and error handling
- Fix helmet CSP crash on startup
- Fix Resend crash when RESEND_API_KEY is not set
- Fix async disconnect handler crash
- Fix Railway build: Dockerfile to bypass Railpack npm ci issue
- Fix build: use npm install instead of npm ci
- Replace ellipse blur with MediaPipe SelfieSegmentation + fix recording infinite recursion

### Added
- Add CLAUDE.md with project guide for AI-assisted development
- Redesign UI: minimal controls bar + compact background panel
- Add focus mode: click tile expand icon to fill entire video area
- Add 8 major features: captions, virtual backgrounds, layout switcher, meeting lock, chat reactions, join/leave sounds, keyboard shortcuts panel
- Add video quality tiers: 720p, 1080p HD, 1440p 2K, 2160p 4K
- Add 5 new features with blur peer fix
- Add comprehensive analytics, AI usage tracking, and support key system
- Add admin nav link in user dashboard and cross-nav in admin panel
- Redirect logged-in users from landing page to dashboard
- Allow iframe embedding from lovable.app domains
- Add 11-phase production features: email, password reset, meeting persistence, billing, waiting room, team management, webhooks, connection quality, recording consent, private TURN
- Add scheduled meetings, light theme docs, and production URLs
- Add crypto wallet management, billing admin, and company management to admin panel
- Add landing page, light theme, company accounts, Stripe+USDC billing, v2.1.0 API docs
- Add PostgreSQL, admin panel, user auth, and API key management
- Improve UI, add recording, raise hand, and fix core bugs
- Initial release: complete meeting service with WebRTC video, REST API, and web UI

### Changed
- Rebrand from MeetingService to onepizza.io
- Redesign UI/UX: landing page, dashboard SPA, admin polish
- Overhaul meeting UI: SVG icons, speaking indicator, spotlight/pin, reactions, timer
- Apply light theme to admin panel and admin login pages

### Security
- Security hardening, UX polish, and performance improvements
- Production hardening: security, performance, and reliability
- Harden, optimize & stabilize meetingservice (Round 2)
