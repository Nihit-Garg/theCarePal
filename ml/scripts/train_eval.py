"""Subject-wise nested cross-validation of all models for both sensor positions.

    python ml/scripts/train_eval.py [--folds 5] [--inner 4] [--positions phone wrist]

No subject ever appears in both training and test data (random window splits
leak a person's movement style into the test set and inflate results).

Outer loop (k folds of subjects) estimates performance. Inside each outer fold,
an inner subject-wise CV over *all* training subjects produces out-of-fold
scores, and the stage-2 threshold is picked on those — never on test subjects.
The model is then refit on all training subjects and scored on the test fold.

Writes reports/metrics.json, reports/metrics.md and figures in reports/figures/.
"""
from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict

import matplotlib.pyplot as plt
import numpy as np

from fallguard import config
from fallguard.datasets import load_recordings
from fallguard.detector import Candidates, alarms_from_candidates, score_recording
from fallguard.evaluate import (
    RecResult,
    choose_threshold,
    choose_trigger,
    event_counts,
    subject_folds,
    summarize,
    training_windows,
)
from fallguard.models import ClassicModel, CNNModel
from fallguard.signal import find_candidate_peaks, magnitude

TARGET_SENS = 0.95
SISFALL_ADL = {"D01": "Walking slowly", "D02": "Walking quickly", "D03": "Jogging slowly", "D04": "Jogging quickly",
               "D05": "Stairs slowly", "D06": "Stairs quickly", "D07": "Sit in half-height chair slowly",
               "D08": "Sit in half-height chair quickly", "D09": "Sit in low chair slowly",
               "D10": "Sit in low chair quickly", "D11": "Collapse into a chair", "D12": "Sit, lie down slowly",
               "D13": "Sit, lie down quickly", "D14": "Turn over while lying", "D15": "Bend at knees",
               "D16": "Bend without bending knees", "D17": "Get into a car", "D18": "Stumble while walking",
               "D19": "Gentle jump"}
MODEL_LABELS = {"threshold_only": "Threshold only (baseline)", "lightgbm": "LightGBM (classic)",
                "cnn": "1D-CNN (small NN)", "ensemble": "Ensemble (mean of both)"}


def threshold_only(rec, trigger_g) -> Candidates:
    p = find_candidate_peaks(magnitude(rec.acc), trigger_g)
    return Candidates(p, np.ones(len(p), dtype=np.float32))


def fit_and_score(train, to_score, trig) -> dict[str, list[Candidates]]:
    """Train LightGBM and CNN on `train`; return candidates for every recording in
    `to_score` per model. The ensemble reuses both members' scores (same peaks)."""
    X, y = training_windows(train, trig)
    out = {}
    for name, cls in (("lightgbm", ClassicModel), ("cnn", CNNModel)):
        model = cls().fit(X, y)
        out[name] = [score_recording(r.acc, model, trig) for r in to_score]
    out["ensemble"] = [Candidates(a.peaks, (a.probs + b.probs) / 2)
                       for a, b in zip(out["lightgbm"], out["cnn"])]
    return out


