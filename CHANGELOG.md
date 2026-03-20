# Changelog

All notable changes to onepizza.io are documented in this file.

## [1.0.0] — 2026-03-20T21:30:00+01:00

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
