# Variant comparison (zeros priorities, no in-frame insertions)

Median ns/frame for the whole frame (schedule n + drain), 7 samples each, one process per point.

| n | current | ordered-insert (PR) | heap (issue) | stable-heap |
|---|---|---|---|---|
| 500 | 1575484.5 | 34658.7 | 18488.4 | 38510.5 |
