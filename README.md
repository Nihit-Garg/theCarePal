# FallGuard: fall detection from phone and wearable sensors

TheCarePal AI/ML internship assignment **AI-03**. A device-agnostic fall detector
that works with whatever the person has: a phone, a smartwatch or band, or both.
It runs entirely on the device and raises an alert with a 30-second "I'm OK" countdown
before a caregiver is notified. A **caregiver screen** then tracks each incident from
"needs attention" to "resolved".

**What's in it**
* On-device ML (LightGBM + 1D-CNN ensemble) for **phone** and **wrist**, cross-validated on people it never saw
* Wearable/phone **fallback and fusion**, with the active device always shown
* An alert designed for older people: a big countdown, alarm tone, vibration, and a spoken prompt in **English or Hindi**
* A **caregiver / ops screen**: live incidents, "I'm on it", resolve as real fall or false alarm, stats, CSV export.
  It syncs across browser tabs out of the box, and across phones with Firebase
* A **recorder** + `eval_recording.py` to measure false alarms on your own real-life recordings
* An installable PWA that keeps working offline after one online visit; tests check that the browser raises the same alarms as the Python pipeline on golden recordings (single devices and fused)

> **Not a medical device.** This tool supports nurses and families. It does not
> diagnose anything or replace medical judgement; the alert screen and the caregiver message say so.

