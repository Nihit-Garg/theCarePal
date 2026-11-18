"""Regenerate every reported number in the docs from reports/*.json and the exported
model config, so the README, walkthrough and model card can never drift from the results.

    python ml/scripts/update_docs.py

Rewrites the text between these markers:
  README.md            <!-- RESULTS:START --> … <!-- RESULTS:END -->
  docs/WALKTHROUGH.md  <!-- NUMBERS:START --> … <!-- NUMBERS:END -->
  docs/MODEL_CARD.md   <!-- METRICS:START --> … <!-- METRICS:END -->
"""
from __future__ import annotations

import json
import re

from fallguard import config

LABELS = {"threshold_only": "Threshold only (baseline)", "lightgbm": "LightGBM (classic)",
          "cnn": "1D-CNN (small NN)", "ensemble": "**Ensemble (shipped)**"}
FEATURE_LABELS = {
    "tilt_change_deg": "posture change", "post_tilt_mean_deg": "final tilt", "post_still_frac": "stillness after impact",
    "peak_mag": "impact peak", "post_vert_mean": "final vertical acceleration", "horiz_peak": "sideways peak",
    "sma_dynamic": "movement energy", "post_mean_mag": "mean |a| after impact", "impact_width_s": "impact width",
    "pre_min_mag": "free-fall dip", "max_jerk": "jerk", "dyn_energy": "dynamic energy",
}
ACTIVITY_LABELS = {
    "Aplausing": "clapping", "LyingDown_OnABed": "lying down on a bed", "HandsUp": "raising hands",
    "Sitting_GettingUpOnAChair": "sitting down / standing up", "OpeningDoor": "opening a door",
    "MakingACall": "phone call", "GoDownstairs": "going downstairs", "GoUpstairs": "going upstairs",
}
FUSION_LABELS = {"phone_only": "Phone only", "wrist_only": "Wrist only", "fused_or": "Either device (OR)",
                 "fused_and": "Both devices (AND)", "fused_mean": "Mean of p/threshold (first version)",
                 "fused_logodds": "**Log-odds margins (shipped)**"}


def load() -> tuple[dict, dict, dict, dict]:
    r = config.REPORTS_DIR
    return (json.loads((r / "metrics.json").read_text()), json.loads((r / "fusion.json").read_text()),
            json.loads((r / "battery.json").read_text()),
            json.loads((config.WEB_MODELS_DIR / "model_config.json").read_text()))


def pct(x: float) -> str:
    return f"{x:.1%}"


def model_table(pos: dict) -> list[str]:
    rows = ["| Model | Sensitivity | Specificity | False alarms / hour | Falls caught |", "|---|---|---|---|---|"]
    for name, label in LABELS.items():
        m, sd = pos["models"][name], pos["models"][name]["fold_std"]
        rows.append(f"| {label} | {pct(m['sensitivity'])} ± {pct(sd['sensitivity'])} | "
                    f"{pct(m['specificity'])} ± {pct(sd['specificity'])} | {m['false_alarms_per_hour']:.2f} | "
                    f"{int(m['tp'])}/{int(m['tp'] + m['fn'])} |")
    return rows


def fusion_table(fu: dict) -> list[str]:
    rows = ["| Strategy | Sensitivity | Specificity | False alarms / hour | Falls caught |", "|---|---|---|---|---|"]
    for k, label in FUSION_LABELS.items():
        m = fu[k]
        rows.append(f"| {label} | {pct(m['sensitivity'])} | {pct(m['specificity'])} | "
                    f"{m['false_alarms_per_hour']:.2f} | {m['tp']}/{m['tp'] + m['fn']} |")
    return rows


