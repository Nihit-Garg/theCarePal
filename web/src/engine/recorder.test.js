import { describe, expect, it } from 'vitest';
import { CSV_HEADER, SessionRecorder } from './recorder.js';

describe('session recorder', () => {
  function fakeEngine() {
    const taps = new Set(), listeners = new Set();
    return {
      tap: (fn) => { taps.add(fn); return () => taps.delete(fn); },
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      sample: (dev, v, t) => taps.forEach((fn) => fn('sample', dev, v, t)),
      emit: (type, d) => listeners.forEach((fn) => fn(type, d)),
    };
  }

  it('records samples, labels and alarms as CSV, and stops cleanly', () => {
    const eng = fakeEngine();
    const rec = new SessionRecorder(eng);
    rec.start('test');
    const t0 = rec.t0;
    eng.sample('phone', [0, 0, 1], t0 + 0.05);
    eng.sample('wrist', [0.1, 0.2, 0.9], t0 + 0.05);
    rec.mark('fall');
    eng.emit('alarm', { t: t0 + 0.04, mode: { key: 'BOTH' }, reason: 'x' });
    rec.stop();
    eng.sample('phone', [9, 9, 9], t0 + 1); // after stop: ignored
    const lines = rec.toCsv().trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.filter((l) => l.includes(',phone,'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('mark_fall'))).toBe(true);
    expect(lines.some((l) => l.includes(',alarm,BOTH x'))).toBe(true);
    const ts = lines.slice(1).map(parseFloat);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts); // sorted by time
    expect(rec.counts).toEqual({ phone: 1, wrist: 1 });
  });
});
