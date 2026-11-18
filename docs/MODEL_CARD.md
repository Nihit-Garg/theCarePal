# Model card: FallGuard fall detector

## Model details
* **What:** two-stage fall detector for 3-axis accelerometer streams. Stage 1 is an impact
  trigger (|a| ≥ a per-device threshold, local maximum). Stage 2 is an ensemble (mean
  probability) of a LightGBM classifier on 20 hand-crafted features and a 1D-CNN
  (6,225 parameters) on 4 orientation-invariant channels, over a 4 s window (1.5 s before
  and 2.5 s after the peak).
* **Variants:** `phone` (trouser pocket / hip) and `wrist` (watch or band). When both are worn,
  their outputs are fused (log-odds margins; see `ml/fallguard/fusion.py`).
* **Format:** ONNX (`web/public/models/`), run on the device with ONNX Runtime (Web, or Mobile).
* **Version:** see git history. The settings it ships with are in `web/public/models/model_config.json`.
* **Author:** Nihit Garg, TheCarePal internship assignment AI-03 (2026).

## Intended use
* **Purpose:** raise a **possible-fall alert** with a 30 s self-cancel countdown, then notify
  caregivers, so help arrives sooner for older people living at home.
* **Users:** older adults (wearing or carrying the device), their families, home nurses,
  and the care-operations team.
* **Not for:** diagnosing injuries or medical conditions, replacing supervision,
  medication or clinical decisions, or any use where a missed alert is the only safety net.
  **It is not a medical device.**

## Training and evaluation data
| Dataset | Position | People | Content |
|---|---|---|---|
| UMAFall (Casilari et al., 2017) | phone (pocket) + wrist, simultaneous | 19 (mostly young adults; a few older participants did everyday activities only) | simulated falls onto a mattress (forward / backward / sideways), 12 everyday activities |
| SisFall (Sucerquia et al., 2017) | waist (phone proxy) | 38, incl. 15 aged 60+ | 15 fall types, 19 everyday activities; only one 60+ participant performed falls |

All data is public. No TheCarePal or patient data was used.

## Evaluation method
* **Subject-wise nested 5-fold cross-validation.** Test people are never seen in training or in
  threshold selection.
* **Event-level, streaming metrics.** A fall counts as detected if an alarm fires within ±3 s of the impact;
  every alarm during an everyday-activity recording is a false alarm. False alarms per hour are
  divided by the hours of activity.
* **Threshold** chosen for ≥95% sensitivity on inner-CV folds. A false alarm costs one tap,
  while a missed fall can cost hours on the floor.

## Results
<!-- METRICS:START -->
| | Phone | Wrist |
|---|---|---|
| People / falls | 57 / 2,006 | 19 / 208 |
| Sensitivity | 94.9% | 93.8% |
| Specificity (per activity recording) | 100.0% | 94.8% |
| False alarms / hour of lab activity | 0.00 | 12.63 |
| Stage-1 trigger / stage-2 threshold | 1.8 g / 0.93 | 2.4 g / 0.39 |
| Elderly (60+) subgroup | sensitivity 72.0% (one person), specificity 100.0% | no falls by 60+ people in the wrist data |

Fused phone + wrist: 98.6% sensitivity, 0.45 false alarms/h (UMAFall, held-out people). Full tables: `reports/metrics.md`, `reports/fusion.md`.
<!-- METRICS:END -->

## Known limitations and risks
* **Simulated falls by mostly young volunteers.** Real falls in older adults are often slower,
  happen from sitting or bed, and may lack a sharp impact. Sensitivity on them is **unknown**;
  the single 60+ subject with falls (SisFall SE06) had noticeably lower sensitivity (above).
* **Lab activity clips** are short and intense, so false alarms per hour measured on them are a
  pessimistic estimate. Use `ml/scripts/eval_recording.py` on real-life recordings.
* **The wrist is harder** than the phone. Clapping, raising hands and lying down on a bed are the
  most common wrist false alarms, and the wrist false-alarm rate was higher for the older UMAFall
  participants' everyday activities (see `reports/metrics.md`, subgroup `elderly_60plus`).
* **Soft falls / slumps** below the stage-1 trigger cannot be detected (a long-lie or inactivity
  detector is future work).
* **Heart-rate confirmation** is shown to caregivers but never blocks an alert. In the demo it
  is simulated.
* **Phone position:** trained on trouser-pocket / hip data. A phone in a handbag, on a lanyard or on
  a table behaves differently. The app warns when the phone appears to be lying on a table.

## Ethical considerations
* **Over-reliance:** families may assume "the app will catch it". The UI always shows which sensor
  is active and says plainly when none is, and the alert screen and caregiver message both state it isn't a diagnosis.
* **Privacy:** inference runs on the device. Raw motion never leaves it; only incident
  metadata (time, sensor, scores, heart-rate change, responder, outcome) is shared with the care team.
* **Labels:** a person's "I'm OK" is stored as *person OK (unconfirmed)*, not as a false alarm.
  People often fall and are fine, and treating cancellations as false alarms would bias tuning
  towards missing real falls. Only caregiver-confirmed outcomes are labels.
* **Consent:** recordings for real-world testing are only created when the user presses record,
  and they stay on the device until downloaded.
* **Fairness:** performance across age, body type, gait aids (walkers, canes) and clothing hasn't been
  measured. Validate with the actual population before relying on it.

## How to update
Re-run the pipeline (`README → Run it`); `export_models.py` writes new models and settings, and
`update_docs.py` refreshes the numbers in this card, the README and the walkthrough.
