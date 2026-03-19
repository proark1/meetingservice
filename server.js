const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ────────────────────────────────────────────────────────

const meetings = new Map();   // meetingId -> Meeting
const apiKeys = new Map();    // apiKey   -> { createdAt, label }

// Bootstrap a default API key for quick testing
const DEFAULT_API_KEY = 'mk_default_test_key';
apiKeys.set(DEFAULT_API_KEY, { createdAt: Date.now(), label: 'default' });

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateMeetingId() {
  // Readable 10-char code:  abc-defg-hij
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const pick = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

function authApi(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !apiKeys.has(key)) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
}

function findMeeting(req, res, next) {
  const meeting = meetings.get(req.params.meetingId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  req.meeting = meeting;
  next();
}

function requireAdmin(req, res, next) {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== req.meeting.adminToken) {
    return res.status(403).json({ error: 'Admin token required' });
  }
  next();
}

// ─── REST API ── Meetings ───────────────────────────────────────────────────

// Create meeting
app.post('/api/meetings', authApi, (req, res) => {
  const id = generateMeetingId();
  const adminToken = uuidv4();
  const meeting = {
    id,
    adminToken,
    title: req.body.title || 'Untitled Meeting',
    createdAt: Date.now(),
    participants: new Map(),
    settings: {
      muteOnJoin: req.body.muteOnJoin ?? false,
      videoOffOnJoin: req.body.videoOffOnJoin ?? false,
      maxParticipants: req.body.maxParticipants ?? 50,
      locked: false,
    },
  };
  meetings.set(id, meeting);
  res.status(201).json({
    meetingId: id,
    adminToken,
    joinUrl: `/join/${id}`,
    title: meeting.title,
    settings: meeting.settings,
  });
});

// Get meeting info
app.get('/api/meetings/:meetingId', authApi, findMeeting, (req, res) => {
  const m = req.meeting;
  res.json({
    meetingId: m.id,
    title: m.title,
    createdAt: m.createdAt,
    participantCount: m.participants.size,
    participants: [...m.participants.values()].map(p => ({
      participantId: p.id,
      name: p.name,
      isMuted: p.isMuted,
      isVideoOff: p.isVideoOff,
      isScreenSharing: p.isScreenSharing,
      joinedAt: p.joinedAt,
    })),
    settings: m.settings,
  });
});

// List meetings
app.get('/api/meetings', authApi, (_req, res) => {
  const list = [...meetings.values()].map(m => ({
    meetingId: m.id,
    title: m.title,
    createdAt: m.createdAt,
    participantCount: m.participants.size,
  }));
  res.json({ meetings: list });
});

// Delete / end meeting
app.delete('/api/meetings/:meetingId', authApi, findMeeting, requireAdmin, (req, res) => {
  const m = req.meeting;
  // Notify all participants
  io.to(m.id).emit('meeting:ended', { reason: 'Meeting ended by admin' });
  meetings.delete(m.id);
  res.json({ message: 'Meeting ended' });
});

// Update meeting settings
app.patch('/api/meetings/:meetingId/settings', authApi, findMeeting, requireAdmin, (req, res) => {
  const allowed = ['muteOnJoin', 'videoOffOnJoin', 'maxParticipants', 'locked', 'title'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'title') req.meeting.title = req.body[key];
      else req.meeting.settings[key] = req.body[key];
    }
  }
  io.to(req.meeting.id).emit('meeting:settings-updated', req.meeting.settings);
  res.json({ settings: req.meeting.settings, title: req.meeting.title });
});

// ─── REST API ── Admin participant controls ─────────────────────────────────

// Mute participant
app.post('/api/meetings/:meetingId/participants/:participantId/mute', authApi, findMeeting, requireAdmin, (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  p.isMuted = true;
  io.to(p.socketId).emit('admin:mute');
  io.to(req.meeting.id).emit('participant:updated', { participantId: p.id, isMuted: true });
  res.json({ message: `${p.name} muted` });
});

// Unmute participant
app.post('/api/meetings/:meetingId/participants/:participantId/unmute', authApi, findMeeting, requireAdmin, (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  p.isMuted = false;
  io.to(p.socketId).emit('admin:unmute');
  io.to(req.meeting.id).emit('participant:updated', { participantId: p.id, isMuted: false });
  res.json({ message: `${p.name} unmuted` });
});

