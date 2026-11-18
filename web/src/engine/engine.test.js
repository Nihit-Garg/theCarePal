// The browser engine (real ONNX models, run in Node) must raise exactly the same
// alarms as the Python evaluation code: single-device streams and fused
// phone + wrist replays. golden.json comes from `python ml/scripts/export_models.py`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { beforeAll, describe, expect, it } from 'vitest';
import { FallEngine } from './engine.js';
import { FallModel } from './model.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const golden = JSON.parse(readFileSync(here('./golden.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(here('../../public/models/model_config.json'), 'utf8'));
ort.env.wasm.numThreads = 1;

let models;
beforeAll(async () => {
  const load = (f) => ort.InferenceSession.create(readFileSync(here(`../../public/models/${f}`)));
  models = {};
  for (const pos of ['phone', 'wrist']) {
    const f = cfg.positions[pos].models;
    models[pos] = new FallModel(cfg, await load(f.lightgbm), await load(f.cnn));
  }
});

/** Stream synchronised samples through a fresh engine; returns alarm sample indices + candidates.
 * idleEvery = 1 waits for inference after every sample, i.e. real-time order: each candidate
 * is scored before the next sample arrives, so fused decisions are resolved by the engine's
 * own wait (fuseWait) exactly as in the app. Larger values batch inference (fast path). */
async function run(streams, idleEvery = 200) {
  const engine = new FallEngine(cfg, models);
  const alarms = [], cands = { phone: [], wrist: [] };
  engine.on((type, d) => {
    if (type === 'alarm') alarms.push(Math.round(d.t * cfg.fs));
    if (type === 'candidate') cands[d.device].push({ i: Math.round(d.t * cfg.fs), p: d.p });
  });
  for (const id of Object.keys(streams)) engine.setDeviceStatus(id, { connected: true, worn: true });
  const n = Math.max(...Object.values(streams).map((s) => s.length));
  for (let i = 0; i < n; i++) {
    const t = i / cfg.fs;
    for (const [id, s] of Object.entries(streams)) if (i < s.length) engine.pushSample(id, s[i], t);
    engine.tick(t);
    if (i % idleEvery === 0) await engine.idle();
  }
  await engine.idle();
  engine.tick(n / cfg.fs + 60); // resolve any pending fused decisions
  return { alarms, cands };
}

describe.each(['phone', 'wrist'])('%s stream', (pos) => {
  it('candidates, probabilities and alarms match Python', async () => {
    const g = golden.positions[pos].stream;
    const { alarms, cands } = await run({ [pos]: g.acc });
    expect(cands[pos].map((c) => c.i)).toEqual(g.candidate_peaks);
    cands[pos].forEach((c, k) => expect(Math.abs(c.p - g.candidate_probs[k])).toBeLessThan(1e-3));
    expect(alarms).toEqual(g.alarms);
  });
});

describe('fused phone + wrist (synchronised held-out replays)', () => {
  it('uses the fusion settings exported from Python', () => {
    expect(cfg.fusion.rule).toBe('logodds');
  });
  for (const c of golden.fusion.cases) {
    for (const [mode, every] of [['batched', 200], ['real-time order', 1]]) {
      it(`${c.activity} (${mode}): same candidates, probabilities and fused alarms as Python`, async () => {
        const { alarms, cands } = await run({ phone: c.phone, wrist: c.wrist }, every);
        for (const pos of ['phone', 'wrist']) {
          expect(cands[pos].map((x) => x.i)).toEqual(c.candidates[pos].peaks);
          cands[pos].forEach((x, k) => expect(Math.abs(x.p - c.candidates[pos].probs[k])).toBeLessThan(1e-3));
        }
        expect(alarms).toEqual(c.alarms);
      });
    }
  }
  it('golden thresholds are the shipped ones', () => {
    for (const pos of ['phone', 'wrist']) expect(golden.fusion.thresholds[pos]).toBe(cfg.positions[pos].threshold);
  });
});