def run_position(pos: str, recs, k: int, k_inner: int) -> dict:
    folds = subject_folds([r.subject for r in recs], k)
    pooled: dict[str, list[RecResult]] = defaultdict(list)
    thresholds: dict[str, list[float]] = defaultdict(list)
    fold_metrics: dict[str, list[dict]] = defaultdict(list)
    triggers = []
    for fi, test_subj in enumerate(folds):
        t0 = time.time()
        train = [r for r in recs if r.subject not in test_subj]
        test = [r for r in recs if r.subject in test_subj]
        trig = choose_trigger(train)
        triggers.append(trig)

        # inner CV -> out-of-fold candidates on all training subjects -> thresholds
        oof: dict[str, list[RecResult]] = defaultdict(list)
        for inner_subj in subject_folds([r.subject for r in train], k_inner, seed=100 + fi):
            fit = [r for r in train if r.subject not in inner_subj]
            held = [r for r in train if r.subject in inner_subj]
            for name, cands in fit_and_score(fit, held, trig).items():
                oof[name] += [RecResult(r, c) for r, c in zip(held, cands)]
        thr = {name: choose_threshold(rs, TARGET_SENS) for name, rs in oof.items()}
        thr["threshold_only"] = 0.5

        scored = fit_and_score(train, test, trig)
        scored["threshold_only"] = [threshold_only(r, trig) for r in test]
        line = []
        for name, cands in scored.items():
            res = [RecResult(r, c) for r, c in zip(test, cands)]
            for rr in res:
                rr.fold_thr = thr[name]
            m = summarize(event_counts(res, thr[name]))
            pooled[name] += res
            thresholds[name].append(thr[name])
            fold_metrics[name].append(m)
            line.append(f"{name}: thr={thr[name]:.2f} sens={m['sensitivity']:.3f} FA/h={m['false_alarms_per_hour']:.1f}")
        print(f"  fold {fi} trigger={trig:.2f}g test subj={len(test_subj)} ({time.time() - t0:.0f}s)\n    "
              + "\n    ".join(line), flush=True)

    out = {"position": pos, "n_recordings": len(recs), "n_subjects": len({r.subject for r in recs}),
           "folds": k, "inner_folds": k_inner, "target_sensitivity": TARGET_SENS,
           "trigger_g_per_fold": triggers, "models": {}}
    for name in ("threshold_only", "lightgbm", "cnn", "ensemble"):
        res = pooled[name]
        # pooled = sum of per-fold event counts, each at that fold's own threshold
        tot = defaultdict(float)
        for fm in fold_metrics[name]:
            for key in ("tp", "fn", "tn", "fp_trials", "false_alarms", "adl_hours"):
                tot[key] += fm[key]
        summary = summarize(dict(tot))
        fm = fold_metrics[name]
        summary["fold_std"] = {key: round(float(np.std([f[key] for f in fm])), 4)
                               for key in ("sensitivity", "specificity", "false_alarms_per_hour")}
        summary["thresholds_per_fold"] = thresholds[name]
        summary["subgroups"] = subgroup_metrics(res)
        summary["false_alarms_by_activity"] = false_alarms_by_activity(res)
        summary["curve"] = curve(res) if name != "threshold_only" else None
        out["models"][name] = summary
    return out


def false_alarms_by_activity(res: list[RecResult]) -> dict:
    c = Counter()
    for rr in res:
        if not rr.rec.label:
            c[rr.rec.activity] += len(alarms_from_candidates(rr.cands, rr.fold_thr))
    return dict(c.most_common())


def subgroup_metrics(res: list[RecResult]) -> dict:
    groups = defaultdict(list)
    for rr in res:
        groups[rr.rec.dataset].append(rr)
        if rr.rec.elderly:
            groups["elderly_60plus"].append(rr)
    out = {}
    for g, rs in groups.items():
        tot = defaultdict(float)
        for rr in rs:
            c = event_counts([rr], rr.fold_thr)
            for key, v in c.items():
                tot[key] += v
        out[g] = summarize(dict(tot))
    return out


def curve(res: list[RecResult]) -> list[dict]:
    pts = []
    for t in np.round(np.arange(0.05, 0.991, 0.025), 3):
        m = summarize(event_counts(res, float(t)))
        pts.append({"threshold": float(t), "sensitivity": m["sensitivity"],
                    "false_alarms_per_hour": m["false_alarms_per_hour"]})
    return pts


