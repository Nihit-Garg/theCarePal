// Runs the exported ONNX models in the browser (WebAssembly). No server, no cost,
// and the sensor data never leaves the device.
import * as ort from 'onnxruntime-web';
import { windowChannels, windowFeatures } from './signal.js';

ort.env.wasm.numThreads = 1; // tiny models; avoids needing cross-origin isolation
// The .wasm runtime is bundled by Vite and served with the app (no CDN, works offline).

export async function loadConfig(base = import.meta.env.BASE_URL) {
  const res = await fetch(`${base}models/model_config.json`);
  if (!res.ok) throw new Error(`Could not load model config (${res.status})`);
  return res.json();
}

/** Ensemble of LightGBM (on 20 features) and the 1D-CNN (on 4 channels). */
export class FallModel {
  static async load(cfg, position, base = import.meta.env.BASE_URL) {
    const files = cfg.positions[position].models;
    const [lgb, cnn] = await Promise.all([
      ort.InferenceSession.create(`${base}models/${files.lightgbm}`),
      ort.InferenceSession.create(`${base}models/${files.cnn}`),
    ]);
    return new FallModel(cfg, lgb, cnn);
  }

  constructor(cfg, lgb, cnn) {
    this.cfg = cfg;
    this.lgb = lgb;
    this.cnn = cnn;
  }

  async predict(window) {
    const { fs, pre, win } = this.cfg;
    const t0 = performance.now();
    const feats = windowFeatures(window, fs, pre);
    const ch = windowChannels(window, fs);
    const flat = new Float32Array(4 * win);
    ch.forEach((c, k) => flat.set(c, k * win));
    const [lo, co] = await Promise.all([
      this.lgb.run({ features: new ort.Tensor('float32', feats, [1, feats.length]) }),
      this.cnn.run({ channels: new ort.Tensor('float32', flat, [1, 4, win]) }),
    ]);
    const pLgb = lo.probabilities.data[1];
    const pCnn = co.prob.data[0];
    return { p: (pLgb + pCnn) / 2, pLgb, pCnn, ms: performance.now() - t0 };
  }
}
