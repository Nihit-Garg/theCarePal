"""Train the final models and export everything the web demo needs.

    python ml/scripts/export_models.py

For each position (phone, wrist):
  * trains LightGBM + CNN on all subjects except the DEMO subjects,
  * exports both to ONNX and verifies ONNX Runtime == Python (max abs diff),
  * uses the threshold chosen by nested CV (median across outer folds, from
    reports/metrics.json) so the shipped operating point is the evaluated one.
Also writes:
  * web/public/models/model_config.json — pipeline constants + per-position settings
  * web/public/replays/*.json — synchronised phone+wrist recordings of the held-out
    DEMO subjects (the simulator streams these; the models never saw these people)
  * web/src/engine/golden.json — test vectors for the JS port (npm test): resampling,
    channels, features, model outputs, single-device stream alarms, and fused alarms
    on synchronised held-out replays
"""
from __future__ import annotations

import json
from collections import Counter

import numpy as np
import onnxruntime as ort
import torch
from onnxmltools import convert_lightgbm
from onnxmltools.convert.common.data_types import FloatTensorType

from fallguard import config
from fallguard.datasets import bin_resample, load_recordings
from fallguard.detector import alarms_from_candidates, score_recording
from fallguard.evaluate import choose_trigger, training_windows
from fallguard.fusion import DEFAULT_RULE, LOGODDS_CLIP, MATCH_S, fuse
from fallguard.models import ClassicModel, CNNModel, EnsembleModel
from fallguard.signal import FEATURE_NAMES, extract_window, window_channels, window_features

DEPLOYED = "ensemble"
N_DEMO_SUBJECTS = 2
REPLAY_ACTIVITIES = ["forwardFall", "backwardFall", "lateralFall", "Walking", "Jogging",
                     "Sitting_GettingUpOnAChair", "LyingDown_OnABed", "Bending", "Aplausing",
                     "GoDownstairs", "OpeningDoor", "MakingACall", "HandsUp", "Hopping"]
PRETTY = {"forwardFall": "Forward fall", "backwardFall": "Backward fall", "lateralFall": "Sideways fall",
          "Walking": "Walking", "Jogging": "Jogging", "Sitting_GettingUpOnAChair": "Sit down & stand up",
          "LyingDown_OnABed": "Lying down on a bed", "Bending": "Bending to pick something up",
          "Aplausing": "Clapping", "GoDownstairs": "Going downstairs", "OpeningDoor": "Opening a door",
          "MakingACall": "Phone call", "HandsUp": "Raising hands", "Hopping": "Hopping"}


def pick_demo_subjects(recs) -> list[str]:
    """UMAFall subjects with every fall type recorded on both phone and wrist."""
    by_subj: dict[str, Counter] = {}
    for r in recs["wrist"]:
        by_subj.setdefault(r.subject, Counter())[r.activity] += 1
    phone_trials = {r.trial_id for r in recs["phone"]}
    ok = [s for s, c in by_subj.items()
          if all(c[a] for a in ("forwardFall", "backwardFall", "lateralFall"))
          and sum(r.trial_id in phone_trials for r in recs["wrist"] if r.subject == s) >= 20]
    ok.sort(key=lambda s: -sum(by_subj[s].values()))
    return sorted(ok[:N_DEMO_SUBJECTS])


def export_lightgbm(model: ClassicModel, path) -> None:
    onx = convert_lightgbm(model.clf, initial_types=[("features", FloatTensorType([None, len(FEATURE_NAMES)]))],
                           zipmap=False, target_opset=15)
    path.write_bytes(onx.SerializeToString())


class _CNNWithSigmoid(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, channels):
        return torch.sigmoid(self.net(channels))


def export_cnn(model: CNNModel, path) -> None:
    model.net.eval()
    torch.onnx.export(_CNNWithSigmoid(model.net), torch.zeros(1, 4, config.WIN), str(path),
                      input_names=["channels"], output_names=["prob"],
                      dynamic_axes={"channels": {0: "n"}, "prob": {0: "n"}}, opset_version=15, dynamo=False)


