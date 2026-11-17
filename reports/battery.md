# Battery impact estimate

Analytical estimate, not a measurement on hardware. Assumptions are at the top of `ml/scripts/battery_estimate.py`; candidate rates and inference time are measured.

## Phone: ~0.19% of battery per day

* Stage 1 fires 620.0/h on lab ADL clips; assuming real days are 25% as busy over 16 waking hours ≈ 2480 stage-2 runs/day.
* Stage 2 (features + LightGBM + CNN) takes 0.178 ms here, ~1.42 ms estimated on the device.

| Component | Joules/day |
|---|---|
| accelerometer | 25.92 |
| batched wake-ups | 86.4 |
| stage-1 trigger | 0.09 |
| stage-2 inference | 3.53 |

## Wearable (wrist): ~1.03% of battery per day

* Stage 1 fires 499.0/h on lab ADL clips; assuming real days are 25% as busy over 16 waking hours ≈ 1996 stage-2 runs/day.
* Stage 2 (features + LightGBM + CNN) takes 0.137 ms here, ~2.73 ms estimated on the device.

| Component | Joules/day |
|---|---|
| accelerometer | 8.64 |
| batched wake-ups | 17.28 |
| stage-1 trigger | 0.01 |
| stage-2 inference | 0.82 |
| heart-rate bursts (60 s, only if score >= half threshold) | 15.92 |

* Heart-rate bursts: stage 2 scores >= 50% of the alarm threshold 44.2/h on held-out lab ADL. The pre-impact baseline comes from the watch's own periodic background heart-rate readings.

Design choices this avoids (% battery/day on their own):

* heart-rate burst after every stage-1 candidate (naive): 4.3%
* continuous heart rate instead of bursts: 3.1%
* stream raw accel to phone over BLE instead of on-watch inference: 2.5%

Takeaways: the two-stage design makes the ML almost free; the accelerometer and wake-ups dominate, so FIFO batching matters more than model size. On a watch, continuous optical heart rate would cost more than everything else combined, which is why heart rate is only sampled in a burst when stage 2 already suspects a fall. (A first version burst on every stage-1 candidate; this estimate showed that would cost more than continuous heart rate.)
