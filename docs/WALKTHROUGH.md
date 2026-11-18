# Code walkthrough: read this first

A guided tour of the codebase. Read it top to bottom once (~25 min), and you'll be able
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
           └── train_eval.py: subject-wise nested CV ──► reports/    └─► export_models.py ──► .onnx + model_config.json
                                                                                        │
           demo (browser)                                                               ▼
  sim.js / livePhone.js ──► engine.js ──► detector.js (stage 1) ──► model.js (stage 2, ONNX) ──►
     fusion.js (which device to trust) ──► PersonView (alert + 30 s countdown) ──► incident store ──► CaregiverView
```

The Python side and the browser side implement **the same pipeline**. Parity tests check
that the browser reproduces Python on golden vectors: resampling to 1e-5, channels to
1e-4, features to a relative 1e-3, model probabilities to 1e-3. **Candidate peaks and
alarms must match exactly**, for single devices and for fused phone + wrist.

## 3. Python, file by file (`ml/fallguard/`)

### `config.py`: the knobs
* `FS = 20`: everything is resampled to 20 Hz.
* `PRE = 30, POST = 50`: the classifier sees 1.5 s before the peak and 2.5 s after it (80 samples).
* `PEAK_HALF_WIDTH = 10`: a candidate peak must be the largest within ±0.5 s.
* `REFRACTORY_S = 10`: at most one alarm per 10 s (one fall gives several peaks).

The browser reads these from `web/public/models/model_config.json`, which
`export_models.py` writes, so re-export after changing anything.

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
* `save_recordings()` / `load_recordings()`: the cache in `data/processed/recordings.pkl`.
  Every script loads data through this one function.

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
* `score_recording()`: stage 1 finds peaks, then each 4 s window is scored by the model. Like the
  streaming product, it **only judges a peak once 2.5 s of data after it exists**.
* `alarms_from_candidates()`: keeps peaks with probability ≥ threshold, and drops any within 10 s of the previous alarm.

### `models.py`: the two classifiers (plus their ensemble)
* `ClassicModel`: LightGBM (200 small trees, `class_weight="balanced"`), trained on the features.
* `FallCNN`: three Conv1d blocks → global average pool → one logit. **6,225 parameters**, 27 KB as ONNX.
  The input scaling sits inside the network, so the exported ONNX takes raw channels.
  It trains for a fixed 30 epochs with a cosine learning rate and augments with ±15% gain
  (different sensors) and small noise.
* `EnsembleModel`: the average of the two probabilities. **This is what ships.**
* Note `torch.set_num_threads(1)` at the top: on macOS, PyTorch and LightGBM ship different
  OpenMP libraries and crash if both run multi-threaded.

### `evaluate.py`: honest evaluation
* `training_windows()`: **positives** are the impact of each fall (±2 samples of jitter =
  5 windows per fall). **Negatives** are every peak above **0.9 × the trigger** in daily
  activities (slightly more than stage 1 would pass, so the model also sees near-misses),
  plus such peaks more than 3 s from the impact inside fall recordings (walking before the fall).
* `choose_trigger()`: the 1st percentile of training fall peaks, rounded down to 0.05 g, so ~99% of falls pass stage 1.
* `choose_threshold()`: the **highest** threshold that still catches ≥95% of falls. Why
  sensitivity-first? A false alarm costs one tap on "I'm OK". A missed fall can mean an
  older person on the floor for hours.
* `event_counts()` / `counts_from_alarms()`: metrics are counted **per recording, from the alarms
  the detector raises over the whole stream**, not per window. The same function scores single
  devices and fused ones:
  * fall recording → detected if an alarm fires within ±3 s of the impact
  * daily-activity recording → every alarm is a false alarm; FA/hour = alarms ÷ hours of activity
* `subject_folds()`: splits **people**, not windows.

### `fusion.py`: two devices at once
A candidate from either device is matched with the other device's best probability within ±1.5 s.
Each device then contributes its **evidence margin over its own threshold**:
`m = logit(p) − logit(threshold)`, clipped to ±3. The alarm fires if `m_phone + m_wrist ≥ 0`.
A device with no candidate near that moment counts as −3.

*Why not simply average `p / threshold`?* That was the first version, and the code audit caught
the flaw: with thresholds 0.93 (phone) and 0.41 (wrist), the phone's score can never exceed
1/0.93 ≈ 1.08, so it could **never** carry a decision on its own. Log-odds margins are symmetric.
The clip (3) was fixed before looking at results; `reports/fusion.md` shows that clips 2 and 4
give almost the same numbers. `onnx_model.py` lets Python run the exact shipped ONNX files.

## 4. Python scripts (`ml/scripts/`), in the order you run them

| Script | What it does | Time (laptop CPU) |
|---|---|---|
| `download_data.sh` | gets UMAFall + SisFall into `data/raw/` | ~2 min |
| `prepare_data.py` | loads both datasets → `data/processed/recordings.pkl` | ~10 s |
| `train_eval.py` | **nested** subject-wise CV of all models → `reports/metrics.md` + figure | ~20–25 min |
| `eval_fusion.py` | CV of the fusion rules on UMAFall's simultaneous recordings → `reports/fusion.md` | ~8 min |
| `export_models.py` | trains the final models, exports ONNX, `model_config.json`, demo replays, golden test vectors | ~2 min |
| `battery_estimate.py` | analytical battery model → `reports/battery.md` | ~10 s |
| `eval_recording.py` | runs the shipped models on **your own** recording (see `docs/REAL_WORLD_TEST.md`) | seconds |

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
| `model.js` | loads the 2 ONNX models, `predict(window)` → `{p, pLgb, pCnn}`. All inference goes through **one queue**: ONNX Runtime Web hangs on overlapping `run()` calls (the engine test caught this) | `models.EnsembleModel` |
| `fusion.js` | `selectMode()` (which device to trust) + `fuseScores()` (log-odds rule) | `fusion.py` |
| `engine.js` | `FallEngine`: wires it all together and raises alarms | — |
| `sim.js` | `ScenarioPlayer` (replays recordings) + `HeartRateSim` | — |
| `livePhone.js` | the real phone accelerometer via `DeviceMotion` (+ `BinResampler`) | — |
| `alertFx.js` | alarm tone (Web Audio), vibration, spoken prompt (Web Speech) | — |
| `recorder.js` | `SessionRecorder`: records what the engine sees + your labels → CSV | read by `eval_recording.py` |
| `wakeLock.js` | keeps the screen on while the live sensor is used | — |
| `notify.js` | optional webhook POST (`VITE_ALERT_WEBHOOK_URL`) | — |

**Detector streaming detail:** when sample *n* arrives, the detector checks sample
*n − 50* (2.5 s ago). By then it knows the ±0.5 s neighbourhood (is it a local max?) and has
the 2.5 s after it (did they stay down?). So a single-device alert appears ~2.5–3 s after impact.
In fused mode the engine also waits for the *other* device's view of the same moment (up to
1.5 s later, plus its own 2.5 s look-ahead, plus inference), so alerts appear ~4.5–5 s after impact.

**`FallEngine` in a nutshell:**
* `setDeviceStatus(id, {connected, worn})`, `pushSample(id, [x,y,z], t)`, `pushHeartRate(t, bpm)`: the
  *only* interface a device needs. Samples must already be at 20 Hz (wrap the device's native
  rate in `BinResampler`). The simulator and the real phone use exactly these.
* `on(fn)` for events (`mode`, `status`, `candidate`, `alarm`, `error`). `tap(fn)` sees every raw
  sample; that's how the recorder works without touching the detection code.
* `tick(now)`: picks the mode with `selectMode()` and resolves pending fused decisions.
* `raise()`: emits `'alarm'` unless suspended, inside the refractory window, or before `ignoreBefore`.
* `resume(now)`: called when an alert is closed. It **re-arms immediately**. The end-to-end test
  found a bug here: after "I'm OK", a real fall within 10 s used to be ignored.
* `idle()`: waits for in-flight inference (used by tests).

**Mode selection (`selectMode`):** wearable OK = connected + data in the last 2 s + worn.
Phone OK = connected + fresh data. Both OK and the phone isn't resting on a table → BOTH; wearable only →
WEARABLE; phone only → PHONE; nothing → NONE (red warning). "Resting on a table" is
**detected by the engine**: |a| constant for 30 s **and** lying flat. Stillness alone isn't
enough, because a phone in the pocket of someone sitting quietly is also still. The UI warns when it happens.

### Incidents (`web/src/incidents/`): the caregiver workflow
* `model.js`: pure functions for the lifecycle
  `countdown → cancelled | escalated → acknowledged → resolved (real fall / false alarm / unsure)`.
  Every transition returns a new object with a timeline entry; impossible transitions throw.
  Includes `incidentStats()` (for the ops numbers) and `incidentsToCsv()`.
  A countdown whose phone went silent (for example the battery died) becomes **stale** and needs attention.
* `localStore.js`: localStorage + BroadcastChannel, so **tabs of one browser sync instantly**.
* `firebaseStore.js`: Firestore with anonymous auth, loaded only if configured (`docs/FIREBASE.md`).
* `index.js`: picks the store; the rest of the app doesn't know which one it got.

### UI (`App.jsx`, `views/`, `components/`)
* `App.jsx`: a hash router: `#/` Person, `#/caregiver`, `#/split` (both side by side on wide
  screens, good for the video). It also unlocks audio on the first tap (browsers require a gesture).
