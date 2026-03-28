#!/usr/bin/env node
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { io: ioClient } = require('socket.io-client');

// ─── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const API_URL = process.env.ONEPIZZA_API_URL || getArg('url', 'http://localhost:3000');
const API_KEY = process.env.ONEPIZZA_API_KEY || getArg('api-key', '');
const TRANSPORT = getArg('transport', 'stdio');
const HTTP_PORT = parseInt(getArg('port', '3100'), 10);

// ─── Logging (stderr only — stdout is reserved for MCP protocol) ─────────────

function log(...args) {
  process.stderr.write(`[mcp-server] ${args.join(' ')}\n`);
}

// ─── REST API helper ─────────────────────────────────────────────────────────

async function apiRequest(method, path, body, extraHeaders = {}) {
  const url = `${API_URL.replace(/\/$/, '')}${path}`;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (API_KEY) headers['x-api-key'] = API_KEY;

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ─── Socket.IO connection manager ────────────────────────────────────────────

const activeSessions = new Map(); // meetingId → { socket, participantId, events[] }

function getSession(meetingId) {
  const session = activeSessions.get(meetingId);
  if (!session) throw new Error(`Not joined to meeting ${meetingId}. Use join_meeting first.`);
  return session;
}

function joinMeetingSocket(meetingId, name, isAdmin, adminToken) {
  return new Promise((resolve, reject) => {
    if (activeSessions.has(meetingId)) {
      return reject(new Error(`Already joined meeting ${meetingId}. Use leave_meeting first.`));
    }

    const socket = ioClient(API_URL, { transports: ['websocket'] });
    const events = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.disconnect();
        reject(new Error('Timed out waiting to join meeting'));
      }
    }, 15000);

    socket.on('connect', () => {
      socket.emit('join-meeting', { meetingId, name, isAdmin, adminToken });
    });

    socket.on('joined', (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const session = { socket, participantId: data.participantId, events };
      activeSessions.set(meetingId, session);

      // Listen for incoming events and buffer them
      socket.on('chat:message', (msg) => {
        events.push({ type: 'chat', from: msg.name, text: msg.text, timestamp: msg.timestamp });
        if (events.length > 200) events.shift();
      });
      socket.on('participant:joined', (p) => {
        events.push({ type: 'participant_joined', name: p.name, participantId: p.participantId });
        if (events.length > 200) events.shift();
      });
      socket.on('participant:left', (p) => {
        events.push({ type: 'participant_left', name: p.name, participantId: p.participantId });
        if (events.length > 200) events.shift();
      });
      socket.on('react', (r) => {
        events.push({ type: 'reaction', participantId: r.participantId, emoji: r.emoji });
        if (events.length > 200) events.shift();
      });
      socket.on('meeting:ended', (r) => {
        events.push({ type: 'meeting_ended', reason: r.reason });
        activeSessions.delete(meetingId);
      });
      socket.on('disconnect', () => {
        activeSessions.delete(meetingId);
      });

      resolve({
        participantId: data.participantId,
        participants: data.participants,
        settings: data.settings,
        title: data.title,
        isAdmin: data.isAdmin,
      });
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.disconnect();
      reject(new Error(err.message || 'Failed to join meeting'));
    });

    socket.on('connect_error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Connection failed: ${err.message}`));
    });
  });
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const tools = [
  // Meeting Management (REST)
  {
    name: 'create_meeting',
    description: 'Create a new meeting. Returns meetingId, adminToken, and joinUrl.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Meeting title (max 100 chars)' },
        muteOnJoin: { type: 'boolean', description: 'Mute participants when they join' },
        videoOffOnJoin: { type: 'boolean', description: 'Turn off video when participants join' },
        maxParticipants: { type: 'number', description: 'Max participants (2-500)' },
        waitingRoom: { type: 'boolean', description: 'Enable waiting room' },
        scheduledAt: { type: 'string', description: 'ISO 8601 datetime for scheduled meeting' },
      },
    },
  },
  {
    name: 'list_meetings',
    description: 'List all active and scheduled meetings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_meeting',
    description: 'Get meeting details including participants and settings.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID' },
      },
      required: ['meetingId'],
    },
  },
  {
    name: 'end_meeting',
    description: 'End an active meeting or cancel a scheduled meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID' },
        adminToken: { type: 'string', description: 'Admin token returned from create_meeting' },
      },
      required: ['meetingId', 'adminToken'],
    },
  },
  {
    name: 'update_meeting_settings',
    description: 'Update meeting settings (muteOnJoin, videoOffOnJoin, maxParticipants, locked, title).',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID' },
        adminToken: { type: 'string', description: 'Admin token' },
        muteOnJoin: { type: 'boolean' },
        videoOffOnJoin: { type: 'boolean' },
        maxParticipants: { type: 'number' },
        locked: { type: 'boolean' },
        title: { type: 'string' },
      },
      required: ['meetingId', 'adminToken'],
    },
  },

  // Participant Management (REST)
  {
    name: 'mute_participant',
    description: 'Mute a specific participant in a meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' },
        adminToken: { type: 'string' },
        participantId: { type: 'string' },
      },
      required: ['meetingId', 'adminToken', 'participantId'],
    },
  },
  {
    name: 'unmute_participant',
    description: 'Unmute a specific participant in a meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' },
        adminToken: { type: 'string' },
        participantId: { type: 'string' },
      },
      required: ['meetingId', 'adminToken', 'participantId'],
    },
  },
  {
    name: 'kick_participant',
    description: 'Remove a participant from a meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' },
        adminToken: { type: 'string' },
        participantId: { type: 'string' },
        reason: { type: 'string', description: 'Reason for removal' },
      },
      required: ['meetingId', 'adminToken', 'participantId'],
    },
  },
  {
    name: 'mute_all',
    description: 'Mute all participants in a meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' },
        adminToken: { type: 'string' },
      },
      required: ['meetingId', 'adminToken'],
    },
  },

  // Real-time Bot Interaction (Socket.IO)
  {
    name: 'join_meeting',
    description: 'Join a meeting as a bot via Socket.IO. Establishes a persistent connection for real-time interaction. Returns participantId and current participant list.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID to join' },
        name: { type: 'string', description: 'Bot display name (max 60 chars)' },
        adminToken: { type: 'string', description: 'Admin token (optional, grants admin privileges)' },
      },
      required: ['meetingId', 'name'],
    },
  },
  {
    name: 'send_chat_message',
    description: 'Send a chat message in a meeting the bot has joined. Also returns any new events (messages, joins, leaves) since last check.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID' },
        text: { type: 'string', description: 'Message text (max 500 chars)' },
      },
      required: ['meetingId', 'text'],
    },
  },
  {
    name: 'send_reaction',
    description: 'Send an emoji reaction in a joined meeting. Allowed emojis: 👍 ❤️ 😂 🎉 👏',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID' },
        emoji: { type: 'string', description: 'Emoji to react with (👍 ❤️ 😂 🎉 👏)' },
      },
      required: ['meetingId', 'emoji'],
    },
  },
  {
    name: 'leave_meeting',
    description: 'Disconnect the bot from a meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting ID to leave' },
      },
      required: ['meetingId'],
    },
  },
  // Polls
  { name: 'create_poll', description: 'Create a poll in a meeting (admin).', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' }, adminToken: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['meetingId', 'adminToken', 'question', 'options'] } },
  { name: 'get_polls', description: 'List polls in a meeting.', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' } }, required: ['meetingId'] } },
  { name: 'end_poll', description: 'End a poll.', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' }, adminToken: { type: 'string' }, pollId: { type: 'string' } }, required: ['meetingId', 'adminToken', 'pollId'] } },
  // Q&A
  { name: 'ask_question', description: 'Submit a Q&A question.', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' }, text: { type: 'string' }, participantName: { type: 'string' } }, required: ['meetingId', 'text'] } },
  { name: 'get_questions', description: 'List Q&A questions.', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' } }, required: ['meetingId'] } },
  { name: 'answer_question', description: 'Mark a question answered (admin).', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' }, adminToken: { type: 'string' }, questionId: { type: 'string' }, answer: { type: 'string' } }, required: ['meetingId', 'adminToken', 'questionId'] } },
  // Notes
  { name: 'get_meeting_notes', description: 'Get meeting notes.', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' } }, required: ['meetingId'] } },
  { name: 'update_meeting_notes', description: 'Update meeting notes (admin).', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' }, adminToken: { type: 'string' }, content: { type: 'string' } }, required: ['meetingId', 'adminToken', 'content'] } },
  // Attendance
  { name: 'get_attendance', description: 'Get attendance report.', inputSchema: { type: 'object', properties: { meetingId: { type: 'string' }, adminToken: { type: 'string' } }, required: ['meetingId', 'adminToken'] } },
  // Templates & Recurring
  { name: 'list_templates', description: 'List meeting templates.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_recurring_meeting', description: 'Create a recurring meeting.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, recurrence: { type: 'string' }, dayOfWeek: { type: 'number' }, timeUtc: { type: 'string' } }, required: ['title', 'recurrence', 'timeUtc'] } },
  { name: 'list_recurring_meetings', description: 'List recurring meetings.', inputSchema: { type: 'object', properties: {} } },
];

// ─── Tool handler ────────────────────────────────────────────────────────────

async function handleToolCall(name, args) {
  switch (name) {
    // ── Meeting Management ──
    case 'create_meeting': {
      const body = {};
      if (args.title) body.title = args.title;
      if (args.muteOnJoin !== undefined) body.muteOnJoin = args.muteOnJoin;
      if (args.videoOffOnJoin !== undefined) body.videoOffOnJoin = args.videoOffOnJoin;
      if (args.maxParticipants !== undefined) body.maxParticipants = args.maxParticipants;
      if (args.waitingRoom !== undefined) body.waitingRoom = args.waitingRoom;
      if (args.scheduledAt) body.scheduledAt = args.scheduledAt;
      return await apiRequest('POST', '/api/meetings', body);
    }

    case 'list_meetings':
      return await apiRequest('GET', '/api/meetings');

    case 'get_meeting':
      return await apiRequest('GET', `/api/meetings/${encodeURIComponent(args.meetingId)}`);

    case 'end_meeting':
      return await apiRequest('DELETE', `/api/meetings/${encodeURIComponent(args.meetingId)}`, null, {
        'x-admin-token': args.adminToken,
      });

    case 'update_meeting_settings': {
      const body = {};
      for (const key of ['muteOnJoin', 'videoOffOnJoin', 'maxParticipants', 'locked', 'title']) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      return await apiRequest('PATCH', `/api/meetings/${encodeURIComponent(args.meetingId)}/settings`, body, {
        'x-admin-token': args.adminToken,
      });
    }

    // ── Participant Management ──
    case 'mute_participant':
      return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/participants/${encodeURIComponent(args.participantId)}/mute`, null, {
        'x-admin-token': args.adminToken,
      });

    case 'unmute_participant':
      return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/participants/${encodeURIComponent(args.participantId)}/unmute`, null, {
        'x-admin-token': args.adminToken,
      });

    case 'kick_participant':
      return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/participants/${encodeURIComponent(args.participantId)}/kick`, { reason: args.reason }, {
        'x-admin-token': args.adminToken,
      });

    case 'mute_all':
      return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/mute-all`, null, {
        'x-admin-token': args.adminToken,
      });

    // ── Real-time Bot (Socket.IO) ──
    case 'join_meeting': {
      const isAdmin = !!args.adminToken;
      const result = await joinMeetingSocket(args.meetingId, args.name, isAdmin, args.adminToken || null);
      return result;
    }

    case 'send_chat_message': {
      const session = getSession(args.meetingId);
      session.socket.emit('chat:message', { text: (args.text || '').slice(0, 500) });
      // Return buffered events and clear them
      const recentEvents = session.events.splice(0);
      return { sent: true, recentEvents };
    }

    case 'send_reaction': {
      const session = getSession(args.meetingId);
      const allowed = ['👍', '❤️', '😂', '🎉', '👏'];
      if (!allowed.includes(args.emoji)) {
        throw new Error(`Invalid emoji. Allowed: ${allowed.join(' ')}`);
      }
      session.socket.emit('react', { emoji: args.emoji });
      const recentEvents = session.events.splice(0);
      return { sent: true, recentEvents };
    }

    case 'leave_meeting': {
      const session = getSession(args.meetingId);
      session.socket.disconnect();
      activeSessions.delete(args.meetingId);
      return { left: true };
    }

    // ── Polls ──
    case 'create_poll': return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/polls`, { question: args.question, options: args.options }, { 'x-admin-token': args.adminToken });
    case 'get_polls': return await apiRequest('GET', `/api/meetings/${encodeURIComponent(args.meetingId)}/polls`);
    case 'end_poll': return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/polls/${encodeURIComponent(args.pollId)}/end`, null, { 'x-admin-token': args.adminToken });
    // ── Q&A ──
    case 'ask_question': return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/questions`, { text: args.text, participantName: args.participantName });
    case 'get_questions': return await apiRequest('GET', `/api/meetings/${encodeURIComponent(args.meetingId)}/questions`);
    case 'answer_question': return await apiRequest('POST', `/api/meetings/${encodeURIComponent(args.meetingId)}/questions/${encodeURIComponent(args.questionId)}/answer`, { answer: args.answer }, { 'x-admin-token': args.adminToken });
    // ── Notes ──
    case 'get_meeting_notes': return await apiRequest('GET', `/api/meetings/${encodeURIComponent(args.meetingId)}/notes`);
    case 'update_meeting_notes': return await apiRequest('PUT', `/api/meetings/${encodeURIComponent(args.meetingId)}/notes`, { content: args.content }, { 'x-admin-token': args.adminToken });
    // ── Attendance ──
    case 'get_attendance': return await apiRequest('GET', `/api/meetings/${encodeURIComponent(args.meetingId)}/attendance`, null, { 'x-admin-token': args.adminToken });
    // ── Templates & Recurring ──
    case 'list_templates': return await apiRequest('GET', '/api/templates');
    case 'create_recurring_meeting': return await apiRequest('POST', '/api/meetings/recurring', { title: args.title, recurrence: args.recurrence, dayOfWeek: args.dayOfWeek, timeUtc: args.timeUtc });
    case 'list_recurring_meetings': return await apiRequest('GET', '/api/meetings/recurring');

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'onepizza-mcp', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;
  try {
    const result = await handleToolCall(name, toolArgs || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// List resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'meetings://active',
      name: 'Active Meetings',
      description: 'List of currently active and scheduled meetings',
      mimeType: 'application/json',
    },
  ],
}));

// Read resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === 'meetings://active') {
    try {
      const data = await apiRequest('GET', '/api/meetings');
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ error: err.message }),
        }],
      };
    }
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// ─── Transport & startup ─────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    log('WARNING: No API key configured. Set ONEPIZZA_API_KEY or use --api-key <key>');
    log('REST API tools will fail without a valid API key. Socket.IO tools may still work.');
  }

  if (TRANSPORT === 'http') {
    // HTTP/SSE transport for remote access
    let StreamableHTTPServerTransport;
    try {
      ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
    } catch {
      log('ERROR: StreamableHTTPServerTransport not available. Update @modelcontextprotocol/sdk or use --transport stdio');
      process.exit(1);
    }

    const express = require('express');
    const app = express();
    app.use(express.json());

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    app.post('/mcp', async (req, res) => {
      await transport.handleRequest(req, res);
    });
    app.get('/mcp', async (req, res) => {
      await transport.handleRequest(req, res);
    });
    app.delete('/mcp', async (req, res) => {
      await transport.handleRequest(req, res);
    });

    await server.connect(transport);
    app.listen(HTTP_PORT, () => {
      log(`MCP server (HTTP) listening on port ${HTTP_PORT}`);
      log(`Endpoint: http://localhost:${HTTP_PORT}/mcp`);
    });
  } else {
    // Stdio transport (default)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('MCP server (stdio) started');
  }

  log(`API URL: ${API_URL}`);
  log(`API Key: ${API_KEY ? '***' + API_KEY.slice(-4) : '(not set)'}`);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
