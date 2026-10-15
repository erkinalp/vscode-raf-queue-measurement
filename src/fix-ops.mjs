/**
 * fix-ops.mjs — the single definition of the change to src/vs/base/browser/dom.ts.
 *
 * Both the patch generator (apply-fix.mjs) and the benchmark variant extractor
 * (extract-raf.mjs) consume these ops, so the code that is measured is literally the
 * code that ships. Each op asserts its match count.
 */
export const T = '\t';

export const HELP_DOC = [
	`${T}/**`,
	`${T} * Inserts \`item\` into \`queue\`, which must be sorted by priority in descending`,
	`${T} * order. Items with an equal priority are placed after the ones already in the`,
	`${T} * queue, which is the order a stable sort of the whole queue produced before.`,
	`${T} * Index moves only — no array is allocated and nothing is returned.`,
	`${T} */`,
	`${T}function insertSorted(queue: AnimationFrameQueueItem[], item: AnimationFrameQueueItem): void {`,
	`${T}${T}let low = 0;`,
	`${T}${T}let high = queue.length;`,
	`${T}${T}while (low < high) {`,
	`${T}${T}${T}const mid = (low + high) >>> 1;`,
	`${T}${T}${T}if (queue[mid].priority >= item.priority) {`,
	`${T}${T}${T}${T}low = mid + 1;`,
	`${T}${T}${T}} else {`,
	`${T}${T}${T}${T}high = mid;`,
	`${T}${T}${T}}`,
	`${T}${T}}`,
	`${T}${T}queue.push(item);`,
	`${T}${T}if (low < queue.length - 1) {`,
	`${T}${T}${T}queue.copyWithin(low + 1, low, queue.length - 1);`,
	`${T}${T}${T}queue[low] = item;`,
	`${T}${T}}`,
	`${T}}`,
	'',
	`${T}const animationFrameRunner = (targetWindowId: number) => {`,
].join('\n');

export const OLD_LOOP = [
	`${T}${T}inAnimationFrameRunner.set(targetWindowId, true);`,
	`${T}${T}while (currentQueue.length > 0) {`,
	`${T}${T}${T}currentQueue.sort(AnimationFrameQueueItem.sort);`,
	`${T}${T}${T}const top = currentQueue.shift()!;`,
	`${T}${T}${T}top.execute();`,
	`${T}${T}}`,
	'',
].join('\n');

export const NEW_LOOP = [
	`${T}${T}inAnimationFrameRunner.set(targetWindowId, true);`,
	`${T}${T}// Sort once and then keep the queue ordered while it drains. Executing a runner may`,
	`${T}${T}// add to this queue, but re-sorting it after every single execution is O(n² log n).`,
	`${T}${T}currentQueue.sort(AnimationFrameQueueItem.sort);`,
	`${T}${T}while (currentQueue.length > 0) {`,
	`${T}${T}${T}const top = currentQueue.shift()!;`,
	`${T}${T}${T}top.execute();`,
	`${T}${T}}`,
	'',
].join('\n');

export const OLD_PUSH = `${T}${T}${T}currentQueue.push(item);`;
export const NEW_PUSH = `${T}${T}${T}insertSorted(currentQueue, item);`;

export const FIX_OPS = [
	{ find: `${T}const animationFrameRunner = (targetWindowId: number) => {`, replace: HELP_DOC, count: 1 },
	{ find: OLD_LOOP, replace: NEW_LOOP, count: 1 },
	{ find: OLD_PUSH, replace: NEW_PUSH, count: 1 },
];

export function applyOps(text, ops) {
	let out = text;
	for (const { find, replace, count } of ops) {
		const hits = out.split(find).length - 1;
		if (hits !== count) {
			throw new Error(`anchor matched ${hits} times, expected ${count}:\n---\n${find}\n---`);
		}
		out = out.replaceAll(find, replace);
	}
	return out;
}
