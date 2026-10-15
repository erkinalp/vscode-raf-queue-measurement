# Does the animation frame queue cost anything? (`microsoft/vscode#272155`)

Measurements for ["Improve main rendering loop"](https://github.com/microsoft/vscode/issues/272155).

The issue says `animationFrameRunner` in `src/vs/base/browser/dom.ts` re-sorts the queue
before every callback — `O(n² log n)` — and estimates "1–2 ms per frame" with "50+ view
parts". Two PRs followed ([#274994](https://github.com/microsoft/vscode/pull/274994),
[#275565](https://github.com/microsoft/vscode/pull/275565)) and neither produced a number
from the product. This repo is the measurement.

## Method

The benchmark does **not** re-implement the queue. `src/extract-raf.mjs` copies the
animation frame section of `dom.ts` out of the real file, byte for byte, and replaces only
its four module-scope dependencies (`getWindowId`, `onDidUnregisterWindow`,
`markAsSingleton`, `onUnexpectedError`) with test doubles. Every candidate is produced from
that same text by an op list that asserts its match count, so a wrong edit fails loudly
instead of silently benchmarking something else.

`src/verify.mjs` closes the loop: it checks that the patched `dom.ts` that ships and the
variant that was benchmarked contain the **same code**.

Measured file: `dom/dom-main.ts`, `src/vs/base/browser/dom.ts` from microsoft/vscode main at
`375c6e74` (2026-10-15). Every variant runs in its own process (`src/bench-worker.mts`) so
inline caches, JIT state and GC pressure cannot leak between variants; each point is a
median of 9 samples of `N` frames after warmup, with an iteration budget that shrinks like
`n²` so a large-`n` point does not take minutes.

Machine: AMD Ryzen 9 5950X, Node 26.9.0 (V8 14.6.202.34), Linux.

## Cost per frame

`full` = schedule `n` callbacks through `scheduleAtNextAnimationFrame` and drain them in one
frame. Median ns/frame; lower is better.

Priorities: the real mix (mostly `0`, plus the rare `10000` from `measure()` / `-10000` from
`modify()`), no in-frame insertions.

| n | `current` (upstream) | `sort-once` (incorrect) | `ordered-insert` (PR) | `stable-heap` | `heap` (as proposed in the issue) |
|---|---|---|---|---|---|
| 1 | 157.0 | 147.8 | **149.1** | 143.8 | 127.9 |
| 2 | 305.0 | 280.5 | **273.3** | 180.7 | 181.8 |
| 3 | 464.0 | 347.0 | **335.3** | 247.0 | 213.6 |
| 5 | 692.2 | 401.7 | **450.1** | 376.8 | 269.1 |
| 10 | 1 641.6 | 629.1 | **647.6** | 512.5 | 473.1 |
| 25 | 6 042.8 | 1 375.9 | **1 418.1** | 1 423.1 | 912.8 |
| 50 | 20 065.8 | 2 720.8 | **2 806.8** | 2 953.9 | 1 912.2 |
| 100 | 68 718.3 | 5 479.7 | **5 484.4** | 5 940.6 | 3 390.7 |
| 200 | 257 838.5 | 12 652.7 | **13 299.0** | 13 072.8 | 6 995.4 |
| 500 | 1 581 100.6 | 33 602.8 | **35 176.7** | 38 510.5 | 19 605.8 |

*(`sort-once`, `ordered-insert` and `heap` from the 9-sample matrix; `stable-heap` from a
follow-up 7-sample run, see `results/variant-comparison.md`. Full matrices, including
in-frame insertion patterns and the `mixed` priority distribution, are in `results/`.)*

The upstream cost fits `≈ 68·n + 6.2·n²` ns: the quadratic term only takes over around
`n ≈ 11`.

**The issue's estimate is off by two orders of magnitude in the regime it names.** At 50
callbacks the entire queue costs 20 µs per frame, not 1–2 ms. 1.6 ms/frame is reached at
*n ≈ 500*. As a share of a 16.7 ms frame: 0.002 % at n=2, 0.10 % at n=10, 0.41 % at n=100,
9.5 % at n=500.

## Does the fix change the order callbacks run in?

The drain order is observable, and the dominant priority in the workbench is `0`, so
callbacks that share a priority run in scheduling order. `src/equiv.mts` drives every
candidate with the same randomized schedule — priorities, in-frame insertions from inside a
running callback, and mid-frame window close — and compares the executed sequence against
upstream, over 2000 schedules:

| variant | verdict |
|---|---|
| `ordered-insert` (the PR) | **IDENTICAL** in 2000/2000 |
| `stable-heap` (PR #275565's direction, with the sequence tie-break) | **IDENTICAL** in 2000/2000 |
| `sort-once` (hoist the sort out of the loop — the obvious one-liner) | **DIFFERENT** in 1948/2000 |
| `heap` (the binary heap proposed in the issue) | **DIFFERENT** in 1982/2000 |

Two consequences:

- Moving the sort out of the loop is **not** safe. `runAtThisOrScheduleAtNextAnimationFrame`
  appends to the current queue from inside a running callback, so the queue really can
  become unordered during the drain. Any fix has to order that insertion.
- The heap in the issue text reorders callbacks that share a priority — in the workbench that
  is most of them. It needs a scheduling sequence number to be order-preserving, and with one
  (`stable-heap`) it measured no better than the 15-line `ordered-insert` at any `n` above 5.

### Mutation check for the checked-in tests

The regression tests in `src/vs/base/test/browser/animationFrame.test.ts` pin two schedules:

| schedule | expected order |
|---|---|
| equal-priority callbacks plus one added while the frame runs | `['frame', 'a', 'b', 'inserted', 'late']` |
| insertion before, between and after the callbacks still pending | `['inserter', 'before', 'a', 'b', 'between', 'low', 'after']` |

Both expected sequences come from `src/order-check.mts` running the real code, not from hand
derivation, and both tests fail if the insertion search flips from `>=` to `>` (`variants/mutant-gt.mts`,
built by the same op list with that one character changed):

| schedule | correct (`>=`) | mutant (`>`) |
|---|---|---|
| equal-priority | `["frame","a","b","inserted","late"]` | `["frame","inserted","a","b","late"]` |
| insertion boundaries | `["inserter","before","a","b","between","low","after"]` | `["inserter","before","between","a","b","low","after"]` |

## What this does **not** measure

The distribution of `n` in the product. The best in-product evidence so far is from
@jrieken on #274994, who instrumented the function in a development build and measured the
totals for the *entire* sorting work over 5 startup runs as `0.30 / 0.19 / 0.09 / 0.20 / 0`
ms, with: *"looking at the counts, it seems the array is usually very short (1, 2)"*.
`probe/probe-ops.mjs` instruments the same histogram (`globalThis.__rafProbe`) if it needs to
be repeated.

The structural reason the queue is short: it is not a fan-in point. 83 files call
`scheduleAtNextAnimationFrame`, but each subsystem coalesces its own work first (its own
`RunOnceScheduler`, `AnimationFrameScheduler` or dirty flag), so `n` is bounded by the number
of *distinct* subsystems that reach a frame, not by the number of extensions, decorations or
editors.

## Reproduce

```sh
cd src
node extract-raf.mjs ../dom/dom-main.ts current        variants/current.mts
node extract-raf.mjs ../dom/dom-main.ts ordered-insert variants/ordered-insert.mts
node extract-raf.mjs ../dom/dom-main.ts sort-once      variants/sort-once.mts
node extract-raf.mjs ../dom/dom-main.ts heap           variants/heap.mts
node extract-raf.mjs ../dom/dom-main.ts stable-heap    variants/stable-heap.mts
node extract-raf.mjs ../dom/dom-main.ts mutant-gt      variants/mutant-gt.mts  # >= flipped to >

node apply-fix.mjs            ../dom/dom-main.ts ../dom/dom-main-fixed.ts
node extract-raf.mjs          ../dom/dom-main-fixed.ts current variants/from-patched.mts
node verify.mjs               # shipped code == benchmarked code

for v in current ordered-insert mutant-gt; do node order-check.mts $v; done  # the two unit-test schedules
node equiv.mts 2000           # differential equivalence
node bench-driver.mts         # full matrix -> results/
node bench-worker.mts current 100 zeros none 2000 9   # one point
```