def facts(me: dict, fu: dict, bat: dict, cfg: dict) -> dict:
    ph, wr = me["phone"], me["wrist"]
    pe, we = ph["models"]["ensemble"], wr["models"]["ensemble"]
    elderly = ph["models"]["ensemble"]["subgroups"].get("elderly_60plus", {})
    top = {p: [FEATURE_LABELS.get(k, k) for k in list(cfg["positions"][p]["top_features"])[:2]] for p in config.POSITIONS}
    kb = {p: round(sum(cfg["positions"][p]["model_bytes"].values()) / 1024) for p in config.POSITIONS}
    wrist_fa = list(we["false_alarms_by_activity"].items())[:3]
    return dict(ph=ph, wr=wr, pe=pe, we=we, pb=ph["models"]["threshold_only"], wb=wr["models"]["threshold_only"],
                elderly=elderly, top=top, kb=kb, wrist_fa=wrist_fa, fu=fu, bat=bat, cfg=cfg,
                params=cfg["positions"]["phone"]["cnn_params"],
                inf_ms=round(sum(bat[p]["inference_ms_this_machine"] for p in bat) / len(bat), 2))


def readme_block(f: dict) -> list[str]:
    ph, wr, fu = f["ph"], f["wr"], f["fu"]
    lo, wo = fu["fused_logodds"], fu["wrist_only"]
    return [
        "Subject-wise nested 5-fold cross-validation: every number is on people the model never saw.",
        "**False alarms per hour** are measured on lab daily-activity clips (dense bursts of jogging, hopping, "
        "clapping), so they are a pessimistic upper bound for a real, mostly quiet day.", "",
        f"**Phone**: {ph['n_subjects']} people (UMAFall pocket + SisFall waist), "
        f"{int(f['pe']['tp'] + f['pe']['fn']):,} falls, {f['pe']['adl_hours']:.1f} h of daily activity", "",
        *model_table(ph), "",
        f"**Wearable (wrist)**: {wr['n_subjects']} people (UMAFall), {int(f['we']['tp'] + f['we']['fn'])} falls, "
        f"{f['we']['adl_hours']:.1f} h of daily activity", "",
        *model_table(wr), "",
        "**Both devices** (UMAFall's simultaneous phone + wrist recordings, held-out people; thresholds are the "
        "shipped ones, so read this as a comparison of rules):", "",
        *fusion_table(fu), "",
        "What this says:",
        f"* The ML is what makes this usable: a plain impact threshold catches a similar share of falls but fires "
        f"**{f['pb']['false_alarms_per_hour']:.0f}/h (phone) and {f['wb']['false_alarms_per_hour']:.0f}/h (wrist)** "
        "on normal activity.",
        f"* **The wrist is harder** ({f['we']['false_alarms_per_hour']:.1f} false alarms/h). Its most common false "
        "alarms: " + ", ".join(f"{ACTIVITY_LABELS.get(a, a)} ({n})" for a, n in f["wrist_fa"]) + ".",
        f"* **Fusion:** with a phone on the person, the shipped log-odds rule catches {pct(lo['sensitivity'])} of falls "
        f"at {lo['false_alarms_per_hour']:.2f} false alarms/h (wrist alone in the same evaluation: "
        f"{pct(wo['sensitivity'])} at {wo['false_alarms_per_hour']:.2f}/h). The first rule (mean of p/threshold) "
        f"reached only {pct(fu['fused_mean']['sensitivity'])}: the phone could never trigger on its own.",
        f"* ⚠️ Only one person over 60 performed falls in these datasets (SisFall SE06); the phone model caught "
        f"{pct(f['elderly'].get('sensitivity', 0))} of their falls. Older people's falls may look different, which is "
        "the biggest open risk (see *Limitations* and the [model card](docs/MODEL_CARD.md)).",
        f"* **Battery** (estimate): ~{f['bat']['phone']['total_pct_battery_per_day']}% per day on a phone, "
        f"~{f['bat']['wrist']['total_pct_battery_per_day']}% on a watch. Models: {f['kb']['phone']} KB (phone), "
        f"{f['kb']['wrist']} KB (wrist); stage 2 takes ~{f['inf_ms']} ms on a laptop CPU.",
    ]


