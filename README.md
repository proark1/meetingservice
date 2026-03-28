# onepizza.io

Video meeting platform with WebRTC, breakout rooms, live streaming, chat, recording, live captions, virtual backgrounds, and a developer API.

## Stack

- **Runtime**: Node.js 22 + Express 4
- **Real-time**: Socket.IO 4 + WebRTC (peer-to-peer)
- **Database**: PostgreSQL (node-pg)
- **Auth**: express-session + connect-pg-simple
- **Payments**: Stripe + USDC (ethers.js)
- **Email**: Resend (optional, graceful no-op)
- **Frontend**: Vanilla JS, single-file HTML pages, no build step
- **AI Integration**: MCP server (Model Context Protocol)
- **Deploy**: Railway / Docker (Alpine)

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/proark1/meetingservice.git
cd meetingservice
npm install

# 2. Start PostgreSQL (via Docker or local install)
docker compose up -d db

# 3. Configure environment
cp .env.example .env
# Edit .env — minimum required:
#   DATABASE_PUBLIC_URL=postgres://...
#   SESSION_SECRET=any-long-random-string
#   ADMIN_EMAIL=your@email.com
#   ADMIN_PASSWORD=your-secure-password

# 4. Start the server (DB schema auto-created on first run)
npm run dev
```

Open http://localhost:3000 to access the app.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development server with auto-reload |
| `npm start` | Production server |
| `npm test` | Run Jest test suite |
| `npm run lint` | ESLint (server-side only) |
| `npm run mcp` | MCP server via stdio |
| `npm run mcp:http` | MCP server via HTTP/SSE on port 3100 |

## Features

- **Video/Audio Meetings** — WebRTC peer-to-peer with TURN fallback
- **Screen Sharing** — Share screen, window, or tab
- **Recording** — Browser-side recording with server upload (max 500MB)
- **Chat** — Real-time chat with persistence, replies, and reactions
- **Live Captions** — Browser speech recognition with real-time broadcast
- **Virtual Backgrounds** — MediaPipe ML-powered blur and image backgrounds
- **Breakout Rooms** — Split meetings into sub-rooms with timer and broadcast
- **Live Streaming** — RTMP output to YouTube, Twitch, or custom endpoints
- **Waiting Room** — Approve participants before they join
- **Reactions** — Emoji reactions visible to all participants
- **Push-to-Talk** — Hold spacebar to temporarily unmute
- **Scheduled Meetings** — Create meetings that activate at a future time
- **Billing** — Usage-based (per-participant per-minute), Stripe + USDC
- **Admin Panel** — User management, analytics (6 tabs), settings, billing
- **Developer API** — REST API with API key auth (20+ sections, ~90 endpoints)
- **MCP Server** — 13 tools for AI agent/bot integration
- **Webhooks** — Real-time event notifications with SSRF protection

## Environment Variables

See [`.env.example`](.env.example) for all available configuration. Minimum required:

| Variable | Description |
|---|---|
| `DATABASE_PUBLIC_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session encryption key (32+ chars) |
| `ADMIN_EMAIL` | Admin account email (seeded on first start) |
| `ADMIN_PASSWORD` | Admin account password |

Optional: `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `TURN_URLS`, `CRYPTO_MNEMONIC` — see `.env.example` for details.

## Project Structure

| File | Description |
|---|---|
| `server.js` | Express routes, Socket.IO handlers, billing, webhooks, analytics |
| `db.js` | PostgreSQL pool, schema init, settings cache |
| `email.js` | Transactional email templates (Resend) |
| `mcp-server.js` | MCP server for AI agent integration (13 tools) |
| `public/meeting.html` | Meeting room UI (WebRTC, MediaPipe, all meeting features) |
| `public/dashboard.html` | User dashboard (meetings, API keys, billing, recordings) |
| `public/admin.html` | Admin panel (users, analytics, settings) |
| `public/index.html` | Landing page |
| `public/docs.html` | API documentation |
| `public/styles.css` | Meeting page stylesheet |

## API Documentation

Full API docs are available at `/docs` when running the server, or see [`public/docs.html`](public/docs.html).

## Docker

```bash
# Full stack (app + PostgreSQL)
docker compose up

# PostgreSQL only (for local dev)
docker compose up -d db
```

## License

Private — all rights reserved.
