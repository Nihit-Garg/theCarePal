# Code walkthrough: read this first

A guided tour of the codebase. Read it top to bottom once (~20 min), and you'll be able
to explain every part in the video and change anything confidently.

---

## 1. The problem in one paragraph

An accelerometer gives three numbers (x, y, z) many times per second. When you're still,
the only force is gravity, so the **magnitude** `|a| = √(x²+y²+z²)` is about **1 g**. A fall has a
signature: a short **free fall** (|a| drops below 1 g), a sharp **impact** (|a| spikes to 2–10 g),
then the person usually **stays down** (|a| ≈ 1 g again, but gravity now points a
different way relative to the body, because they're lying instead of standing). The hard part
is that jogging, hopping, clapping (on the wrist) and flopping onto a bed also produce spikes.
The ML exists to tell those apart.

## 2. The data flow, end to end

```
raw dataset files ──► datasets.py ──► Recording (N×3 array in g, 20 Hz) ──┐
                                                                          │
           training (Python)                                              ▼
  evaluate.training_windows ──► 4 s windows around peaks ──► models.py (LightGBM + CNN)
           │                                                         │
           └── train_eval.py: subject-wise nested CV ──► reports/    └─► export_models.py ──► .onnx
                                                                                        │
           demo (browser)                                                               ▼
  sim.js / livePhone.js ──► engine.js ──► detector.js (stage 1) ──► model.js (stage 2, ONNX) ──►
           fusion.js (which device to trust) ──► App.jsx (alert + 30 s countdown) ──► notify.js
```

The Python side and the browser side implement **the same pipeline**, and
`web/src/engine/parity.test.js` checks that they agree to 4 decimal places.

## 3. Python, file by file (`ml/fallguard/`)

### `config.py`: the knobs
* `FS = 20`: everything is resampled to 20 Hz.
* `PRE = 30, POST = 50`: the classifier sees 1.5 s before the peak and 2.5 s after it (80 samples).
* `PEAK_HALF_WIDTH = 10`: a candidate peak must be the largest within ±0.5 s.
* `REFRACTORY_S = 10`: at most one alarm per 10 s (one fall gives several peaks).

If you change one of these, change `model_config.json` too by re-running `export_models.py`.
The browser reads its constants from that file.

### `datasets.py`: loading and harmonising
* `bin_resample()`: groups samples into 50 ms bins and averages each bin. This turns any rate
  (200 Hz phone, 20 Hz tag, 60 Hz browser) into 20 Hz, and the averaging also acts as an
  anti-aliasing filter. Empty bins are linearly interpolated.
* `load_umafall()`: each CSV holds 5 sensors. The header says which sensor ID is in which
  position (it differs per file!). We keep `RIGHTPOCKET → "phone"` and `WRIST → "wrist"`.
  We also store `t0_ms` (when each stream started), so phone and wrist can be re-synchronised
  for the fusion evaluation and the demo replays.
* `load_sisfall()`: one waist device at 200 Hz. The raw ADXL345 counts are converted to g
  (`× 32 / 8192`). File names encode the activity: `F..` = fall, `D..` = daily activity, `SE..` = elderly subject.

### `signal.py`: the core idea (orientation invariance)
The phone can be upside down in a pocket and the watch can be on either wrist, so raw x/y/z
mean nothing on their own. For each 4 s window:
1. Estimate **gravity before the event**: `g_pre` = the average acceleration over the first 1 s.
2. Express every sample relative to it:
   * `mag`: total |a|
   * `vert`: the component along `g_pre` (up/down in the person's original posture)
   * `horiz`: the component perpendicular to it
   * `tilt`: the angle between the current (smoothed) acceleration and `g_pre`. It goes from
     0° to ~90° when you go from standing to lying.

Rotate the input any way you like and these four channels don't change.
`ml/tests/test_pipeline.py::test_channels_are_orientation_invariant` proves it with a random
3-D rotation. These four channels are the **CNN's input**.

`window_features()` computes **20 hand-made features** from the same window for LightGBM:
impact peak, minimum before impact (free fall), stillness after impact (`post_still_frac`),
posture change (`tilt_change_deg`), jerk, energy, and so on. They are listed in `FEATURE_NAMES`.

`find_candidate_peaks()` is **stage 1**: |a| ≥ trigger, and it's the local maximum.

### `detector.py`: the two-stage detector
* `score_recording()`: stage 1 finds peaks, then each 4 s window is scored by the model.
* `alarms_from_candidates()`: keeps peaks with probability ≥ threshold, and drops any within 10 s of the previous alarm.

### `models.py`: the two classifiers (plus their ensemble)
* `ClassicModel`: LightGBM (200 small trees, `class_weight="balanced"`), trained on the features.
* `FallCNN`: three Conv1d blocks → global average pool → one logit. **6,225 parameters**, 27 KB as ONNX.
  The input scaling sits inside the network, so the exported ONNX takes raw channels.
  Training augments with ±15% gain (different sensors) and small noise.
* `EnsembleModel`: the average of the two probabilities. **This is what ships.**
* Note `torch.set_num_threads(1)` at the top: on macOS, PyTorch and LightGBM ship different
  OpenMP libraries and crash if both run multi-threaded. It took a segfault to find this.

### `evaluate.py`: honest evaluation
* `training_windows()`: **positives** are the impact of each fall (±2 samples of jitter =
  5 windows per fall). **Negatives** are every stage-1 peak in daily activities, plus peaks
  more than 3 s from the impact inside fall recordings (walking before the fall).
* `choose_trigger()`: the 1st percentile of training fall peaks, so ~99% of falls pass stage 1.
* `choose_threshold()`: the **highest** threshold that still catches ≥95% of falls. Why
  sensitivity-first? A false alarm costs one tap on "I'm OK". A missed fall can mean an
  older person on the floor for hours.
* `event_counts()`: metrics are counted **per recording, by streaming it through the
  detector**, not per window:
  * fall recording → detected if an alarm fires within ±3 s of the impact
  * daily-activity recording → every alarm is a false alarm; FA/hour = alarms ÷ hours of activity
* `subject_folds()`: splits **people**, not windows.

### `fusion.py`: two devices at once
A candidate from either device is matched with the other device's best score within ±1.5 s.
Scores are normalised by each device's own threshold (`s = p / threshold`, so s ≥ 1 means
"this device alone would alarm"). The rules compared were OR, AND and MEAN; **MEAN ships**: alarm if
`(s_phone + s_wrist) / 2 ≥ 1`. A confident device can carry a hesitant one, but one
device's spike alone isn't enough.

## 4. Python scripts (`ml/scripts/`), in the order you run them

| Script | What it does | Time |
|---|---|---|
| `download_data.sh` | gets UMAFall + SisFall into `data/raw/` | ~2 min |
| `prepare_data.py` | loads both datasets → `data/processed/recordings.pkl` | ~10 s |
| `train_eval.py` | **nested** subject-wise CV of all models → `reports/metrics.md` + figure | ~20 min |
| `eval_fusion.py` | CV of the fusion rules on UMAFall's simultaneous recordings → `reports/fusion.md` | ~8 min |
| `export_models.py` | trains the final models, exports ONNX, demo replays, golden test vectors | ~1.5 min |
| `battery_estimate.py` | analytical battery model → `reports/battery.md` | ~10 s |

**"Nested" CV, simply:** the outer loop holds out ~20% of the *people* as the test set. Inside,
on the remaining 80%, an inner 4-fold CV produces out-of-fold scores, and those pick the
threshold. Then the model is retrained on all of the 80% and tested on the held-out
people. The test people never influence any choice. The shipped threshold is the median of the 5
outer-fold thresholds.

`export_models.py` holds out **2 UMAFall subjects (06 and 18)** from the shipped models,
so the demo replays are people the deployed model never saw.

## 5. The browser (`web/src/`)

### Engine (`web/src/engine/`): plain JavaScript, no React
| File | Role | Python twin |
|---|---|---|
| `resample.js` | streaming `BinResampler` (any rate → 20 Hz) | `datasets.bin_resample` |
| `signal.js` | channels + 20 features | `signal.py` |
| `detector.js` | `DeviceDetector.push(sample)` → candidate or null | `signal.find_candidate_peaks` + `extract_window` |
| `model.js` | loads the 2 ONNX models, `predict(window)` → `{p, pLgb, pCnn}` | `models.EnsembleModel` |
| `fusion.js` | `selectMode()` (which device to trust) + `fuseScores()` | `fusion.py` |
| `engine.js` | `FallEngine`: wires it all together and raises alarms | — |
| `sim.js` | `ScenarioPlayer` (replays recordings) + `HeartRateSim` | — |
| `livePhone.js` | the real phone accelerometer via `DeviceMotion` | — |
| `notify.js` | POSTs to `VITE_ALERT_WEBHOOK_URL`, or demo mode | — |

**Detector streaming detail:** when sample *n* arrives, the detector checks sample
*n − 50* (2.5 s ago). By then it knows the ±0.5 s neighbourhood (is it a local max?) and has
the 2.5 s after it (did they stay down?). That's why alerts appear ~3–5 s after the impact.

**`FallEngine` in four methods:**
* `setDeviceStatus(id, {connected, worn})`, `pushSample(id, [x,y,z], t)`, `pushHeartRate(t, bpm)`: the
  *only* interface a device needs. The simulator and the real phone use exactly these.
* `tick(now)`: picks the mode with `selectMode()`, and resolves fused decisions after waiting
  1.5 s + 1 s so both devices have had a chance to report.
* `raise()`: emits `'alarm'` unless suspended, inside the refractory window, or before `ignoreBefore`.
* `resume(now)`: called when an alert is closed. It **re-arms immediately**. The end-to-end test
  found a bug here: after "I'm OK", a real fall within 10 s used to be ignored.

**Mode selection (`selectMode`):** wearable OK = connected + data in the last 2 s + worn.
Phone OK = connected + fresh data. Both OK and the phone isn't resting on a table → BOTH; wearable only →
WEARABLE; phone only → PHONE; nothing → NONE (red warning). "Resting on a table" = |a|
constant for 30 s **and** lying flat. Stillness alone isn't enough, because a phone in the pocket of
someone sitting quietly is also still.

### UI (`App.jsx`, `components/`)
* `App.jsx`: boots (config → 2 models → replays), runs a 50 ms clock that pulls synchronised
  samples from the `ScenarioPlayer` and pushes them into the engine, and handles alert state.
* `SignalChart.jsx`: a canvas that redraws every frame from a mutable `store` ref. It doesn't use React
  state, so 40 samples/s doesn't cause re-renders.
* `AlertOverlay.jsx`: the 30 s countdown ring, "I'm OK — cancel", "Get help now", the heart-rate rise,
  then the "Caregiver notified" screen showing the exact message.

### Tests
* `npm test`: **parity** with Python (resampling, channels, features, ONNX probabilities, streaming
  peaks) using `golden.json` produced by `export_models.py`.
* `npm run smoke`: headless Chrome at iPhone size plays every fall and every daily activity and
  checks the fallback logic. It needs `npm run build` first.
* `pytest` (in `ml/`): unit tests, including orientation invariance.

## 6. How to make common changes

| I want to… | Do this |
|---|---|
| change the countdown length | `COUNTDOWN_S` in `components/AlertOverlay.jsx` |
| change the person's name | `PERSON` in `App.jsx` |
| make the wrist less trigger-happy | pick a point further left on the wrist curve in `reports/figures/`, then in `export_models.py` override `thr` for `"wrist"` (e.g. 0.5) and re-export. Shipped thresholds otherwise come from the nested-CV median |
| try the OR fusion rule | `new FallEngine(c, models, { rule: 'or' })` in `App.jsx` |
| send real alerts | create `web/.env` with `VITE_ALERT_WEBHOOK_URL=https://…`, restart `npm run dev` |
| add a feature | add it in `signal.py` **and** `signal.js` (same position in the list), re-run `train_eval.py` + `export_models.py`, then `npm test` checks you ported it correctly |
| change the window length | `PRE_S`/`POST_S` in `config.py` → re-run everything from `train_eval.py` |
| add a real device | write an adapter that calls the three engine methods; see `docs/real-devices.md` |

## 7. Numbers to remember for the video

* Phone: **94.9%** of falls caught, **0** false alarms in 16.8 h of held-out daily activity (threshold-only baseline: **119/h**)
* Wrist: **94.2%** caught, **11/h** false alarms (baseline 101/h). With the phone fused in: **0.45/h**
* Top LightGBM features: phone = **posture change** (tilt); wrist = **stillness after impact**
* CNN: **6,225 parameters**; all models together ~230 KB per device; inference ~0.15 ms
* Battery estimate: **~0.2%/day** on a phone, **~1%/day** on a watch
* Honest weak spot: **one** 60+ subject with falls in the data, and 73% of their falls caught

## 8. Questions an interviewer might ask

* **"Why not just a threshold?"** It catches falls, but at 100+ false alarms/hour, because hopping and jogging hit the same g-forces.
* **"Why 20 Hz?"** It's the lowest rate in our data (the wrist tags). Fall dynamics are mostly below 10 Hz. It's battery-friendly.
* **"Why is your phone result so good?"** SisFall contributes 1,798 falls and 14.5 h of activity, and a phone near the hips sees whole-body motion clearly. The lab setting flatters it; real-world numbers will be worse.
* **"How do you know the browser does the same thing as Python?"** Golden-vector parity tests, run in CI.
* **"What about privacy?"** Inference runs on the device. Raw motion never leaves it; only the alert does.
* **"What would you do with real users?"** Every "I'm OK" tap is a labelled false alarm. Use them (with consent) to personalise thresholds.
