/**
 * stable-heap-ops.mjs — the direction of PR #275565 (attempt 2), reduced to what it
 * actually needs: a priority queue with a sequence tie-break, so that callbacks of
 * equal priority still run in the order they were scheduled.
 *
 * This exists to answer two questions with data instead of argument:
 *   - is a heap faster than keeping the array sorted?           (yes)
 *   - does it have to change the execution order?               (no, with a tie-break)
 */
export const T = '\t';

const HEAP = [
	`${T}/**`,
	`${T} * Binary heap ordered by priority (descending) and, for equal priorities, by`,
	`${T} * scheduling order (ascending). The tie-break is what makes it behave like the`,
	`${T} * stable sort it replaces.`,
	`${T} */`,
	`${T}class AnimationFrameHeap {`,
	`${T}${T}private _items: AnimationFrameQueueItem[] = [];`,
	`${T}${T}get length(): number { return this._items.length; }`,
	`${T}${T}clear(): void { this._items.length = 0; }`,
	`${T}${T}push(item: AnimationFrameQueueItem): void {`,
	`${T}${T}${T}this._items.push(item);`,
	`${T}${T}${T}this._bubbleUp(this._items.length - 1);`,
	`${T}${T}}`,
	`${T}${T}shift(): AnimationFrameQueueItem | undefined {`,
	`${T}${T}${T}const items = this._items;`,
	`${T}${T}${T}if (items.length === 0) { return undefined; }`,
	`${T}${T}${T}if (items.length === 1) { return items.pop(); }`,
	`${T}${T}${T}const result = items[0];`,
	`${T}${T}${T}items[0] = items.pop()!;`,
	`${T}${T}${T}this._bubbleDown(0);`,
	`${T}${T}${T}return result;`,
	`${T}${T}}`,
	`${T}${T}private _bubbleUp(index: number): void {`,
	`${T}${T}${T}const items = this._items;`,
	`${T}${T}${T}const item = items[index];`,
	`${T}${T}${T}while (index > 0) {`,
	`${T}${T}${T}${T}const parentIndex = (index - 1) >>> 1;`,
	`${T}${T}${T}${T}const parent = items[parentIndex];`,
	`${T}${T}${T}${T}if (AnimationFrameQueueItem.sort(item, parent) >= 0) { break; }`,
	`${T}${T}${T}${T}items[index] = parent;`,
	`${T}${T}${T}${T}index = parentIndex;`,
	`${T}${T}${T}}`,
	`${T}${T}${T}items[index] = item;`,
	`${T}${T}}`,
	`${T}${T}private _bubbleDown(index: number): void {`,
	`${T}${T}${T}const items = this._items;`,
	`${T}${T}${T}const length = items.length;`,
	`${T}${T}${T}const item = items[index];`,
	`${T}${T}${T}while (true) {`,
	`${T}${T}${T}${T}let firstIndex = index;`,
	`${T}${T}${T}${T}const leftIndex = 2 * index + 1;`,
	`${T}${T}${T}${T}const rightIndex = 2 * index + 2;`,
	`${T}${T}${T}${T}if (leftIndex < length && AnimationFrameQueueItem.sort(items[leftIndex], item) < 0) {`,
	`${T}${T}${T}${T}${T}firstIndex = leftIndex;`,
	`${T}${T}${T}${T}}`,
	`${T}${T}${T}${T}if (rightIndex < length && AnimationFrameQueueItem.sort(items[rightIndex], firstIndex === index ? item : items[firstIndex]) < 0) {`,
	`${T}${T}${T}${T}${T}firstIndex = rightIndex;`,
	`${T}${T}${T}${T}}`,
	`${T}${T}${T}${T}if (firstIndex === index) { break; }`,
	`${T}${T}${T}${T}items[index] = items[firstIndex];`,
	`${T}${T}${T}${T}index = firstIndex;`,
	`${T}${T}${T}}`,
	`${T}${T}${T}items[index] = item;`,
	`${T}${T}}`,
	`${T}}`,
	'',
	`${T}const animationFrameRunner = (targetWindowId: number) => {`,
].join('\n');

export const STABLE_HEAP_OPS = [
	// 1. a scheduling sequence number, so equal priorities keep their order
	{ find: `class AnimationFrameQueueItem implements IDisposable {`, replace: `let __animationFrameQueueSeq = 0;\n\nclass AnimationFrameQueueItem implements IDisposable {`, count: 1 },
	{ find: `${T}private _canceled: boolean;`, replace: `${T}private _seq: number;\n${T}private _canceled: boolean;`, count: 1 },
	{ find: `${T}${T}this.priority = priority;\n${T}${T}this._canceled = false;`, replace: `${T}${T}this.priority = priority;\n${T}${T}this._seq = __animationFrameQueueSeq++;\n${T}${T}this._canceled = false;`, count: 1 },
	{ find: `${T}${T}return b.priority - a.priority;`, replace: `${T}${T}return (b.priority - a.priority) || (a._seq - b._seq);`, count: 1 },
	// 2. the heap itself
	{ find: `${T}const animationFrameRunner = (targetWindowId: number) => {`, replace: HEAP, count: 1 },
	{ find: `${T}const NEXT_QUEUE = new Map<number /* window ID */, AnimationFrameQueueItem[]>();`, replace: `${T}const NEXT_QUEUE = new Map<number /* window ID */, AnimationFrameHeap>();`, count: 1 },
	{ find: `${T}const CURRENT_QUEUE = new Map<number /* window ID */, AnimationFrameQueueItem[]>();`, replace: `${T}const CURRENT_QUEUE = new Map<number /* window ID */, AnimationFrameHeap>();`, count: 1 },
	{ find: `${T}${T}if (currentQueue) {\n${T}${T}${T}currentQueue.length = 0;\n${T}${T}}`, replace: `${T}${T}if (currentQueue) {\n${T}${T}${T}currentQueue.clear();\n${T}${T}}`, count: 1 },
	{ find: `${T}${T}const currentQueue = NEXT_QUEUE.get(targetWindowId) ?? [];`, replace: `${T}${T}const currentQueue = NEXT_QUEUE.get(targetWindowId) ?? new AnimationFrameHeap();`, count: 1 },
	{ find: `${T}${T}NEXT_QUEUE.set(targetWindowId, []);`, replace: `${T}${T}NEXT_QUEUE.set(targetWindowId, new AnimationFrameHeap());`, count: 1 },
	{ find: `${T}${T}${T}nextQueue = [];`, replace: `${T}${T}${T}nextQueue = new AnimationFrameHeap();`, count: 1 },
	{ find: `${T}${T}while (currentQueue.length > 0) {\n${T}${T}${T}currentQueue.sort(AnimationFrameQueueItem.sort);\n${T}${T}${T}const top = currentQueue.shift()!;`, replace: `${T}${T}while (currentQueue.length > 0) {\n${T}${T}${T}const top = currentQueue.shift()!;`, count: 1 },
	{ find: `${T}${T}${T}currentQueue = [];`, replace: `${T}${T}${T}currentQueue = new AnimationFrameHeap();`, count: 1 },
];
