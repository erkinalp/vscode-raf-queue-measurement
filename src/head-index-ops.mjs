/**
 * head-index-ops.mjs - drain without `shift()`.
 *
 * The reporter on #272155 points out that even with the sort hoisted out of the loop,
 * `shift()` is O(n) per item, so the drain stays Theta(n^2) - and that is the term that turns a
 * large post-wake queue into a freeze. These ops are applied on top of the shipped fix: the
 * queue is still sorted descending once, but it is walked with an index instead of being
 * moved down one slot per callback, and mid-frame insertions are placed in the part of the
 * queue that has not run yet.
 *
 * Exact ordering is preserved (verified by equiv.mts) because equal-priority items still go
 * after the ones already queued, and an insertion can never land before the next item to run.
 */
export const T = '\t';

const HEAD_STATE = [
	`${T}const inAnimationFrameRunner = new Map<number /* window ID */, boolean>();`,
	`${T}/**`,
	`${T} * Index of the next item to run in the queue that is currently being drained. Drains are`,
	`${T} * synchronous and cannot be re-entered, so one number is enough.`,
	`${T} */`,
	`${T}let queueHead = 0;`,
].join('\n');

const OLD_HELPER_SEARCH = [
	`${T}${T}let low = 0;`,
	`${T}${T}let high = queue.length;`,
].join('\n');

const NEW_HELPER_SEARCH = [
	`${T}${T}let low = queueHead; // never before the next item to run`,
	`${T}${T}let high = queue.length;`,
].join('\n');

const OLD_LOOP = [
	`${T}${T}currentQueue.sort(AnimationFrameQueueItem.sort);`,
	`${T}${T}while (currentQueue.length > 0) {`,
	`${T}${T}${T}const top = currentQueue.shift()!;`,
	`${T}${T}${T}top.execute();`,
	`${T}${T}}`,
].join('\n');

const NEW_LOOP = [
	`${T}${T}currentQueue.sort(AnimationFrameQueueItem.sort);`,
	`${T}${T}queueHead = 0;`,
	`${T}${T}while (queueHead < currentQueue.length) {`,
	`${T}${T}${T}const top = currentQueue[queueHead++];`,
	`${T}${T}${T}top.execute();`,
	`${T}${T}}`,
	`${T}${T}currentQueue.length = 0;`,
	`${T}${T}queueHead = 0;`,
].join('\n');

export const HEAD_INDEX_OPS = [
	{ find: `${T}const inAnimationFrameRunner = new Map<number /* window ID */, boolean>();`, replace: HEAD_STATE, count: 1 },
	{ find: OLD_HELPER_SEARCH, replace: NEW_HELPER_SEARCH, count: 1 },
	{ find: OLD_LOOP, replace: NEW_LOOP, count: 1 },
];
