/**
 * bench-worker.mts — one measurement point, in its own process.
 *
 * Running each variant in a fresh process keeps inline caches, JIT state and GC
 * pressure from leaking across variants (a same-process A/B is not trustworthy
 * for sub-microsecond work).
 *
 * usage: node bench-worker.mts <variant> <n> <priorityDist> <insert> <innerIters> <samples>
 *   priorityDist: zeros | mixed | random
 *   insert:       none | every:<k>:<zero|max|random>
 *
 * stdout: one JSON object.
 */
import { mulberry32 } from './prng.mts';

const [, , variant, nRaw, priorityDist, insertSpec, innerRaw, samplesRaw] = process.argv;
const n = Number(nRaw);
const innerIters = Number(innerRaw);
const samples = Number(samplesRaw);

const mod: any = await import(`./variants/${variant}.mts`);

// ---------------------------------------------------------------------------
// A window stand-in that mirrors how dom.ts uses requestAnimationFrame: one
// native callback per frame, requested lazily by scheduleAtNextAnimationFrame.
// ---------------------------------------------------------------------------
let nextFrame: Array<() => void> = [];
const win: any = {
	requestAnimationFrame(cb: () => void): number {
		nextFrame.push(cb);
		return nextFrame.length;
	},
};

const rand = mulberry32(0x9e3779b9);
const priorities: number[] = new Array(n);
for (let i = 0; i < n; i++) {
	if (priorityDist === 'zeros') {
		priorities[i] = 0;
	} else if (priorityDist === 'mixed') {
		// The real distribution: default priority everywhere plus the rare
		// `measure()` (10000) / `modify()` (-10000) entries.
		const r = rand();
		priorities[i] = r < 0.9 ? 0 : (r < 0.95 ? 10000 : -10000);
	} else {
		priorities[i] = Math.floor(rand() * 20001) - 10000;
	}
}

const m = /^every:(\d+):(zero|max|random)$/.exec(insertSpec);
const insertEvery = m ? Number(m[1]) : 0;
const insertPrio = m ? m[2] : 'zero';

let executed = 0;
let checksum = 0;

function makeBody(canInsert: boolean): () => void {
	return () => {
		checksum = (checksum + 1) | 0;
		executed++;
		if (canInsert && insertEvery > 0 && executed <= n && executed % insertEvery === 0) {
			const priority = insertPrio === 'zero' ? 0 : insertPrio === 'max' ? 10000 : Math.floor(rand() * 20001) - 10000;
			mod.runAtThisOrScheduleAtNextAnimationFrame(win, makeBody(false), priority);
		}
	};
}

function scheduleFrame(): void {
	for (let i = 0; i < n; i++) {
		mod.scheduleAtNextAnimationFrame(win, makeBody(true), priorities[i]);
	}
}

function drainFrame(): void {
	// Exactly one native callback should have been requested for this frame.
	const callbacks = nextFrame;
	nextFrame = [];
	if (callbacks.length !== 1) {
		throw new Error(`expected 1 animation frame callback, got ${callbacks.length} (n=${n})`);
	}
	callbacks[0]();
}

function oneFrame(): void {
	scheduleFrame();
	drainFrame();
}

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------
const WARMUP = Math.max(200, innerIters);

for (let i = 0; i < WARMUP; i++) {
	oneFrame();
}

// Characterise the cost of the timer itself so the drain-only numbers can be corrected.
let overheadTotal = 0;
const OVERHEAD_ITERS = 2000;
for (let i = 0; i < OVERHEAD_ITERS; i++) {
	const a = process.hrtime.bigint();
	const b = process.hrtime.bigint();
	overheadTotal += Number(b - a);
}
const timerOverheadNs = overheadTotal / OVERHEAD_ITERS;

const fullNs: number[] = [];
const drainRawNs: number[] = [];
for (let s = 0; s < samples; s++) {
	// Whole frame cycle: schedule n callbacks and drain them.
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < innerIters; i++) {
		scheduleFrame();
		drainFrame();
	}
	const t1 = process.hrtime.bigint();
	fullNs.push(Number(t1 - t0) / innerIters);

	// Drain only, with the timer inside the loop. The timer overhead is the same for
	// every variant, so the comparison is valid; the corrected value is reported too.
	let drainTotal = 0;
	for (let i = 0; i < innerIters; i++) {
		scheduleFrame();
		const a = process.hrtime.bigint();
		drainFrame();
		const b = process.hrtime.bigint();
		drainTotal += Number(b - a);
	}
	drainRawNs.push(drainTotal / innerIters);
}

function stats(xs: number[]) {
	const sorted = [...xs].sort((a, b) => a - b);
	const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
	return {
		min: sorted[0],
		p25: q(0.25),
		median: q(0.5),
		p75: q(0.75),
		max: sorted[sorted.length - 1],
		mean: xs.reduce((a, b) => a + b, 0) / xs.length,
	};
}

const drainCorrected = drainRawNs.map(x => Math.max(0, x - timerOverheadNs));

console.log(JSON.stringify({
	variant, n, priorityDist, insert: insertSpec, innerIters, samples,
	timerOverheadNs,
	fullNs: stats(fullNs),
	drainRawNs: stats(drainRawNs),
	drainNs: stats(drainCorrected),
	checksum,
}));

void mod.__unexpectedErrors;
