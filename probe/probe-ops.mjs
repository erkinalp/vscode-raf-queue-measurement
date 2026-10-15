#!/usr/bin/env node
/**
 * probe-ops.mjs — instrumentation for the in-product measurement.
 *
 * NOT part of the change. Adds a per-frame histogram of the animation frame queue
 * length to the built workbench and publishes it as `globalThis.__rafProbe`, so the
 * number that decides issue #272155 (how long is the queue, really?) can be read out
 * of the real product instead of guessed.
 *
 * usage: node probe-ops.mjs <dom.ts> <out.ts>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
	console.error('usage: node probe-ops.mjs <dom.ts> <out.ts>');
	process.exit(2);
}

const T = '\t';
const source = readFileSync(inPath, 'utf8');

const PROBE_OBJECT = [
	`${T}const __rafProbe = {`,
	`${T}${T}frames: 0,`,
	`${T}${T}items: 0,`,
	`${T}${T}inFrameInserts: 0,`,
	`${T}${T}maxQueueLength: 0,`,
	`${T}${T}histogram: {} as { [length: number]: number },`,
	`${T}};`,
	`${T}(globalThis as any)['__rafProbe'] = __rafProbe;`,
	`${T}const inAnimationFrameRunner = new Map<number /* window ID */, boolean>();`,
].join('\n');

const ops = [
	{
		find: `${T}${T}const currentQueue = NEXT_QUEUE.get(targetWindowId) ?? [];\n${T}${T}CURRENT_QUEUE.set(targetWindowId, currentQueue);\n${T}${T}NEXT_QUEUE.set(targetWindowId, []);\n\n${T}${T}inAnimationFrameRunner.set(targetWindowId, true);`,
		replace: `${T}${T}const currentQueue = NEXT_QUEUE.get(targetWindowId) ?? [];\n${T}${T}CURRENT_QUEUE.set(targetWindowId, currentQueue);\n${T}${T}NEXT_QUEUE.set(targetWindowId, []);\n\n${T}${T}__rafProbe.frames++;\n${T}${T}__rafProbe.items += currentQueue.length;\n${T}${T}if (currentQueue.length > __rafProbe.maxQueueLength) { __rafProbe.maxQueueLength = currentQueue.length; }\n${T}${T}__rafProbe.histogram[currentQueue.length] = (__rafProbe.histogram[currentQueue.length] ?? 0) + 1;\n\n${T}${T}inAnimationFrameRunner.set(targetWindowId, true);`,
		count: 1,
	},
	{
		find: `${T}const inAnimationFrameRunner = new Map<number /* window ID */, boolean>();`,
		replace: PROBE_OBJECT,
		count: 1,
	},
	{
		find: `${T}${T}${T}currentQueue.push(item);`,
		replace: `${T}${T}${T}__rafProbe.inFrameInserts++;\n${T}${T}${T}currentQueue.push(item);`,
		count: 1,
	},
];

let out = source;
for (const { find, replace, count } of ops) {
	const hits = out.split(find).length - 1;
	if (hits !== count) {
		throw new Error(`anchor matched ${hits} times, expected ${count}:\n---\n${find}\n---`);
	}
	out = out.replaceAll(find, replace);
}
writeFileSync(outPath, out);
console.log(`instrumented ${inPath} -> ${outPath}`);