* `views/PersonView.jsx`: boots (config → 2 models → replays → incident store), runs a 50 ms
  clock that feeds synchronised replay samples into the engine, creates and updates the incident
  on alarm / cancel / escalate, and shows where each device's data comes from.
* `views/CaregiverView.jsx`: live incident list (needs attention / waiting / being handled / history),
  "I'm on it", resolve with outcome + note, a chime on new alerts, stats and CSV export.
* `components/AlertOverlay.jsx`: the 30 s countdown with tone + vibration + voice (English or
  Hindi, `i18n.js`). After escalation it shows **who is responding**, live from the store.
* `components/SignalChart.jsx`: a canvas redrawn every frame from a mutable ref (no React re-renders).
* `components/RecorderPanel.jsx`: start/stop, label chips, CSV download.
* `prefs.js` (persisted settings), `uid.js` (ids that work over plain-http LAN URLs too).
* `public/sw.js` + `manifest.webmanifest`: installable, works offline (production build only).

### Tests
* `npm test` (vitest):
  * `parity.test.js`: resampling, channels, features, ONNX outputs and streaming peaks vs Python.
  * `engine.test.js`: the **whole engine** with real ONNX models must raise the **same alarms** as
    Python, for each device and for fused phone + wrist replays.
  * `incidents/model.test.js`: lifecycle, invalid transitions, stats, CSV, recorder.
