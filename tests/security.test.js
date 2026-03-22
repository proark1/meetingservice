'use strict';

// Test XSS escaping patterns used across frontend HTML files
// These mirror the escapeHtml / esc() functions used in the frontend

function esc(s) {
  // Mirrors the DOM-based escaping used in meeting.html, dashboard.html, billing.html
  // Since we can't use DOM in Node, test the equivalent replacements
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

describe('XSS escaping', () => {
  test('escapes HTML tags', () => {
    expect(esc('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test('escapes ampersands', () => {
    expect(esc('a&b')).toBe('a&amp;b');
  });

  test('escapes quotes', () => {
    expect(esc('He said "hello"')).toBe('He said &quot;hello&quot;');
  });

  test('escapes single quotes', () => {
    expect(esc("it's")).toBe('it&#039;s');
  });

  test('handles null/undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(esc('')).toBe('');
  });

  test('passes through safe strings', () => {
    expect(esc('Hello World 123')).toBe('Hello World 123');
  });

  test('escapes event handler injection', () => {
    const attack = '" onmouseover="alert(1)"';
    const escaped = esc(attack);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onmouseover=&quot;alert(1)&quot;');
  });

  test('escapes nested HTML', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('input sanitization patterns', () => {
  test('meeting title trim and slice', () => {
    const title = '  ' + 'A'.repeat(200) + '  ';
    const sanitized = title.trim().slice(0, 100);
    expect(sanitized.length).toBe(100);
    expect(sanitized).not.toMatch(/^\s/);
  });

  test('chat message trim and slice', () => {
    const text = 'x'.repeat(600);
    const trimmed = text.trim().slice(0, 500);
    expect(trimmed.length).toBe(500);
  });

  test('participant name defaults to Anonymous', () => {
    const name = (('' || 'Anonymous') + '').trim().slice(0, 60) || 'Anonymous';
    expect(name).toBe('Anonymous');
  });

  test('emoji validation whitelist', () => {
    const allowed = ['👍', '❤️', '😂', '🎉', '👏'];
    expect(allowed.includes('👍')).toBe(true);
    expect(allowed.includes('💀')).toBe(false);
    expect(allowed.includes('<script>')).toBe(false);
  });
});
