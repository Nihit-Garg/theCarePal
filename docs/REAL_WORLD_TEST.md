# Testing on real devices

The cross-validated numbers come from **lab recordings**: short, dense clips of
activities, and falls simulated by mostly young volunteers onto mats. The question that matters
for a family is different: *how often will this go off during a normal day, and does it
catch a real fall?* This protocol measures the first part on your own devices.

## What you need
* A phone with the app open over **HTTPS** (the GitHub Pages URL; phones block motion
  sensors on plain-http pages), and/or
* a smartwatch with any app that can export raw accelerometer data as CSV
  (a "sensor logger" type app). It must be the **raw** accelerometer, including gravity.

## A. Everyday-life false alarms (the most valuable test)
1. Open the app → **Person** → Phone: **This phone** (allow motion access).
   This automatically disconnects the *simulated* wearable, so your recording contains only real
   data. The screen stays on (wake lock) because browsers pause sensors when it locks.
2. Open **Record data for real-world testing** → **Start recording**.
3. Put the phone in your trouser pocket and live normally for **1–3 hours**: walking,
   stairs, sitting down, standing up, commuting, cooking. Tap a label chip whenever the
   activity changes. It's optional, but the labels are drawn on the timeline plot and listed in
   the JSON, so you can see what you were doing when an alarm fired.
4. **Stop recording** → **Download CSV**.
5. Evaluate it with the exact models the app ships:
   ```bash
   .venv/bin/python ml/scripts/eval_recording.py ~/Downloads/fallguard-recording-*.csv --out reports/real_world/day1
   ```
   (`reports/real_world/` is git-ignored: raw recordings stay private.)
   It prints hours recorded, alarms, false alarms per hour, and writes
   `day1.png` (a timeline with every alarm) plus `day1.json`.

For a watch, export its accelerometer CSV and run, for example:
```bash
.venv/bin/python ml/scripts/eval_recording.py watch.csv --generic --device wrist \
  --time-col time --x x --y y --z z --time-unit s --units g
```
(Use `--units ms2` if the app records m/s², and set `--time-unit` to match its timestamps.
The script warns you if the resting magnitude isn't about 1 g, which usually means the
wrong units or gravity-free data.)

## B. Controlled test falls (optional, only if safe for you)
> ⚠️ Only on a thick mattress or crash mat, only if you're young and healthy, starting
> from kneeling. Never ask an older person to do this.

While recording, do a few deliberate falls (forward, backward, sideways) onto the mattress and
stay still for ~10 s. The alert will appear: tap **"I'm OK"**, then tap **"I just did a test fall"**
in the recorder. The script counts a fall as detected if an alarm fired between **60 s before
and 5 s after** your tap, so a mark made after dismissing the alert still matches.

## Reporting results
Add a summary row per session to the README (the raw recordings and plots in
`reports/real_world/` stay local and git-ignored):

| Date | Device / position | Duration | Activities | False alarms | FA / hour | Test falls detected |
|---|---|---|---|---|---|---|
| … | phone, right pocket | 2.1 h | commute, office, stairs | 0 | 0.0 | 3/3 |

Look at the PNG for every false alarm and write down what you were doing. That's
exactly the insight a product team needs: which real activities fool the model.

## Privacy
Recordings contain only motion samples, heart rate (if any) and your own labels. They
stay on your device until you download them. Don't commit personal recordings to a
public repo unless you're comfortable sharing them.