* `npm run smoke`: headless Chrome at iPhone size (needs `npm run build` first). It:
  * plays every fall replay and one full take of each of the 11 everyday activities;
  * runs the **two-tab caregiver flow** (escalate → "I'm on it" → resolve) and the Hindi alert;
  * downloads a recorder CSV, checks the fallback modes, and renders the split view.

  It passes if ≥5/6 falls alert and ≤1 everyday activity does, and prints the exact counts.
* `pytest` (in `ml/`): unit tests (incl. orientation invariance) + `eval_recording.py` end to end.
* CI (`.github/workflows/ci.yml`) runs all of the above on every push.

## 6. How to make common changes

| I want to… | Do this |
|---|---|
| change the countdown length | `COUNTDOWN_S` in `web/src/incidents/model.js` |
| change the person's name | `PERSON` in `web/src/views/PersonView.jsx` |
| add a language | add a key to `STRINGS` in `web/src/i18n.js` (and to `LANGS`) |
| make the wrist less trigger-happy | pick a point further left on the wrist curve in `reports/figures/`, then in `export_models.py` override `thr` for `"wrist"` (e.g. 0.5) and re-export. Shipped thresholds otherwise come from the nested-CV median |
| change the fusion rule | `DEFAULT_RULE` in `ml/fallguard/fusion.py` → `export_models.py` (the browser reads it from `model_config.json`) → `npm test` |
| share incidents across phones | `docs/FIREBASE.md` |
| send alerts to another system | set `VITE_ALERT_WEBHOOK_URL` in `web/.env` |
| add a feature | add it in `signal.py` **and** `signal.js` (same position in the list), re-run `train_eval.py` + `export_models.py`, then `npm test` checks you ported it correctly |
| change the window length | `PRE_S`/`POST_S` in `config.py` → re-run everything from `train_eval.py` |
| add a real device | write an adapter that calls the three engine methods; see `docs/real-devices.md` |
| measure on real life | `docs/REAL_WORLD_TEST.md` |

## 7. Numbers to remember for the video

<!-- NUMBERS:START -->
* Phone: **94.9%** of falls caught, **0.00** false alarms/h over 16.8 h of held-out daily activity (threshold-only baseline: **119/h**)
* Wrist: **93.8%** caught, **12.6/h** false alarms (baseline 101/h)
* Phone + wrist fused (log-odds): **98.6%** caught at **0.45/h** (first rule: 96.6%)
* Top LightGBM features: phone = **posture change, final tilt**; wrist = **stillness after impact, impact peak**
* CNN: **6,225 parameters**; models 231 KB (phone) / 205 KB (wrist); stage 2 ~0.15 ms
* Battery estimate: **~0.18%/day** on a phone, **~1.01%/day** on a watch
* Honest weak spot: **one** 60+ subject with falls in the data, and 72.0% of their falls caught
<!-- NUMBERS:END -->

## 8. Questions an interviewer might ask

* **"Why not just a threshold?"** It catches falls, but at 100+ false alarms/hour, because hopping and jogging hit the same g-forces.
* **"Why 20 Hz?"** It's the lowest rate in our data (the wrist tags). Fall dynamics are mostly below 10 Hz. It's battery-friendly.
* **"Why is your phone result so good?"** SisFall contributes 1,798 falls and 14.5 h of activity, and a phone near the hips sees whole-body motion clearly. The lab setting flatters it; real-world numbers will be worse, which is why `eval_recording.py` exists.
* **"How do you know the browser does the same thing as Python?"** Golden-vector tests check every stage, *and* that the full engine raises identical alarms, run in CI.
* **"How did you combine the two devices?"** Log-odds margins over each device's own threshold. Averaging normalised scores was the first version; an audit showed the phone could then never trigger alone. Fixing it raised fused sensitivity at the same false-alarm rate.
* **"What about privacy?"** Inference runs on the device. Raw motion never leaves it; only incident metadata does.
* **"What would you do with real users?"** Every "I'm OK" tap and every caregiver outcome is a labelled example. Use them (with consent) to personalise thresholds.
* **"How did you use AI tools?"** Claude Code for pair-programming, plus a separate review agent that audited the code and docs for unsupported claims. It caught real bugs (a crash in every training script after a lint change, and the fusion asymmetry), which were fixed and re-evaluated.
