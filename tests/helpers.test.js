'use strict';

const crypto = require('crypto');

// Test helper functions extracted from server.js

describe('generateMeetingId', () => {
  function generateMeetingId() {
    const seg = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
    return `${seg(3)}-${seg(4)}-${seg(3)}`;
  }

  test('generates correct format (xxx-xxxx-xxx)', () => {
    const id = generateMeetingId();
    expect(id).toMatch(/^[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{3}$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMeetingId()));
    expect(ids.size).toBe(100);
  });

  test('uses crypto.randomBytes (not Math.random)', () => {
    const spy = jest.spyOn(crypto, 'randomBytes');
    generateMeetingId();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('escapeHtml (regex-based)', () => {
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  test('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  test('escapes quotes', () => {
    expect(escapeHtml('he said "hello"')).toBe('he said &quot;hello&quot;');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  test('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('handles non-string input', () => {
    expect(escapeHtml(123)).toBe('123');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });

  test('preserves safe characters', () => {
    expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
  });
});

describe('Hand raise queue sorting', () => {
  function sortParticipants(entries) {
    return entries.sort(([,a], [,b]) => {
      if (a.isHandRaised && !b.isHandRaised) return -1;
      if (!a.isHandRaised && b.isHandRaised) return 1;
      if (a.isHandRaised && b.isHandRaised) return (a.handRaisedAt || 0) - (b.handRaisedAt || 0);
      return 0;
    });
  }

  test('raised hands come first', () => {
    const entries = [
      ['a', { name: 'Alice', isHandRaised: false }],
      ['b', { name: 'Bob', isHandRaised: true, handRaisedAt: 1000 }],
      ['c', { name: 'Charlie', isHandRaised: false }],
    ];
    const sorted = sortParticipants(entries);
    expect(sorted[0][1].name).toBe('Bob');
  });

  test('earlier hand raises come first', () => {
    const entries = [
      ['a', { name: 'Alice', isHandRaised: true, handRaisedAt: 3000 }],
      ['b', { name: 'Bob', isHandRaised: true, handRaisedAt: 1000 }],
      ['c', { name: 'Charlie', isHandRaised: true, handRaisedAt: 2000 }],
    ];
    const sorted = sortParticipants(entries);
    expect(sorted.map(([,p]) => p.name)).toEqual(['Bob', 'Charlie', 'Alice']);
  });

  test('non-raised hands maintain relative order', () => {
    const entries = [
      ['a', { name: 'Alice', isHandRaised: false }],
      ['b', { name: 'Bob', isHandRaised: false }],
    ];
    const sorted = sortParticipants(entries);
    expect(sorted[0][1].name).toBe('Alice');
    expect(sorted[1][1].name).toBe('Bob');
  });

  test('handles empty list', () => {
    expect(sortParticipants([])).toEqual([]);
  });

  test('handles null handRaisedAt', () => {
    const entries = [
      ['a', { name: 'Alice', isHandRaised: true, handRaisedAt: null }],
      ['b', { name: 'Bob', isHandRaised: true, handRaisedAt: 1000 }],
    ];
    const sorted = sortParticipants(entries);
    expect(sorted[0][1].name).toBe('Alice'); // null → 0, comes first
    expect(sorted[1][1].name).toBe('Bob');
  });
});

describe('Avatar color computation', () => {
  const AVATAR_COLORS = ['#4f46e5','#7c3aed','#ec4899','#06b6d4','#f59e0b','#10b981'];

  function getAvatarColor(pid) {
    let h = 0;
    for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  test('returns a valid color from the palette', () => {
    const color = getAvatarColor('test-user-id');
    expect(AVATAR_COLORS).toContain(color);
  });

  test('same PID always returns same color', () => {
    const c1 = getAvatarColor('abc-123');
    const c2 = getAvatarColor('abc-123');
    expect(c1).toBe(c2);
  });

  test('different PIDs can produce different colors', () => {
    const colors = new Set(Array.from({ length: 20 }, (_, i) => getAvatarColor(`pid-${i}`)));
    expect(colors.size).toBeGreaterThan(1);
  });
});
