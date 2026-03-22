'use strict';

// Integration-style tests for REST API endpoints
// These require a running PostgreSQL database (used in CI with service container)
// Skip gracefully if DATABASE_PUBLIC_URL is not set

const canRunIntegration = !!process.env.DATABASE_PUBLIC_URL;

const conditionalDescribe = canRunIntegration ? describe : describe.skip;

conditionalDescribe('REST API Integration', () => {
  let app, server, meetings;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'test-secret';
    // Require server — this triggers initDB and server.listen
    const mod = require('../server');
    app = mod.app;
    server = mod.server;
    meetings = mod.meetings;
    // Wait a moment for server to start
    await new Promise(r => setTimeout(r, 2000));
  });

  afterAll(async () => {
    if (server) server.close();
  });

  test('GET /health returns 200', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  test('GET /api/config returns feature flags', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('registrationEnabled');
  });

  test('POST /api/meetings without API key returns 401', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /api/meetings with valid API key returns 201', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'mk_default_test_key',
      },
      body: JSON.stringify({ title: 'Integration Test Meeting' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty('meetingId');
    expect(data).toHaveProperty('adminToken');
    expect(data).toHaveProperty('joinUrl');
    expect(data.title).toBe('Integration Test Meeting');
  });

  test('GET /api/meetings lists meetings', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings`, {
      headers: { 'x-api-key': 'mk_default_test_key' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('meetings');
    expect(Array.isArray(data.meetings)).toBe(true);
  });

  test('DELETE /api/meetings/:id without admin token returns 403', async () => {
    // Create a meeting first
    const createRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'mk_default_test_key' },
      body: JSON.stringify({ title: 'To Delete' }),
    });
    const { meetingId } = await createRes.json();

    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings/${meetingId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': 'mk_default_test_key' },
    });
    expect(res.status).toBe(403);
  });

  test('DELETE /api/meetings/:id with admin token returns 200', async () => {
    const createRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'mk_default_test_key' },
      body: JSON.stringify({ title: 'To Delete Properly' }),
    });
    const { meetingId, adminToken } = await createRes.json();

    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings/${meetingId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': 'mk_default_test_key', 'x-admin-token': adminToken },
    });
    expect(res.status).toBe(200);
  });

  test('GET /api/meetings/:id for nonexistent meeting returns 404', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings/nonexistent-id`, {
      headers: { 'x-api-key': 'mk_default_test_key' },
    });
    expect(res.status).toBe(404);
  });

  test('POST /api/meetings/guest creates guest meeting', async () => {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Guest Meeting' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty('meetingId');
    expect(data).toHaveProperty('adminToken');
  });

  test('GET /api/meetings/:id/transcript returns messages', async () => {
    const createRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'mk_default_test_key' },
      body: JSON.stringify({ title: 'Transcript Test' }),
    });
    const { meetingId } = await createRes.json();

    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/meetings/${meetingId}/transcript`, {
      headers: { 'x-api-key': 'mk_default_test_key' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('messages');
    expect(Array.isArray(data.messages)).toBe(true);
  });
});
