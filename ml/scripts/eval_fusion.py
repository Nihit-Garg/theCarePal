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

from fallguard import config, fusion
from fallguard.datasets import load_recordings
from fallguard.detector import alarms_from_candidates, score_recording
from fallguard.evaluate import choose_trigger, counts_from_alarms, subject_folds, summarize, training_windows
from fallguard.fusion import DEFAULT_RULE, RULES, fuse
from fallguard.models import EnsembleModel


def counts(scored, alarm_fn) -> dict:
    """Event-level metrics; the wrist recording carries the label and impact time."""
    return summarize(counts_from_alarms((wr, alarm_fn(c)) for _phone, wr, c in scored))


CACHE = config.PROCESSED_DIR / "fusion_scores.pkl"


def score_all() -> list:
    data = load_recordings()
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
    # robustness of the shipped rule to its one constant (fixed at 3 before evaluation, not tuned)
    clip0 = fusion.LOGODDS_CLIP
    sensitivity = {}
    for clip in (2.0, 4.0):
        fusion.LOGODDS_CLIP = clip
        m = counts(scored, lambda c: fuse(c["phone"], c["wrist"], thr["phone"], thr["wrist"], "logodds"))
        sensitivity[f"logodds_clip_{clip:g}"] = {k: m[k] for k in ("sensitivity", "specificity", "false_alarms_per_hour")}
    fusion.LOGODDS_CLIP = clip0
    res["clip_sensitivity_check"] = sensitivity
    (config.REPORTS_DIR / "fusion.json").write_text(json.dumps(res, indent=2))
    names = {"phone_only": "Phone only", "wrist_only": "Wrist only", "fused_or": "Either device (OR)",
             "fused_and": "Both devices (AND)", "fused_mean": "Mean of p/threshold (previous rule)",
             "fused_logodds": "Log-odds margins, clip ±3 (shipped)"}
    lines = ["# Fusion of phone + wrist", "",
             "UMAFall recorded phone and wrist simultaneously. Subject-wise 5-fold CV over its 19 people: each "
             "fold's models never saw the test people. Thresholds are the shipped ones (nested-CV medians from "
             "metrics.json); those were chosen in CV folds that also contained these people as *training* data "
             "in other folds, so treat the absolute numbers as slightly optimistic — the comparison between rules "
             "is the point.", "",
             "| Strategy | Sensitivity | Specificity | False alarms / hour | Falls detected |", "|---|---|---|---|---|"]
    for k, label in names.items():
        m = res[k]
        lines.append(f"| {label} | {m['sensitivity']:.1%} | {m['specificity']:.1%} | "
                     f"{m['false_alarms_per_hour']:.2f} | {m['tp']}/{m['tp'] + m['fn']} |")
    lines += ["", f"Shipped rule: `{DEFAULT_RULE}`. Its clip constant was fixed at 3 before evaluation; for transparency, "
              "the same rule with other clips: " + ", ".join(
                  f"{k.split('_')[-1]} → sensitivity {v['sensitivity']:.1%}, {v['false_alarms_per_hour']:.2f} FA/h"
                  for k, v in sensitivity.items()) + "."]
    (config.REPORTS_DIR / "fusion.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