// Kick participant
app.post('/api/meetings/:meetingId/participants/:participantId/kick', authApi, findMeeting, requireAdmin, (req, res) => {
  const p = req.meeting.participants.get(req.params.participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  io.to(p.socketId).emit('admin:kick', { reason: req.body.reason || 'Removed by admin' });
  req.meeting.participants.delete(p.id);
  io.to(req.meeting.id).emit('participant:left', { participantId: p.id, name: p.name });
  res.json({ message: `${p.name} kicked` });
});

// Mute all
app.post('/api/meetings/:meetingId/mute-all', authApi, findMeeting, requireAdmin, (req, res) => {
  for (const p of req.meeting.participants.values()) {
    p.isMuted = true;
    io.to(p.socketId).emit('admin:mute');
  }
  io.to(req.meeting.id).emit('meeting:all-muted');
  res.json({ message: 'All participants muted' });
});

// Invite (generates a join link, optionally with a display name hint)
app.post('/api/meetings/:meetingId/invite', authApi, findMeeting, requireAdmin, (req, res) => {
  const inviteToken = uuidv4().slice(0, 8);
  const joinUrl = `/join/${req.meeting.id}?invite=${inviteToken}&name=${encodeURIComponent(req.body.name || '')}`;
  res.json({ joinUrl, inviteToken });
});

// Lock / unlock meeting
app.post('/api/meetings/:meetingId/lock', authApi, findMeeting, requireAdmin, (req, res) => {
  req.meeting.settings.locked = true;
  io.to(req.meeting.id).emit('meeting:settings-updated', req.meeting.settings);
  res.json({ locked: true });
});

app.post('/api/meetings/:meetingId/unlock', authApi, findMeeting, requireAdmin, (req, res) => {
  req.meeting.settings.locked = false;
  io.to(req.meeting.id).emit('meeting:settings-updated', req.meeting.settings);
  res.json({ locked: false });
});

// ─── HTML routes ────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/join/:meetingId', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'meeting.html')));

// ─── Socket.IO signaling ────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentMeetingId = null;
  let currentParticipantId = null;

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
    const participant = {
      id: participantId,
      socketId: socket.id,
      name: name || 'Anonymous',
      isMuted: meeting.settings.muteOnJoin,
      isVideoOff: meeting.settings.videoOffOnJoin,
      isScreenSharing: false,
      isHandRaised: false,
      isAdmin: isAdmin && adminToken === meeting.adminToken,
      joinedAt: Date.now(),
    };

    meeting.participants.set(participantId, participant);
    socket.join(meetingId);
    currentMeetingId = meetingId;
    currentParticipantId = participantId;

    // Send existing participants to the newcomer
    const existing = [...meeting.participants.values()]
      .filter(p => p.id !== participantId)
      .map(p => ({ participantId: p.id, name: p.name, isMuted: p.isMuted, isVideoOff: p.isVideoOff, isScreenSharing: p.isScreenSharing, isHandRaised: p.isHandRaised || false, isAdmin: p.isAdmin }));

    socket.emit('joined', {
      participantId,
      participants: existing,
      settings: meeting.settings,
      title: meeting.title,
      isAdmin: participant.isAdmin,
      muteOnJoin: meeting.settings.muteOnJoin,
      videoOffOnJoin: meeting.settings.videoOffOnJoin,
    });

    // Notify others
    socket.to(meetingId).emit('participant:joined', {
      participantId,
      name: participant.name,
      isMuted: participant.isMuted,
      isVideoOff: participant.isVideoOff,
      isHandRaised: false,
      isAdmin: participant.isAdmin,
    });
  });

  // WebRTC signaling
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

  // Media state updates
  socket.on('media:toggle-audio', ({ isMuted }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) {
      p.isMuted = isMuted;
      socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isMuted });
    }
  });

  socket.on('media:toggle-video', ({ isVideoOff }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) {
      p.isVideoOff = isVideoOff;
      socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isVideoOff });
    }
  });

  socket.on('media:screen-share', ({ isScreenSharing }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) {
      p.isScreenSharing = isScreenSharing;
      socket.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isScreenSharing });
    }
  });

  socket.on('raise-hand', ({ isHandRaised }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (p) {
      p.isHandRaised = isHandRaised;
      io.to(currentMeetingId).emit('participant:updated', { participantId: currentParticipantId, isHandRaised });
    }
  });

  // Chat
  socket.on('chat:message', ({ text }) => {
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    if (!p) return;
    io.to(currentMeetingId).emit('chat:message', {
      from: currentParticipantId,
      name: p.name,
      text,
      timestamp: Date.now(),
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!currentMeetingId || !currentParticipantId) return;
    const meeting = meetings.get(currentMeetingId);
    if (!meeting) return;
    const p = meeting.participants.get(currentParticipantId);
    meeting.participants.delete(currentParticipantId);
    socket.to(currentMeetingId).emit('participant:left', {
      participantId: currentParticipantId,
      name: p ? p.name : 'Unknown',
    });
    // Auto-delete empty meetings after 60s
    if (meeting.participants.size === 0) {
      setTimeout(() => {
        const m = meetings.get(currentMeetingId);
        if (m && m.participants.size === 0) meetings.delete(currentMeetingId);
      }, 60000);
    }
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Meeting Service running on http://localhost:${PORT}`);
  console.log(`API docs at http://localhost:${PORT}/docs`);
  console.log(`Default API key: ${DEFAULT_API_KEY}`);
});
