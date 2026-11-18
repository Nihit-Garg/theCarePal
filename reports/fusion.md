# Fusion of phone + wrist

UMAFall recorded phone and wrist simultaneously. Subject-wise 5-fold CV over its 19 people: each fold's models never saw the test people. Thresholds are the shipped ones (nested-CV medians from metrics.json); those were chosen in CV folds that also contained these people as *training* data in other folds, so treat the absolute numbers as slightly optimistic — the comparison between rules is the point.

| Strategy | Sensitivity | Specificity | False alarms / hour | Falls detected |
|---|---|---|---|---|
| Phone only | 97.1% | 99.4% | 1.35 | 202/208 |
| Wrist only | 95.2% | 92.6% | 18.05 | 198/208 |
| Either device (OR) | 99.0% | 92.2% | 18.95 | 206/208 |
| Both devices (AND) | 92.8% | 100.0% | 0.00 | 193/208 |
| Mean of p/threshold (first version) | 96.6% | 99.8% | 0.45 | 201/208 |
| Log-odds margins, clip ±3 (shipped) | 98.6% | 99.8% | 0.45 | 205/208 |

Shipped rule: `logodds`. Its clip constant was fixed at 3 before evaluation; for transparency, the same rule with other clips: 2 → sensitivity 99.0%, 0.45 FA/h, 4 → sensitivity 98.1%, 0.00 FA/h.