def walkthrough_block(f: dict) -> list[str]:
    lo = f["fu"]["fused_logodds"]
    return [
        f"* Phone: **{pct(f['pe']['sensitivity'])}** of falls caught, **{f['pe']['false_alarms_per_hour']:.2f}** false "
        f"alarms/h over {f['pe']['adl_hours']:.1f} h of held-out daily activity (threshold-only baseline: "
        f"**{f['pb']['false_alarms_per_hour']:.0f}/h**)",
        f"* Wrist: **{pct(f['we']['sensitivity'])}** caught, **{f['we']['false_alarms_per_hour']:.1f}/h** false alarms "
        f"(baseline {f['wb']['false_alarms_per_hour']:.0f}/h)",
        f"* Phone + wrist fused (log-odds): **{pct(lo['sensitivity'])}** caught at **{lo['false_alarms_per_hour']:.2f}/h** "
        f"(first rule: {pct(f['fu']['fused_mean']['sensitivity'])})",
        f"* Top LightGBM features: phone = **{', '.join(f['top']['phone'])}**; wrist = **{', '.join(f['top']['wrist'])}**",
        f"* CNN: **{f['params']:,} parameters**; models {f['kb']['phone']} KB (phone) / {f['kb']['wrist']} KB (wrist); "
        f"stage 2 ~{f['inf_ms']} ms",
        f"* Battery estimate: **~{f['bat']['phone']['total_pct_battery_per_day']}%/day** on a phone, "
        f"**~{f['bat']['wrist']['total_pct_battery_per_day']}%/day** on a watch",
        f"* Honest weak spot: **one** 60+ subject with falls in the data, and {pct(f['elderly'].get('sensitivity', 0))} "
        "of their falls caught",
    ]


def model_card_block(f: dict) -> list[str]:
    cfg = f["cfg"]["positions"]
    rows = ["| | Phone | Wrist |", "|---|---|---|",
            f"| People / falls | {f['ph']['n_subjects']} / {int(f['pe']['tp'] + f['pe']['fn']):,} | "
            f"{f['wr']['n_subjects']} / {int(f['we']['tp'] + f['we']['fn'])} |",
            f"| Sensitivity | {pct(f['pe']['sensitivity'])} | {pct(f['we']['sensitivity'])} |",
            f"| Specificity (per activity recording) | {pct(f['pe']['specificity'])} | {pct(f['we']['specificity'])} |",
            f"| False alarms / hour of lab activity | {f['pe']['false_alarms_per_hour']:.2f} | {f['we']['false_alarms_per_hour']:.2f} |",
            f"| Stage-1 trigger / stage-2 threshold | {cfg['phone']['trigger_g']} g / {cfg['phone']['threshold']:.2f} | "
            f"{cfg['wrist']['trigger_g']} g / {cfg['wrist']['threshold']:.2f} |",
            f"| Elderly (60+) subgroup | sensitivity {pct(f['elderly'].get('sensitivity', 0))} (one person), "
            f"specificity {pct(f['elderly'].get('specificity', 0))} | no falls by 60+ people in the wrist data |"]
    lo = f["fu"]["fused_logodds"]
    fused = (f"Fused phone + wrist: {pct(lo['sensitivity'])} sensitivity, {lo['false_alarms_per_hour']:.2f} "
             "false alarms/h (UMAFall, held-out people). Full tables: `reports/metrics.md`, `reports/fusion.md`.")
    return [*rows, "", fused]


def replace_block(path, marker: str, lines: list[str]) -> None:
    text = path.read_text()
    pat = re.compile(rf"(<!-- {marker}:START -->\n).*?(\n<!-- {marker}:END -->)", re.S)
    if not pat.search(text):
        raise SystemExit(f"markers <!-- {marker}:START/END --> not found in {path}")
    path.write_text(pat.sub(lambda m: m.group(1) + "\n".join(lines) + m.group(2), text))
    print("updated", path.relative_to(config.ROOT))


def main() -> None:
    f = facts(*load())
    replace_block(config.ROOT / "README.md", "RESULTS", readme_block(f))
    replace_block(config.ROOT / "docs" / "WALKTHROUGH.md", "NUMBERS", walkthrough_block(f))
    replace_block(config.ROOT / "docs" / "MODEL_CARD.md", "METRICS", model_card_block(f))


if __name__ == "__main__":
    main()
