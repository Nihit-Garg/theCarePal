# Evaluation results

Subject-wise 5-fold nested cross-validation (no person is in both train and test). Event-level metrics come from streaming every held-out recording through the full two-stage detector. Each fold's threshold was picked by an inner 4-fold CV on training subjects only, targeting sensitivity >= 95%. ± is the standard deviation across outer folds.

False alarms per hour are measured on lab ADL recordings, which are short, dense bursts of activity (hopping, jogging, clapping...). A real day is mostly quiet, so real-world rates should be far lower — treat these as a pessimistic upper bound.

## Phone (57 subjects, 5251 recordings)

| Model | Sensitivity | Specificity | False alarms / hour of ADL | Falls detected | ADL hours |
|---|---|---|---|---|---|
| Threshold only (baseline) | 94.9% ± 0.5% | 65.0% ± 2.7% | 118.69 ± 6.75 | 1903/2006 | 16.76 |
| LightGBM (classic) | 95.0% ± 2.6% | 99.6% ± 0.3% | 0.78 ± 0.67 | 1905/2006 | 16.76 |
| 1D-CNN (small NN) | 95.7% ± 2.6% | 99.9% ± 0.1% | 0.30 ± 0.26 | 1919/2006 | 16.76 |
| Ensemble (mean of both) | 94.9% ± 3.0% | 100.0% ± 0.0% | 0.00 ± 0.00 | 1903/2006 | 16.76 |

Subgroups (same thresholds):

| Model | Group | Sensitivity | Specificity | FA / hour |
|---|---|---|---|---|
| Threshold only (baseline) | umafall | 100.0% | 61.9% | 122.35 |
| Threshold only (baseline) | elderly_60plus | 81.3% | 75.1% | 105.14 |
| Threshold only (baseline) | sisfall | 94.3% | 65.6% | 118.12 |
| LightGBM (classic) | umafall | 92.3% | 98.7% | 3.15 |
| LightGBM (classic) | elderly_60plus | 73.3% | 100.0% | 0.00 |
| LightGBM (classic) | sisfall | 95.3% | 99.8% | 0.41 |
| 1D-CNN (small NN) | umafall | 91.8% | 99.4% | 1.35 |
| 1D-CNN (small NN) | elderly_60plus | 70.7% | 100.0% | 0.00 |
| 1D-CNN (small NN) | sisfall | 96.1% | 99.9% | 0.14 |
| Ensemble (mean of both) | umafall | 90.4% | 100.0% | 0.00 |
| Ensemble (mean of both) | elderly_60plus | 72.0% | 100.0% | 0.00 |
| Ensemble (mean of both) | sisfall | 95.4% | 100.0% | 0.00 |

Note: the elderly_60plus fall sensitivity comes from a single SisFall subject (SE06), the only participant over 60 who performed falls. It is a warning sign that older people's falls may look different, not a reliable estimate.

False alarms by ADL activity (count over all held-out subjects):