[![CI](https://github.com/Nihit-Garg/theCarePal/actions/workflows/ci.yml/badge.svg)](https://github.com/Nihit-Garg/theCarePal/actions/workflows/ci.yml)

**Live demo:** https://nihit-garg.github.io/theCarePal/ (works on a phone) · **Video:** _<add your video link>_

New here? Read [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md), a guided tour of the code and every design decision.
More docs: [`MODEL_CARD`](docs/MODEL_CARD.md) · [real-world testing](docs/REAL_WORLD_TEST.md) ·
[connecting real devices](docs/real-devices.md) · [Firebase setup](docs/FIREBASE.md) · [video script](docs/VIDEO_SCRIPT.md)

![Sensitivity vs false alarms](reports/figures/sensitivity_vs_false_alarms.png)

## Results (people the model never saw)

<!-- RESULTS:START -->
Subject-wise nested 5-fold cross-validation: every number is on people the model never saw.
**False alarms per hour** are measured on lab daily-activity clips (dense bursts of jogging, hopping, clapping), so they are a pessimistic upper bound for a real, mostly quiet day.

**Phone**: 57 people (UMAFall pocket + SisFall waist), 2,006 falls, 16.8 h of daily activity

| Model | Sensitivity | Specificity | False alarms / hour | Falls caught |
|---|---|---|---|---|
| Threshold only (baseline) | 94.9% ± 0.5% | 65.0% ± 2.7% | 118.69 | 1903/2006 |
| LightGBM (classic) | 95.0% ± 2.6% | 99.6% ± 0.3% | 0.78 | 1905/2006 |
| 1D-CNN (small NN) | 95.7% ± 2.6% | 99.9% ± 0.1% | 0.30 | 1919/2006 |
| **Ensemble (shipped)** | 94.9% ± 3.0% | 100.0% ± 0.0% | 0.00 | 1903/2006 |

**Wearable (wrist)**: 19 people (UMAFall), 208 falls, 2.2 h of daily activity

| Model | Sensitivity | Specificity | False alarms / hour | Falls caught |
|---|---|---|---|---|
| Threshold only (baseline) | 95.7% ± 3.4% | 68.4% ± 5.1% | 101.49 | 199/208 |
| LightGBM (classic) | 94.7% ± 4.0% | 90.5% ± 2.0% | 23.00 | 197/208 |
| 1D-CNN (small NN) | 91.8% ± 6.0% | 92.4% ± 4.5% | 18.49 | 191/208 |
| **Ensemble (shipped)** | 93.8% ± 4.5% | 94.8% ± 3.0% | 12.63 | 195/208 |

**Both devices** (UMAFall's simultaneous phone + wrist recordings, held-out people; thresholds are the shipped ones, so read this as a comparison of rules):

| Strategy | Sensitivity | Specificity | False alarms / hour | Falls caught |
|---|---|---|---|---|
| Phone only | 97.1% | 99.4% | 1.35 | 202/208 |
| Wrist only | 95.2% | 92.6% | 18.05 | 198/208 |
| Either device (OR) | 99.0% | 92.2% | 18.95 | 206/208 |
| Both devices (AND) | 92.8% | 100.0% | 0.00 | 193/208 |
| Mean of p/threshold (first version) | 96.6% | 99.8% | 0.45 | 201/208 |
| **Log-odds margins (shipped)** | 98.6% | 99.8% | 0.45 | 205/208 |

What this says:
* The ML is what makes this usable: a plain impact threshold catches a similar share of falls but fires **119/h (phone) and 101/h (wrist)** on normal activity.
* **The wrist is harder** (12.6 false alarms/h). Its most common false alarms: clapping (12), lying down on a bed (8), raising hands (6).
* **Fusion:** with a phone on the person, the shipped log-odds rule catches 98.6% of falls at 0.45 false alarms/h (wrist alone in the same evaluation: 95.2% at 18.05/h). The first rule (mean of p/threshold) reached only 96.6%: the phone could never trigger on its own.
* ⚠️ Only one person over 60 performed falls in these datasets (SisFall SE06); the phone model caught 72.0% of their falls. Older people's falls may look different, which is the biggest open risk (see *Limitations* and the [model card](docs/MODEL_CARD.md)).
* **Battery** (estimate): ~0.18% per day on a phone, ~1.01% on a watch. Models: 231 KB (phone), 205 KB (wrist); stage 2 takes ~0.15 ms on a laptop CPU.
<!-- RESULTS:END -->

Full tables, including fold-to-fold spread, elderly subgroup and false alarms by
activity: [`reports/metrics.md`](reports/metrics.md) · fusion: [`reports/fusion.md`](reports/fusion.md)
· battery: [`reports/battery.md`](reports/battery.md).

## How it works

```
 any device ──► BinResampler ──► Stage 1: trigger ──► Stage 2: classifier ──► Fusion & ──► 30 s countdown ──► incident ──► caregiver
 (phone, watch,   (any rate →     |a| ≥ T g and local   4 s window around     fallback      tone + voice,       store        screen
  band, sim)       20 Hz)          max (always on,       the peak: LightGBM    (which device "I'm OK" cancels  (tabs or     (ack, resolve,
                                   ~free)                + 1D-CNN ensemble     to trust)                        Firebase)     stats)
```

1. **Harmonise.** Every source is bin-averaged into 20 Hz samples in g. 20 Hz is the
   lowest rate in the data, it is enough for fall dynamics, and it is cheap on battery.
2. **Stage 1, trigger.** A fall has an impact, so we only look closer when |a| crosses a
   per-device threshold (set so that ~99% of training falls pass) and is a local
   maximum. This runs on every sample and costs almost nothing.
3. **Stage 2, classify the moment.** We take a 4 s window: 1.5 s before the peak
   (free fall?) and 2.5 s after it (did they stay down?). It is converted to
   **orientation-invariant channels**: total acceleration, the parts along and across
   the pre-impact gravity direction, and tilt from the starting posture. Two models
   score it:
   * **LightGBM** on 20 interpretable features (impact peak, free-fall dip, stillness after
     the impact, change in posture, jerk…)
   * a **1D-CNN** (~6k parameters) on the 4 channels

   Their mean is the fall probability. It had the fewest false alarms on both devices at
   comparable sensitivity (see *Results*).
4. **Decide.** The alarm fires if the probability is at or above the device's threshold,
   with at most one alarm per 10 s.
5. **Fusion and fallback** (`web/src/engine/fusion.js`):
   * wearable connected, worn and streaming, plus a phone on the person → **fused**: each
     device contributes its evidence margin over its own threshold, `logit(p) − logit(threshold)`
     clipped to ±3, and the alarm fires if the sum is ≥ 0. A confident device can outvote a hesitant
     one. (An earlier version averaged `p / threshold`; an audit showed the phone could then never
     trigger on its own, so it was replaced and re-evaluated. See *Results*.)
   * wearable only → wearable model
   * otherwise the phone → phone model. If the engine detects the phone has been still and flat
     for 30 s, it warns that the phone is probably on a table, not on the person
   * nothing → the UI says plainly that falls can't be detected right now
6. **Alert.** A full-screen alert shows a 30 s countdown, a large "I'm OK" button, and
   which device(s) detected the fall and how confident they were. If a wearable is worn,
   it also shows the **heart-rate change since the impact**. That is a supporting signal,
   never a gate: beta-blockers, which many older adults take, blunt the rise. If nobody
   cancels, or they press "Get help now", the incident is **escalated**. Tone, vibration and a spoken
   prompt (English or Hindi) make the countdown hard to miss.
7. **Caregiver.** Escalated incidents appear live on the Caregiver screen (another tab, or another
   phone with Firebase). A nurse taps **"I'm on it"**, and the person's screen shows who is coming.
   Then they resolve it as *real fall / false alarm / unsure*. Those outcomes are labelled data for
   tuning, and they feed the ops stats (confirmed falls, false alarms, median time to respond).

### Key design decisions

| Decision | Why |
|---|---|
| **Device-agnostic, accelerometer-only** | Every phone and band has an accelerometer; many bands have no gyroscope. One code path covers Android, iPhone, Wear OS, Apple Watch and BLE bands. |
| **Orientation-invariant inputs** | The phone can be any way up in a pocket and the band strapped either way. The models never see raw x/y/z, so axis conventions don't matter. |
| **Two-stage detector** | Stage 1 rejects the vast majority of samples for free, so the ML runs only when there's an impact-like spike: a few hundred times per hour of intense lab activity, far fewer in a normal day, at ~1 ms each, which keeps the battery cost negligible (`reports/battery.md`). |
| **Wait 2.5 s after impact** | "Fell and stayed down" is what separates a fall from sitting down hard. The latency is still a few seconds. |
| **Subject-wise nested CV** | Random window splits put the same person in train and test and inflate results. Here thresholds are chosen on training people only, and test people are never seen. |
| **Event-level metrics on full streams** | Sensitivity, specificity and false alarms per hour come from running the detector over whole recordings with the same streaming rules as the product (a peak is only judged once 2.5 s of data after it exist). |
| **Sensitivity-first threshold (≥95% target)** | A false alarm costs one tap on "I'm OK"; a missed fall can mean a long time on the floor. The countdown is what makes a high-sensitivity operating point acceptable. |
| **Wrist as the wearable position** | It's where watches and bands are worn, and it's the hardest position (arms move a lot). We don't hide that: the wrist numbers are worse than the phone's. |
| **Runs in the browser (ONNX Runtime Web)** | No server, no cost, and no sensor data leaves the device. The same `.onnx` files run on Android, iOS and Wear OS through ONNX Runtime Mobile. |
| **Python and JS parity tests** | The browser re-implements the pipeline, so `npm test` checks it against golden vectors exported from Python: resampling, channels, features, ONNX outputs, and the **exact alarms** the full engine raises, single-device and fused. |
| **Incidents as pure state transitions** | `countdown → cancelled / escalated → acknowledged → resolved`, as pure functions, so the same logic works with localStorage or Firestore and is unit-tested. Outcomes become labelled data. |
| **Caregiver sync without an account by default** | Two tabs of one browser sync instantly (localStorage events), so anyone can try the full flow; Firebase is one `.env` away (`docs/FIREBASE.md`). Updates are transitions applied to the latest version (a transaction in Firestore), so two caregivers can't overwrite each other. |
| **Honest alert states** | The person's screen says "contacting…", then "alerted" or "couldn't reach — call for help", and only names a responder once one has acknowledged. A broken sync shows "Sync lost" on the caregiver screen, never "All clear". |

## Data

| Dataset | Used for | Subjects | Notes |
|---|---|---|---|
| [UMAFall](https://figshare.com/articles/dataset/UMA_ADL_FALL_Dataset_zip/4214283) (Casilari et al., 2017) | phone (right pocket, 200 Hz) **and wrist** (SensorTag, 20 Hz), recorded simultaneously | 19 | the simultaneous recording lets us evaluate fusion and replay synchronised streams |
| [SisFall](https://doi.org/10.3390/s17010198) (Sucerquia et al., 2017) | phone (waist device, 200 Hz, a proxy for a phone in a pocket or holster) | 38, **15 aged 60+** | adds ~14.5 h of daily activities, including elderly people's, for a realistic false-alarm rate |

Only public data is used. No real patient data, and none of TheCarePal's data.

## Run it

Requirements: Python 3.10–3.12, Node 20+, ~1 GB of disk.

```bash
# 1. Python environment (uv shown; plain venv + pip works too)
uv venv --python 3.12 .venv && uv pip install --python .venv -e "ml[dev]"

# 2. Data (~310 MB download, free)
bash ml/scripts/download_data.sh
.venv/bin/python ml/scripts/prepare_data.py

# 3. Evaluate (subject-wise nested CV, ~25 min on a laptop CPU) → reports/
.venv/bin/python ml/scripts/train_eval.py
.venv/bin/python ml/scripts/eval_fusion.py

# 4. Train the final models, export ONNX + demo replays + parity vectors → web/public, web/src/engine
.venv/bin/python ml/scripts/export_models.py
.venv/bin/python ml/scripts/battery_estimate.py
.venv/bin/python ml/scripts/update_docs.py    # refresh every number in README / docs from reports/

# 5. Web demo
cd web && npm install && npm test && npm run dev
# optional end-to-end check in headless Chrome: npm run build && npm run smoke

# Python unit tests + lint (no datasets needed)
cd ../ml && ../.venv/bin/python -m pytest -q && ../.venv/bin/ruff check .
```

The trained models and demo replays are committed, so **step 5 works on its own**.
To try the real phone sensor, open the dev server's network URL on your phone (it
needs HTTPS for motion sensors, so use the deployed version or a tunnel) and pick
**Phone → This phone**.

Optional (`web/.env.example`): Firebase settings to share incidents across phones
([`docs/FIREBASE.md`](docs/FIREBASE.md)), and `VITE_ALERT_WEBHOOK_URL` to also POST each
escalation to another system.

### Using the demo
* **Devices:** connect or disconnect the wearable, take it off, switch the phone between
  simulated, this phone's sensor and off, or leave it on a table. The pill at the top
  shows which sensor is being trusted.
* **Scenarios:** the stream plays a "normal day" of everyday activities. Tap a fall to
  inject it. Tap "Lying down on a bed" or "Clapping" to see the hard cases the model
  has to reject.
* The chart shows |a| for each device, with each stage-2 score next to its peak. Each device card
  says exactly where its data comes from (for example "Replay · UMAFall subject 06 · Forward fall").
* **Caregiver flow:** use **Side by side** (wide screens), or open **Caregiver in new tab**. Play a fall,
  press **Get help now**, then **I'm on it** and **Real fall** on the caregiver side.
* **Alert settings:** English / हिन्दी, alarm sound, spoken prompt.
* **Record data for real-world testing:** see [`docs/REAL_WORLD_TEST.md`](docs/REAL_WORLD_TEST.md).

## Repository layout

```
ml/fallguard/        datasets.py  signal.py  detector.py  models.py  evaluate.py  fusion.py  onnx_model.py
ml/scripts/          download_data.sh  prepare_data.py  train_eval.py  eval_fusion.py
                     export_models.py  battery_estimate.py  eval_recording.py  update_docs.py
ml/tests/            unit tests (incl. random-rotation invariance) + eval_recording end to end
web/src/engine/      resample.js signal.js detector.js model.js fusion.js engine.js   ← detection
                     sim.js livePhone.js recorder.js alertFx.js wakeLock.js notify.js
                     parity.test.js engine.test.js
web/src/incidents/   model.js (lifecycle) localStore.js firebaseStore.js index.js model.test.js
web/src/views/       PersonView.jsx  CaregiverView.jsx        web/src/App.jsx (router)
web/src/components/  AlertOverlay.jsx  SignalChart.jsx  RecorderPanel.jsx
web/public/          models/ (*.onnx, model_config.json) · replays/ · manifest · icons/
web/src/sw.template.js  service worker; vite.config.js fills in the precache list at build time
web/scripts/         smoke.mjs (headless-Chrome end-to-end test)
reports/             metrics.md  fusion.md  battery.md  figures/
docs/                WALKTHROUGH · MODEL_CARD · REAL_WORLD_TEST · real-devices · FIREBASE · VIDEO_SCRIPT
firestore.rules      security rules for the shared incident store (+ firebase.json for the CLI)
.github/workflows/   ci.yml (lint, unit + parity + engine tests, build, headless smoke) · pages.yml
```

## Assumptions and limitations

* **Lab data ≠ real life.** Falls were simulated by mostly young volunteers onto mats; the
  everyday activities are short, dense bursts. False alarms per hour measured this way are a
  pessimistic upper bound, and the sensitivity on real elderly falls is unknown. Those are
  slower, and some happen from sitting or lying.
* **Wrist data is limited** (19 people, 2.2 h of everyday activity), so the wrist numbers
  have wide error bars (see the ± in the tables).
* **SisFall's waist device stands in for a phone in a pocket.** Both sit near the hips, but
  a phone in a loose pocket moves more.
* **Heart rate is simulated.** None of the public fall datasets record it. The
  confirmation logic (rise vs the 30 s pre-impact baseline) is real; the signal isn't.
* **Browsers pause sensors when the screen is off.** The demo keeps the screen awake (wake lock)
  while the live sensor is used, but a production phone app must be native. See `docs/real-devices.md`.
* **Fusion numbers are slightly optimistic**: they use the shipped thresholds, which were chosen in
  CV folds where those UMAFall people were training data. The *comparison between rules* is the
  point (`reports/fusion.md`).
* **The caregiver flow is demo-level**: anonymous Firebase auth, no real accounts or push
  notifications yet (see *What I'd build next*).
* SisFall's original host is offline; the download script uses a public mirror of the
  unmodified release (file layout and units checked against the paper).

## What I'd build next

1. **Native apps** (Android and Wear OS first, since most of TheCarePal's families likely use
   Android) running the same ONNX models in a background service, with watch-side inference.
2. **Production notifications**: the incident store already supports Firestore. Next is a Cloud
   Function on `escalated` that sends FCM pushes to the assigned nurse and family, and **escalates
   to a phone call or SMS if nobody acknowledges** within the overdue window (the caregiver screen
   already flags overdue incidents). Real accounts with per-care-team security rules, and incidents
   showing in the ops CRM.
3. **Learn from outcomes**: every caregiver resolution (real fall / false alarm) is a labelled example,
   already exported as CSV. "I'm OK" cancellations are kept as an *unconfirmed* signal, not as false alarms. With consent, use them to tune thresholds per person (someone with
   a vigorous gait gets a different operating point).
4. **Longer real-world validation**: the recorder and `eval_recording.py` are built for this. Wear-test
   with staff and volunteers for full days to measure true false alarms per day, and evaluate on
   real-fall data (for example FARSEEING) if access can be arranged.
5. **Long-lie and inactivity detection**: no movement for N minutes at night when there is
   normally movement. That catches falls with soft impacts that stage 1 misses.
6. Quantise the models (int8) and add a TFLite export for teams that standardise on it.

## Cost to run

| Component | Cost |
|---|---|
| Datasets (UMAFall, SisFall) | free, public |
| Python libraries (NumPy, pandas, scikit-learn, LightGBM, PyTorch, ONNX, onnxmltools) | free, open source |
| Training | ~30 min CPU for the full evaluation (CV + fusion), ~2 min for the final models; no GPU needed |
| Inference | on the user's device (ONNX Runtime Web/Mobile, free); **no server or API cost per user** |
| Hosting the demo | free static hosting (GitHub Pages / Vercel / Firebase Hosting) |
| Shared incidents (optional) | Firebase Spark (free) plan: Firestore + anonymous Auth cover a pilot |
| Webhook (optional) | e.g. a Firebase Cloud Function (needs the pay-as-you-go plan, which has a free tier) |

No paid model APIs are used.

## AI tools used

* **Claude (Claude Code)** was my pair-programmer. I used it to discuss the approach,
  scaffold the code, write the JS port of the signal pipeline and the parity tests, and
  draft this README. I also ran a **separate Claude review agent** to audit the code and docs for
  redundancy and unsupported claims. It found real issues (a crash in every training script
  introduced by a lint fix, a lopsided fusion rule, overstated doc claims), and I fixed and
  re-evaluated them. I reviewed, ran and can explain every part. The design choices (subject-wise
  nested CV, event-level metrics, orientation-invariant channels, two-stage detection,
  sensitivity-first operating point, data-driven fusion rule) are explained above and in the video.
