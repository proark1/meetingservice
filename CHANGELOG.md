# Changelog

All notable changes to onepizza.io are documented in this file.

## [1.0.0] — 2026-03-22T23:00:00+01:00

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

### Changed (Landing Page)
- Landing page updated with all new features, conversion-optimized for registration
  - Hero: updated badges and subheadlines highlighting dark mode, cloud recordings, MCP server
  - Users features grid: "Cloud Recordings" (replaces "Local only"), "Chat & Transcripts", "Dark Mode" card added
  - Developers features grid: "MCP Server" card (replaces "AI Agent Support"), "Transcripts & Recordings API" (replaces "Billing API"), "Self-Hosted & CI/CD" updated
  - Terminal preview: MCP server workflow (13 tools, join as Claude, send chat/reactions)
  - Stats: developers mode shows 13 MCP tools, 38 tests, 22 doc sections
  - Pricing: updated Personal (cloud recordings, dark mode), API Usage (MCP, transcripts, CI/CD) with primary CTA
  - API section bullets: MCP Server, Transcript API, Recording API, Docker Compose + CI/CD
  - Code example: transcript download and recording upload (replaces billing/list)
  - CTA banners: conversion-focused copy ("Stop paying per seat", "Ship your meeting integration tonight")
  - Footer: developer links updated to Transcripts API, Recordings API, MCP Server Setup

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
