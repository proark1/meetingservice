'use strict';

// Test scheduled meeting activation logic in isolation

describe('Scheduled meeting activation', () => {
  let meetings, scheduledMeetings;

  beforeEach(() => {
    meetings = new Map();
    scheduledMeetings = new Map();
  });

  function activateScheduledMeeting(scheduled) {
    const meeting = {
      id: scheduled.id,
      adminToken: scheduled.adminToken,
      title: scheduled.title,
      createdAt: Date.now(),
      participants: new Map(),
      waitingRoom: new Map(),
      peakParticipants: 0,
      logId: null,
      ownerId: scheduled.ownerId || null,
      ownerCompanyId: scheduled.ownerCompanyId || null,
      settings: { ...scheduled.settings },
    };
    meetings.set(scheduled.id, meeting);
    scheduled.status = 'active';
    scheduledMeetings.delete(scheduled.id);
    return meeting;
  }

  test('activates scheduled meeting and moves to meetings Map', () => {
    const scheduled = {
      id: 'abc-defg-hij',
      adminToken: 'token123',
      title: 'Test Meeting',
      scheduledAt: Date.now() - 1000,
      status: 'scheduled',
      settings: { muteOnJoin: true, maxParticipants: 10 },
    };
    scheduledMeetings.set(scheduled.id, scheduled);

    activateScheduledMeeting(scheduled);

    expect(meetings.has('abc-defg-hij')).toBe(true);
    expect(scheduledMeetings.has('abc-defg-hij')).toBe(false);
    expect(scheduled.status).toBe('active');
  });

  test('preserves settings from scheduled meeting', () => {
    const scheduled = {
      id: 'test-meet',
      adminToken: 'tok',
      title: 'Settings Test',
      scheduledAt: Date.now(),
      status: 'scheduled',
      settings: { muteOnJoin: true, videoOffOnJoin: true, maxParticipants: 5, locked: true, waitingRoom: true },
    };
    scheduledMeetings.set(scheduled.id, scheduled);

    const meeting = activateScheduledMeeting(scheduled);

    expect(meeting.settings.muteOnJoin).toBe(true);
    expect(meeting.settings.videoOffOnJoin).toBe(true);
    expect(meeting.settings.maxParticipants).toBe(5);
    expect(meeting.settings.locked).toBe(true);
    expect(meeting.settings.waitingRoom).toBe(true);
  });

  test('propagates ownerId and ownerCompanyId', () => {
    const scheduled = {
      id: 'owner-test',
      adminToken: 'tok',
      title: 'Owner Test',
      scheduledAt: Date.now(),
      status: 'scheduled',
      settings: {},
      ownerId: 42,
      ownerCompanyId: 7,
    };
    scheduledMeetings.set(scheduled.id, scheduled);

    const meeting = activateScheduledMeeting(scheduled);

    expect(meeting.ownerId).toBe(42);
    expect(meeting.ownerCompanyId).toBe(7);
  });

  test('handles missing ownerId gracefully', () => {
    const scheduled = {
      id: 'no-owner',
      adminToken: 'tok',
      title: 'No Owner',
      scheduledAt: Date.now(),
      status: 'scheduled',
      settings: {},
    };
    scheduledMeetings.set(scheduled.id, scheduled);

    const meeting = activateScheduledMeeting(scheduled);

    expect(meeting.ownerId).toBeNull();
    expect(meeting.ownerCompanyId).toBeNull();
  });

  test('creates empty participants and waiting room Maps', () => {
    const scheduled = {
      id: 'maps-test',
      adminToken: 'tok',
      title: 'Maps Test',
      scheduledAt: Date.now(),
      status: 'scheduled',
      settings: {},
    };
    scheduledMeetings.set(scheduled.id, scheduled);

    const meeting = activateScheduledMeeting(scheduled);

    expect(meeting.participants).toBeInstanceOf(Map);
    expect(meeting.participants.size).toBe(0);
    expect(meeting.waitingRoom).toBeInstanceOf(Map);
    expect(meeting.waitingRoom.size).toBe(0);
  });
});
