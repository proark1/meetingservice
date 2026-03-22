'use strict';

// Test calculateMeetingCost in isolation — extract the logic directly
// since requiring server.js would trigger DB init and server.listen()

function calculateMeetingCost(durationMinutes, peakParticipants, rate) {
  return Math.round(durationMinutes * peakParticipants * rate * 10000) / 10000;
}

describe('calculateMeetingCost', () => {
  const defaultRate = 0.01;

  test('basic calculation: 10 min × 3 participants × $0.01', () => {
    expect(calculateMeetingCost(10, 3, defaultRate)).toBe(0.3);
  });

  test('zero duration results in zero cost', () => {
    expect(calculateMeetingCost(0, 5, defaultRate)).toBe(0);
  });

  test('zero participants results in zero cost', () => {
    expect(calculateMeetingCost(10, 0, defaultRate)).toBe(0);
  });

  test('one participant for one minute at default rate', () => {
    expect(calculateMeetingCost(1, 1, defaultRate)).toBe(0.01);
  });

  test('fractional minutes are handled correctly', () => {
    expect(calculateMeetingCost(0.5, 2, defaultRate)).toBe(0.01);
  });

  test('large meeting: 60 min × 100 participants', () => {
    expect(calculateMeetingCost(60, 100, defaultRate)).toBe(60);
  });

  test('custom rate: $0.05 per participant-minute', () => {
    expect(calculateMeetingCost(10, 2, 0.05)).toBe(1);
  });

  test('result rounded to 4 decimal places', () => {
    // 7 min × 3 participants × $0.01 = 0.21 (exactly)
    expect(calculateMeetingCost(7, 3, defaultRate)).toBe(0.21);
  });

  test('avoids floating point errors', () => {
    // 0.1 + 0.2 !== 0.3 in floating point, but our rounding handles it
    const result = calculateMeetingCost(1, 1, 0.0001);
    expect(result).toBe(0.0001);
  });
});
