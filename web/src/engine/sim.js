// Simulated devices. Streams real recordings (UMAFall subjects that the shipped
// models never saw) in real time, synchronised across phone and wrist, plus a
// synthetic heart-rate signal. Feeds the engine through exactly the same calls a
// real device adapter would use.

const QUIET_S = 6;
const LIE_AFTER_FALL_S = 25;
const TRANSITION_S = 1;

function jitter(s, amt = 0.004) {
  return s.map((v) => v + (Math.random() - 0.5) * amt);
}

function lerp(a, b, f) { return a.map((v, i) => v + (b[i] - v) * f); }

export async function loadReplays(base = import.meta.env.BASE_URL) {
  const res = await fetch(`${base}replays/index.json`);
  if (!res.ok) throw new Error(`Could not load demo replays (${res.status})`);
  const index = await res.json();
  const clips = await Promise.all(index.map(async (meta) => {
    const r = await (await fetch(`${base}replays/${meta.id}.json`)).json();
    let impact = 0, best = -1;
    r.wrist.forEach((s, i) => { const m = Math.hypot(...s); if (m > best) { best = m; impact = i; } });
    return { ...meta, ...r, impactIdx: impact };
  }));
  return clips;
}

/** Produces synchronised {phone, wrist} samples, one per call, forever. */
export class ScenarioPlayer {
  constructor(clips, fs) {
    this.fs = fs;
    this.clips = clips;
    this.background = clips.filter((c) => c.kind === 'adl' && !['Jogging', 'Hopping'].includes(c.activity));
    this.queue = [];
    this.current = null;
    this.pos = 0;
    this.last = { phone: [0, 0.99, 0.1], wrist: [0.1, -0.2, 0.97] };
    this.normalDay = true;
    this.onClipStart = () => {};
  }

  /** Play this clip next (after a short transition). */
  play(clip) {
    this.queue = [clip];
    this.current = null; // cut whatever is playing
  }

  nextSegment() {
    if (this.queue.length) return this.queue.shift();
    if (this.normalDay && Math.random() < 0.6) {
      return this.background[Math.floor(Math.random() * this.background.length)];
    }
    return { kind: 'quiet', title: 'Resting', duration: QUIET_S * this.fs };
  }

  makeSegment(clip) {
    // transition from the previous pose into the new clip, then the clip itself
    const seg = { clip, phone: [], wrist: [] };
    const first = clip.phone ? { phone: clip.phone[0], wrist: clip.wrist[0] } : this.last;
    const nT = TRANSITION_S * this.fs;
    for (let i = 1; i <= nT; i++) {
      seg.phone.push(lerp(this.last.phone, first.phone, i / nT));
      seg.wrist.push(lerp(this.last.wrist, first.wrist, i / nT));
    }
    seg.clipStart = seg.phone.length;
    if (clip.phone) {
      seg.phone.push(...clip.phone);
      seg.wrist.push(...clip.wrist);
      if (clip.kind === 'fall') { // the person stays down
        const p = clip.phone.at(-1), w = clip.wrist.at(-1);
        for (let i = 0; i < LIE_AFTER_FALL_S * this.fs; i++) { seg.phone.push(p); seg.wrist.push(w); }
      }
    } else {
      for (let i = 0; i < clip.duration; i++) { seg.phone.push(first.phone); seg.wrist.push(first.wrist); }
    }
    return seg;
  }

  next() {
    if (!this.current || this.pos >= this.current.phone.length) {
      this.current = this.makeSegment(this.nextSegment());
      this.pos = 0;
    }
    const seg = this.current;
    if (this.pos === seg.clipStart) this.onClipStart(seg.clip);
    const out = { phone: jitter(seg.phone[this.pos]), wrist: jitter(seg.wrist[this.pos]), clip: seg.clip,
      clipIdx: this.pos - seg.clipStart };
    this.last = { phone: seg.phone[this.pos], wrist: seg.wrist[this.pos] };
    this.pos++;
    return out;
  }
}

/** Synthetic heart rate: drifts around a resting baseline, rises with exertion,
 * and spikes ~20-30 bpm over ~15 s after a fall (stress response). Synthetic by
 * necessity — none of the public fall datasets record heart rate. */
export class HeartRateSim {
  constructor() {
    this.base = 70 + Math.random() * 8;
    this.bpm = this.base;
    this.target = this.base;
  }

  update(dt, clip, clipIdx, fs) {
    if (clip?.kind === 'fall' && clipIdx >= clip.impactIdx) this.target = this.base + 26;
    else if (['Jogging', 'Hopping'].includes(clip?.activity)) this.target = this.base + 30;
    else if (clip?.kind === 'adl') this.target = this.base + 6;
    else if (this.target > this.base) this.target -= dt * 0.15; // slow recovery
    this.bpm += (this.target - this.bpm) * Math.min(1, dt / 6) + (Math.random() - 0.5) * 0.6;
    void fs;
    return Math.round(this.bpm);
  }
}
