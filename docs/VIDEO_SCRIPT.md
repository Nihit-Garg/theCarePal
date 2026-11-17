# Video script (target 4:00, limit 5:00)

The brief says: **show the working product first**, then the code and key decisions.
Record the browser at a phone-like width (Chrome DevTools → device toolbar → iPhone 14),
or on your actual phone using the GitHub Pages URL. Turn on "Normal day in background".

---

### 0:00–0:20 · Hook
> "Hi, I'm Nihit. This is FallGuard, my submission for AI-03. It detects falls using
> whatever device a person has, whether that's a phone, a smartwatch, or both. It runs entirely on
> the device, and gives the person 30 seconds to say they're OK before a caregiver is alerted."

### 0:20–1:40 · Live demo (the most important part)
1. **Dashboard** (point at it): "Both devices are streaming, so it's in fused mode. These are
   real sensor recordings from two people the model never saw during training. Heart rate is simulated."
2. Tap **Walking**, then **Lying down on a bed**: "Everyday movements create spikes too.
   The dots are the model's scores, and they stay below the threshold."
3. Tap **Forward fall**: "Here's a real fall. Impact… and about 3 seconds later, because it waits
   to see that the person stays down…" → alert appears. "Big countdown, a big 'I'm OK' button,
   and which device detected it." Tap **I'm OK**.
4. Tap **Backward fall** → alert → **Get help now**: "This is the exact message the caregiver gets.
   Note the heart-rate rise after the impact. It supports the alert but never blocks it,
   because many older people take beta-blockers."
5. **Fallback:** untick **Worn** → the pill switches to "Phone". Phone → **Off** → "Wearable".
   Untick **Connected** → red "No sensor" warning. "It always tells you what's protecting you."

### 1:40–2:40 · How it works (show README diagram, then `ml/fallguard/signal.py`)
> "It's a two-stage detector. Stage one is a cheap trigger: has the acceleration spiked? That runs
> all the time and costs almost nothing. Only then does stage two look at a 4-second window and
> ask whether it's a fall."

> "The key design choice is that the model never sees raw x, y, z. I convert each window into
> four orientation-invariant channels: total acceleration, the parts along and across the
> original gravity direction, and tilt. So it doesn't matter how the phone sits in a pocket or
> which wrist the watch is on. There's a unit test that rotates the data randomly and checks
> the channels don't change. That's what makes it device-agnostic."

> "For the model, I compared a classic LightGBM on 20 interpretable features with a
> 6,000-parameter 1D CNN. The ensemble of both had the fewest false alarms on both devices."

### 2:40–3:30 · Results and honesty (show `reports/figures/…png` and README results)
> "I evaluated on *people*, not windows. The test people are never seen in training or threshold
> selection, using nested cross-validation. Metrics come from streaming whole recordings through
> the real detector."

> "Phone: 95% of falls caught with zero false alarms in about 17 hours of held-out activity. A plain
> threshold would fire 119 times an hour. The wrist is harder: 94% at 11 false alarms an hour,
> mostly clapping and lying down on a bed. Fusing it with the phone cuts that to under 0.5 an hour."

> "The honest weak spot is that only one person over 60 performed falls in these datasets,
> and the model caught 73% of their falls. Older people fall differently, so that's the first
> thing I'd validate with real data."

### 3:30–4:00 · Engineering and next steps
> "The browser re-implements the feature pipeline, so parity tests check it matches Python,
> and an end-to-end test drives the app in headless Chrome. Both run in CI. The battery estimate is
> about 0.2% a day on a phone and 1% on a watch. That estimate also caught a design mistake of mine:
> measuring heart rate after every spike would have cost more than leaving it on all the time."

> "Next I'd build native Android and Wear OS apps with the same ONNX models, connect alerts to
> Firebase and the nurse app, and use every 'I'm OK' tap as feedback to personalise thresholds.
> Thanks for watching."

---

**Before recording:** hard-refresh the page, close other tabs, set your zoom so the chips are
visible, and do one dry run. The replays are fixed recordings (plus tiny noise), so a fall that alerts in the dry run will alert on camera too.