def write_reports(new_res: dict) -> None:
    """Merge with results already on disk (so positions can be run separately)."""
    fig_dir = config.REPORTS_DIR / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    path = config.REPORTS_DIR / "metrics.json"
    all_res = json.loads(path.read_text()) if path.exists() else {}
    all_res.update(new_res)
    all_res = {p: all_res[p] for p in config.POSITIONS if p in all_res}
    path.write_text(json.dumps(all_res, indent=2))

    any_r = next(iter(all_res.values()))
    lines = ["# Evaluation results", "",
             f"Subject-wise {any_r['folds']}-fold nested cross-validation (no person is in both train and test). "
             "Event-level metrics come from streaming every held-out recording through the full two-stage "
             f"detector. Each fold's threshold was picked by an inner {any_r['inner_folds']}-fold CV on training "
             f"subjects only, targeting sensitivity >= {any_r['target_sensitivity']:.0%}. "
             "± is the standard deviation across outer folds.", "",
             "False alarms per hour are measured on lab ADL recordings, which are short, dense bursts of "
             "activity (hopping, jogging, clapping...). A real day is mostly quiet, so real-world rates should "
             "be far lower — treat these as a pessimistic upper bound.", ""]
    for pos, r in all_res.items():
        lines += [f"## {pos.capitalize()} ({r['n_subjects']} subjects, {r['n_recordings']} recordings)", "",
                  "| Model | Sensitivity | Specificity | False alarms / hour of ADL | Falls detected | ADL hours |",
                  "|---|---|---|---|---|---|"]
        for name, m in r["models"].items():
            sd = m["fold_std"]
            lines.append(f"| {MODEL_LABELS[name]} | {m['sensitivity']:.1%} ± {sd['sensitivity']:.1%} | "
                         f"{m['specificity']:.1%} ± {sd['specificity']:.1%} | "
                         f"{m['false_alarms_per_hour']:.2f} ± {sd['false_alarms_per_hour']:.2f} | "
                         f"{m['tp']:.0f}/{m['tp'] + m['fn']:.0f} | {m['adl_hours']:.2f} |")
        lines += ["", "Subgroups (same thresholds):", "",
                  "| Model | Group | Sensitivity | Specificity | FA / hour |", "|---|---|---|---|---|"]
        for name, m in r["models"].items():
            for g, s in m["subgroups"].items():
                sens = f"{s['sensitivity']:.1%}" if s["tp"] + s["fn"] else "n/a (no falls)"
                lines.append(f"| {MODEL_LABELS[name]} | {g} | {sens} | {s['specificity']:.1%} | "
                             f"{s['false_alarms_per_hour']:.2f} |")
        if pos == "phone":
            lines += ["", "Note: the elderly_60plus fall sensitivity comes from a single SisFall subject (SE06), the only "
                      "participant over 60 who performed falls. It is a warning sign that older people's falls may look different, "
                      "not a reliable estimate."]
        lines += ["", "False alarms by ADL activity (count over all held-out subjects):", "",
                  "| Activity | " + " | ".join(MODEL_LABELS[n] for n in r["models"]) + " |",
                  "|---|" + "---|" * len(r["models"])]
        acts = list(r["models"]["threshold_only"]["false_alarms_by_activity"])
        for a in acts:
            lines.append(f"| {SISFALL_ADL.get(a, a)} | " + " | ".join(str(m["false_alarms_by_activity"].get(a, 0))
                                                   for m in r["models"].values()) + " |")
        lines.append("")
    (config.REPORTS_DIR / "metrics.md").write_text("\n".join(lines))

    plt.switch_backend("Agg")  # headless: write PNGs only
    fig, axes = plt.subplots(1, len(all_res), figsize=(6 * len(all_res), 4.5))
    for ax, (pos, r) in zip(np.atleast_1d(axes), all_res.items()):
        colors = {"threshold_only": "#666666", "lightgbm": "#1f77b4", "cnn": "#ff7f0e", "ensemble": "#2ca02c"}
        for name, m in r["models"].items():
            if m["curve"]:
                c = m["curve"]
                ax.plot([p["false_alarms_per_hour"] for p in c], [p["sensitivity"] for p in c],
                        marker=".", color=colors[name], label=MODEL_LABELS[name])
            ax.scatter([m["false_alarms_per_hour"]], [m["sensitivity"]], s=140 if name != "threshold_only" else 70,
                       zorder=5, color=colors[name], edgecolor="black", linewidth=0.6,
                       marker="*" if name != "threshold_only" else "X",
                       label=MODEL_LABELS[name] if name == "threshold_only" else None)
        ax.text(0.98, 0.02, "★ = chosen operating point (cross-validated)", transform=ax.transAxes,
                ha="right", va="bottom", fontsize=8, color="#444444")
        ax.set_title(f"{pos}: sensitivity vs false alarms per hour")
        ax.set_xlabel("false alarms per hour of daily activity")
        ax.set_ylabel("sensitivity (falls detected)")
        ax.grid(alpha=0.3)
        ax.legend(loc="center right")
    fig.tight_layout()
    fig.savefig(fig_dir / "sensitivity_vs_false_alarms.png", dpi=130)
    print("wrote", config.REPORTS_DIR / "metrics.md")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--inner", type=int, default=4)
    ap.add_argument("--report-only", action="store_true", help="re-render reports from metrics.json")
    ap.add_argument("--positions", nargs="+", default=list(config.POSITIONS))
    args = ap.parse_args()
    if args.report_only:
        write_reports({})
        return
    data = load_recordings()
    all_res = {}
    for pos in args.positions:
        print(f"== {pos}", flush=True)
        all_res[pos] = run_position(pos, data[pos], args.folds, args.inner)
    write_reports(all_res)
    print((config.REPORTS_DIR / "metrics.md").read_text())


if __name__ == "__main__":
    main()