| Activity | Threshold only (baseline) | LightGBM (classic) | 1D-CNN (small NN) | Ensemble (mean of both) |
|---|---|---|---|---|
| Jogging slowly | 373 | 0 | 0 | 0 |
| Jogging quickly | 362 | 0 | 0 | 0 |
| Collapse into a chair | 156 | 3 | 0 | 0 |
| Stairs quickly | 141 | 0 | 2 | 0 |
| Sit in half-height chair quickly | 121 | 0 | 0 | 0 |
| Stumble while walking | 120 | 0 | 0 | 0 |
| Gentle jump | 120 | 0 | 0 | 0 |
| Walking quickly | 116 | 0 | 0 | 0 |
| Hopping | 85 | 1 | 2 | 0 |
| Sit in low chair quickly | 85 | 0 | 0 | 0 |
| Stairs slowly | 74 | 0 | 0 | 0 |
| Jogging | 54 | 0 | 0 | 0 |
| Walking | 50 | 0 | 0 | 0 |
| MakingACall | 36 | 6 | 0 | 0 |
| Turn over while lying | 24 | 3 | 0 | 0 |
| GoDownstairs | 17 | 0 | 0 | 0 |
| Sit in low chair slowly | 12 | 0 | 0 | 0 |
| GoUpstairs | 9 | 0 | 0 | 0 |
| OpeningDoor | 8 | 0 | 0 | 0 |
| Sitting_GettingUpOnAChair | 8 | 0 | 0 | 0 |
| Sit, lie down quickly | 7 | 0 | 0 | 0 |
| Walking slowly | 6 | 0 | 0 | 0 |
| LyingDown_OnABed | 5 | 0 | 1 | 0 |
| Aplausing | 0 | 0 | 0 | 0 |
| HandsUp | 0 | 0 | 0 | 0 |
| Bending | 0 | 0 | 0 | 0 |
| Sit in half-height chair slowly | 0 | 0 | 0 | 0 |
| Sit, lie down slowly | 0 | 0 | 0 | 0 |
| Bend at knees | 0 | 0 | 0 | 0 |
| Bend without bending knees | 0 | 0 | 0 | 0 |
| Get into a car | 0 | 0 | 0 | 0 |

## Wrist (19 subjects, 746 recordings)

| Model | Sensitivity | Specificity | False alarms / hour of ADL | Falls detected | ADL hours |
|---|---|---|---|---|---|
| Threshold only (baseline) | 95.7% ± 3.4% | 68.4% ± 5.1% | 101.49 ± 22.15 | 199/208 | 2.22 |
| LightGBM (classic) | 94.7% ± 4.0% | 90.5% ± 2.0% | 23.00 ± 4.94 | 197/208 | 2.22 |
| 1D-CNN (small NN) | 91.8% ± 6.0% | 92.4% ± 4.5% | 18.49 ± 10.98 | 191/208 | 2.22 |
| Ensemble (mean of both) | 93.8% ± 4.5% | 94.8% ± 3.0% | 12.63 ± 7.42 | 195/208 | 2.22 |

Subgroups (same thresholds):

| Model | Group | Sensitivity | Specificity | FA / hour |
|---|---|---|---|---|
| Threshold only (baseline) | umafall | 95.7% | 68.4% | 101.52 |
| Threshold only (baseline) | elderly_60plus | n/a (no falls) | 75.7% | 59.12 |
| LightGBM (classic) | umafall | 94.7% | 90.5% | 23.01 |
| LightGBM (classic) | elderly_60plus | n/a (no falls) | 81.1% | 45.98 |
| 1D-CNN (small NN) | umafall | 91.8% | 92.4% | 18.50 |
| 1D-CNN (small NN) | elderly_60plus | n/a (no falls) | 83.8% | 39.42 |
| Ensemble (mean of both) | umafall | 93.8% | 94.8% | 12.63 |
| Ensemble (mean of both) | elderly_60plus | n/a (no falls) | 83.8% | 39.42 |

False alarms by ADL activity (count over all held-out subjects):

| Activity | Threshold only (baseline) | LightGBM (classic) | 1D-CNN (small NN) | Ensemble (mean of both) |
|---|---|---|---|---|
| Hopping | 84 | 2 | 2 | 0 |
| Jogging | 50 | 1 | 0 | 0 |
| Aplausing | 43 | 27 | 11 | 12 |
| LyingDown_OnABed | 18 | 10 | 15 | 8 |
| HandsUp | 11 | 7 | 9 | 6 |
| Walking | 6 | 1 | 1 | 0 |
| GoDownstairs | 5 | 0 | 0 | 0 |
| Sitting_GettingUpOnAChair | 4 | 2 | 1 | 1 |
| OpeningDoor | 3 | 1 | 1 | 1 |
| GoUpstairs | 1 | 0 | 1 | 0 |
| Bending | 0 | 0 | 0 | 0 |
| MakingACall | 0 | 0 | 0 | 0 |