def verify_onnx(ens: EnsembleModel, lgb_path, cnn_path, wins: np.ndarray) -> dict:
    lgb_s = ort.InferenceSession(str(lgb_path))
    cnn_s = ort.InferenceSession(str(cnn_path))
    feats = ClassicModel.featurize(wins)
    chans = CNNModel.channels(wins)
    p_lgb = lgb_s.run(None, {"features": feats})[1][:, 1]
    p_cnn = cnn_s.run(None, {"channels": chans})[0]
    lgb_m, cnn_m = ens.members
    return {"lightgbm_max_abs_diff": float(np.abs(p_lgb - lgb_m.predict_proba(wins)).max()),
            "cnn_max_abs_diff": float(np.abs(p_cnn - cnn_m.predict_proba(wins)).max())}


def replay_json(phone, wrist) -> dict:
    """Align the two simultaneous streams on their real start times."""
    def pad_front(acc, ms):
        n = round(ms / config.BIN_MS)
        return np.concatenate([np.repeat(acc[:1], n, 0), acc]) if n > 0 else acc
    t0 = min(phone.meta["t0_ms"], wrist.meta["t0_ms"])
    p = pad_front(phone.acc, phone.meta["t0_ms"] - t0)
    w = pad_front(wrist.acc, wrist.meta["t0_ms"] - t0)
    n = min(len(p), len(w))
    return {
        "id": wrist.trial_id.replace(":", "_"), "activity": wrist.activity,
        "title": PRETTY.get(wrist.activity, wrist.activity), "kind": "fall" if wrist.label else "adl",
        "subject": wrist.subject, "fs": config.FS,
        "phone": np.round(p[:n], 3).tolist(), "wrist": np.round(w[:n], 3).tolist(),
    }


def golden_vectors(pos, recs, ens: EnsembleModel, trig: float, thr: float) -> dict:
    rng = np.random.default_rng(0)
    falls = [r for r in recs if r.label]
    adls = [r for r in recs if not r.label]
    picks = [falls[i] for i in rng.choice(len(falls), 3, replace=False)] + \
            [adls[i] for i in rng.choice(len(adls), 3, replace=False)]
    windows = []
    for r in picks:
        p = int(np.argmax((r.acc ** 2).sum(1)))
        w = extract_window(r.acc, p)
        windows.append({"window": np.round(w, 6).tolist(),
                        "channels": window_channels(w).tolist(),
                        "features": window_features(w).tolist(),
                        "p_lightgbm": float(ens.members[0].predict_proba(w[None])[0]),
                        "p_cnn": float(ens.members[1].predict_proba(w[None])[0])})
    stream_rec = max(falls, key=lambda r: r.duration_s)
    c = score_recording(stream_rec.acc, ens, trig)
    return {"position": pos, "windows": windows,
            "stream": {"acc": np.round(stream_rec.acc, 6).tolist(), "trigger_g": trig, "threshold": thr,
                       "candidate_peaks": c.peaks.tolist(), "candidate_probs": c.probs.tolist(),
                       "alarms": alarms_from_candidates(c, thr).tolist()}}


def fusion_golden(replays: list[dict], models: dict) -> list[dict]:
    """Fused alarms on synchronised replays (one fall, two tricky everyday activities)."""
    first = lambda activity: next(r for r in replays if r["activity"] == activity)  # noqa: E731
    # one fall + the two hardest everyday activities for the wrist
    pick = [next(r for r in replays if r["kind"] == "fall"), first("LyingDown_OnABed"), first("Aplausing")]
    cases = []
    for r in pick:
        acc = {pos: np.asarray(r[pos], dtype=np.float32) for pos in config.POSITIONS}
        cands = {pos: score_recording(acc[pos], models[pos][0], models[pos][1]) for pos in config.POSITIONS}
        alarms = fuse(cands["phone"], cands["wrist"], models["phone"][2], models["wrist"][2], DEFAULT_RULE)
        cases.append({"id": r["id"], "activity": r["activity"], "phone": r["phone"], "wrist": r["wrist"],
                      "candidates": {pos: {"peaks": c.peaks.tolist(), "probs": c.probs.tolist()} for pos, c in cands.items()},
                      "alarms": alarms.tolist()})
    return cases


def resample_golden() -> dict:
    rng = np.random.default_rng(1)
    t = np.cumsum(rng.uniform(5, 40, 200))       # irregular 25-200 Hz timestamps (ms)
    xyz = rng.normal(0, 1, (200, 3))
    return {"t_ms": t.tolist(), "xyz": xyz.tolist(), "expected": bin_resample(t, xyz).tolist()}


