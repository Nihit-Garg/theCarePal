"""Evaluate phone+wrist fusion rules on UMAFall, where both were recorded simultaneously.

    python ml/scripts/eval_fusion.py            # train + score (cached), then evaluate
    python ml/scripts/eval_fusion.py --cached   # re-evaluate with current thresholds

Subject-wise 5-fold CV over the 19 UMAFall subjects. Per fold, the phone model
trains on all other phone data (incl. SisFall, whose subjects are disjoint) and
the wrist model on the other UMAFall subjects. Thresholds are the deployed ones
(nested-CV medians from reports/metrics.json). Writes reports/fusion.json/.md.
"""
from __future__ import annotations

import argparse
import json
import pickle

import numpy as np

from fallguard import config
from fallguard.detector import alarms_from_candidates, main_impact, score_recording
from fallguard.evaluate import MATCH_TOL, choose_trigger, subject_folds, summarize, training_windows
from fallguard.fusion import RULES, fuse
from fallguard.models import EnsembleModel


def counts(pairs, alarm_fn) -> dict:
    tp = fn = tn = fpt = fa = 0
    hours = 0.0
    for _phone, wr, c in pairs:
        alarms = alarm_fn(c)
        if wr.label:
            imp = main_impact(wr.acc)
            hit = len(alarms) and np.min(np.abs(alarms - imp)) <= MATCH_TOL
            tp, fn = tp + int(bool(hit)), fn + int(not hit)
        else:
            hours += wr.duration_s / 3600
            fa += len(alarms)
            tn, fpt = tn + (len(alarms) == 0), fpt + (len(alarms) > 0)
    return summarize(dict(tp=tp, fn=fn, tn=tn, fp_trials=fpt, false_alarms=fa, adl_hours=hours))


CACHE = config.PROCESSED_DIR / "fusion_scores.pkl"


def score_all() -> list:
    data = pickle.loads(config.PROCESSED_DIR / "recordings.pkl".read_bytes())
    phone_by_trial = {r.trial_id: r for r in data["phone"] if r.dataset == "umafall"}
    pairs_all = [(phone_by_trial[w.trial_id], w) for w in data["wrist"] if w.trial_id in phone_by_trial]
    uma_subjects = sorted({w.subject for _, w in pairs_all})

    scored = []  # (phone_rec, wrist_rec, {"phone": Candidates, "wrist": Candidates})
    for fi, test_subj in enumerate(subject_folds(uma_subjects, 5, seed=7)):
        models = {}
        for pos in config.POSITIONS:
            train = [r for r in data[pos] if r.subject not in test_subj]
            trig = choose_trigger(train)
            X, y = training_windows(train, trig)
            models[pos] = (EnsembleModel().fit(X, y), trig)
        test_pairs = [(p, w) for p, w in pairs_all if w.subject in test_subj]
        for p, w in test_pairs:
            # UMAFall phone and wrist streams start at slightly different times; shift the
            # phone candidates onto the wrist timeline so +/-1.5 s matching is meaningful
            shift = round((p.meta["t0_ms"] - w.meta["t0_ms"]) / config.BIN_MS)
            cp = score_recording(p.acc, *models["phone"])
            cp.peaks = cp.peaks + shift
            cw = score_recording(w.acc, *models["wrist"])
            scored.append((p, w, {"phone": cp, "wrist": cw}))
        print(f"fold {fi}: {len(test_pairs)} synchronised recordings", flush=True)
    with open(CACHE, "wb") as fh:
        pickle.dump(scored, fh)
    return scored


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cached", action="store_true")
    args = ap.parse_args()
    scored = pickle.loads(CACHE.read_bytes()) if args.cached else score_all()
    metrics = json.loads((config.REPORTS_DIR / "metrics.json").read_text())
    if not all(p in metrics for p in config.POSITIONS):
        print("scores cached; run train_eval.py for both positions, then: eval_fusion.py --cached")
        return
    thr = {p: float(np.median(metrics[p]["models"]["ensemble"]["thresholds_per_fold"])) for p in config.POSITIONS}
    res = {"thresholds": thr,
           "phone_only": counts(scored, lambda c: alarms_from_candidates(c["phone"], thr["phone"])),
           "wrist_only": counts(scored, lambda c: alarms_from_candidates(c["wrist"], thr["wrist"]))}
    for rule in RULES:
        res[f"fused_{rule}"] = counts(scored, lambda c, r=rule: fuse(c["phone"], c["wrist"], thr["phone"], thr["wrist"], r))
    (config.REPORTS_DIR / "fusion.json").write_text(json.dumps(res, indent=2))
    lines = ["# Fusion of phone + wrist (UMAFall, synchronised recordings, subject-wise 5-fold CV)", "",
             "| Strategy | Sensitivity | Specificity | False alarms / hour | Falls detected |", "|---|---|---|---|---|"]
    for k, m in res.items():
        if k == "thresholds":
            continue
        lines.append(f"| {k} | {m['sensitivity']:.1%} | {m['specificity']:.1%} | "
                     f"{m['false_alarms_per_hour']:.2f} | {m['tp']}/{m['tp'] + m['fn']} |")
    (config.REPORTS_DIR / "fusion.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
