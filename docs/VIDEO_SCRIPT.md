# Video script (target 4:30, limit 5:00)

The brief says: **show the working product first**, then the code and key decisions.
Record a laptop browser window at full width so the **Side by side** view shows the person's
phone (left) and the caregiver screen (right). Turn off "Normal day in background" for a calm
start, and turn the volume up: the alarm and voice are part of the demo.

Numbers below match `docs/WALKTHROUGH.md` §7, which is generated from `reports/`. Check them there
before recording.

---

### 0:00–0:20 · Hook
> "Hi, I'm Nihit. This is FallGuard, my submission for AI-03. It detects falls using
> whatever the person has: a phone, a smartwatch, or both. The ML runs entirely on the device.
> The person gets 30 seconds to say they're OK, and then the care team takes over."

### 0:20–2:00 · Live demo (the most important part)
1. **Side by side** view. "Left is Asha's phone, right is the nurse's screen. Both devices are
   streaming real recordings from two people the model never saw in training. Each card says
   exactly where its data comes from. Heart rate is simulated."
2. Tap **Lying down on a bed**, then **Clapping**: "Everyday movements create spikes too. The
   dots are the model's scores, and they stay below the line."
3. Tap **Forward fall**: "A real fall… it waits a few seconds to see that she stays down…"
   → alarm, voice prompt, countdown. "Big button, sound, vibration, and a spoken prompt.
   Older users can switch it to Hindi." Tap **I'm OK**. On the right: "cancelled, recorded as a
   false alarm. That's free labelled data."
4. Tap **Backward fall** → **Get help now**. Right side: the incident appears under *Needs attention*.
   Tap **I'm on it** → left side shows "Nurse Priya is responding". Tap **Real fall**, add a note.
   Point at the stats: confirmed falls, false alarms, median time to respond, CSV export.
5. **Fallback:** untick **Worn** → the pill says "Phone". Re-tick **Worn**, set the phone to **Off** → "Wearable".
   Untick **Connected** → red "No sensor" warning. "It always tells you what's protecting you."

### 2:00–3:00 · How it works (README diagram, then `ml/fallguard/signal.py`)
> "It's a two-stage detector. Stage one is a cheap trigger: has the acceleration spiked? That runs
> all the time for almost nothing. Only then does stage two look at a 4-second window and ask
> whether it's a fall."

> "The key design choice is that the model never sees raw x, y, z. Each window becomes four
> orientation-invariant channels: total acceleration, the parts along and across the original
> gravity direction, and tilt. So it doesn't matter how the phone sits in a pocket or which wrist
> the watch is on. A unit test rotates the data randomly to prove it."

> "I compared a classic LightGBM on 20 interpretable features with a 6,000-parameter 1D-CNN.
> The ensemble of both had the fewest false alarms. Interestingly, the phone relies most on
> posture change and the wrist on stillness after impact."

### 3:00–3:50 · Results and honesty (`reports/figures/…png`, README results)
> "I evaluated on *people*, not windows, with nested cross-validation, so test people never
> influence training or the threshold. Metrics come from streaming whole recordings."

> "Phone: about 95% of falls caught with essentially zero false alarms in 17 hours of held-out
> activity; a plain threshold fires over 100 times an hour. The wrist is harder: about 13 false
> alarms an hour, mostly clapping and lying down on a bed."

> "For phone plus watch, my first fusion rule averaged scores, and a review agent I ran found the
> flaw: the phone could never trigger on its own. I switched to adding log-odds evidence, and fused
> sensitivity went from about 97% to about 99% at the same false-alarm rate."

> "The honest weak spot: only one person over 60 performed falls in these datasets, and the model
> caught about three quarters of them. That's the first thing I'd validate. I built a recorder and
> an evaluation script for exactly that."

### 3:50–4:30 · Engineering and next steps
> "Everything is tested: Python unit tests, parity tests proving the browser raises exactly the
> same alarms as the Python code, and an end-to-end test that drives the app in headless Chrome,
> including the two-tab caregiver flow, in CI on every push. The battery estimate is about 0.2% a
> day on a phone and 1% on a watch."

> "Next: native Android and Wear OS apps with the same ONNX models, Firebase push notifications
> with phone-call escalation, and using every 'I'm OK' and every caregiver outcome to personalise
> thresholds. Thanks for watching."

---

**Before recording:** hard-refresh, clear old incidents (Caregiver → *Clear demo data*), set the
zoom so both columns are readable, and do one dry run. The replays are fixed recordings (plus tiny
noise), so a fall that alerts in the dry run alerts on camera too.