def main() -> None:
    data = load_recordings()
    metrics = json.loads((config.REPORTS_DIR / "metrics.json").read_text())
    demo_subjects = pick_demo_subjects(data)
    print("demo (held-out) subjects:", demo_subjects)
    config.WEB_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    config.WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)

    model_cfg = {"fs": config.FS, "pre": config.PRE, "post": config.POST, "win": config.WIN,
                 "peak_half_width": config.PEAK_HALF_WIDTH, "refractory_s": config.REFRACTORY_S,
                 "fusion": {"rule": DEFAULT_RULE, "match_s": MATCH_S, "logodds_clip": LOGODDS_CLIP},
                 "feature_names": FEATURE_NAMES,
                 "deployed_model": DEPLOYED,  # informational: the browser always runs this ensemble (model.js)
                 "demo_subjects": demo_subjects, "positions": {}}
    golden = {"resample": resample_golden(), "positions": {}}
    models = {}
    for pos in config.POSITIONS:
        recs = [r for r in data[pos] if r.subject not in demo_subjects]
        trig = choose_trigger(recs)
        thr = float(np.median(metrics[pos]["models"][DEPLOYED]["thresholds_per_fold"]))
        X, y = training_windows(recs, trig)
        print(f"{pos}: training on {len({r.subject for r in recs})} subjects, {len(y)} windows "
              f"({y.sum()} fall), trigger={trig:.2f} g, threshold={thr:.2f}", flush=True)
        ens = EnsembleModel().fit(X, y)
        lgb_path = config.WEB_MODELS_DIR / f"{pos}_lightgbm.onnx"
        cnn_path = config.WEB_MODELS_DIR / f"{pos}_cnn.onnx"
        export_lightgbm(ens.members[0], lgb_path)
        export_cnn(ens.members[1], cnn_path)
        check = verify_onnx(ens, lgb_path, cnn_path, X[:: max(1, len(X) // 500)])
        print(f"  ONNX parity: {check}")
        assert max(check.values()) < 1e-4, "ONNX output differs from the Python model"
        m = metrics[pos]["models"][DEPLOYED]
        model_cfg["positions"][pos] = {
            "trigger_g": trig, "threshold": thr,
            "models": {"lightgbm": lgb_path.name, "cnn": cnn_path.name},
            "model_bytes": {"lightgbm": lgb_path.stat().st_size, "cnn": cnn_path.stat().st_size},
            "cnn_params": ens.members[1].n_params, "onnx_parity": check,
            "cv_metrics": {k: m[k] for k in ("sensitivity", "specificity", "false_alarms_per_hour")},
            "top_features": dict(list(ens.members[0].feature_importance().items())[:8]),
        }
        golden["positions"][pos] = golden_vectors(pos, recs, ens, trig, thr)
        models[pos] = (ens, trig, thr)

    (config.WEB_MODELS_DIR / "model_config.json").write_text(json.dumps(model_cfg, indent=2))

    # demo replays: synchronised phone + wrist streams from held-out subjects
    phone_by_trial = {r.trial_id: r for r in data["phone"] if r.dataset == "umafall"}
    index, replays = [], []
    for w in data["wrist"]:
        if w.subject not in demo_subjects or w.activity not in REPLAY_ACTIVITIES:
            continue
        if w.trial_id not in phone_by_trial or "t0_ms" not in w.meta:
            continue
        rj = replay_json(phone_by_trial[w.trial_id], w)
        if len([i for i in index if i["activity"] == rj["activity"]]) >= 2:
            continue  # two takes per activity is plenty
        (config.WEB_DATA_DIR / f"{rj['id']}.json").write_text(json.dumps(rj, separators=(",", ":")))
        replays.append(rj)
        index.append({k: rj[k] for k in ("id", "title", "kind", "activity", "subject")} |
                     {"duration_s": round(len(rj["wrist"]) / config.FS, 1)})
    index.sort(key=lambda i: (i["kind"] != "fall", i["title"]))
    (config.WEB_DATA_DIR / "index.json").write_text(json.dumps(index, indent=1))

    golden["fusion"] = {"thresholds": {p: models[p][2] for p in config.POSITIONS},
                        "cases": fusion_golden(sorted(replays, key=lambda r: r["id"]), models)}
    (config.ROOT / "web" / "src" / "engine" / "golden.json").write_text(json.dumps(golden))
    print(f"wrote {len(index)} replays, models and config to {config.WEB_MODELS_DIR.parent}")


if __name__ == "__main__":
    main()
