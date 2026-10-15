/**
 * equiv.mts — differential equivalence: does a variant execute the *same*
 * callbacks in the *same* order as upstream, for the same schedule?
 *
 * The animation frame queue is a priority queue with an ordering contract:
 * higher priority first, and (because the drain loop sorts with a stable sort)
 * callbacks of equal priority run in the order they were scheduled. The dominant
 * priority in VS Code is 0 (`scheduleAtNextAnimationFrame(w, fn)`), so that tie
 * order is the observable ordering for most of the workbench.
 *
 * usage: node equiv.mts [seeds]
 */
import { mulberry32 } from './prng.mts';

type ItemSpec = { id: string; priority: number; inserts: ItemSpec[] };
type FrameSpec = { items: ItemSpec[]; unregisterAfter: number | null };
type Script = { frames: FrameSpec[] };

function makeScript(seed: number): Script {
	const rand = mulberry32(seed);
	let counter = 0;
	const makeItem = (depth: number): ItemSpec => {
		const id = `i${counter++}`;
		let priority: number;
		const r = rand();
		if (r < 0.7) {
			priority = 0; // the dominant real-world priority
		} else if (r < 0.85) {
			priority = 10000;
		} else if (r < 0.95) {
			priority = -10000;
		} else {
			priority = Math.floor(rand() * 7) - 3;
		}
		const inserts: ItemSpec[] = [];
		if (depth > 0) {
			const count = rand() < 0.6 ? Math.floor(rand() * 3) : 0;
			for (let i = 0; i < count; i++) {
				inserts.push(makeItem(depth - 1));
			}
		}
		return { id, priority, inserts };
	};

	const frames: FrameSpec[] = [];
	const frameCount = 3 + Math.floor(rand() * 8);
	for (let f = 0; f < frameCount; f++) {
		const items: ItemSpec[] = [];
		const count = 1 + Math.floor(rand() * 8);
		for (let i = 0; i < count; i++) {
			items.push(makeItem(2));
		}
		const unregisterAfter = rand() < 0.08 ? Math.floor(rand() * (count + 1)) : null;
		frames.push({ items, unregisterAfter });
	}
	return { frames };
}

interface VariantModule {
	scheduleAtNextAnimationFrame(win: unknown, runner: () => void, priority?: number): unknown;
	runAtThisOrScheduleAtNextAnimationFrame(win: unknown, runner: () => void, priority?: number): unknown;
	__getWindowId(win: unknown): number;
	__fireWindowUnregister(id: number): void;
	__unexpectedErrors: unknown[];
}

async function run(mod: VariantModule, script: Script): Promise<string> {
	const log: string[] = [];
	let pending: Array<() => void> = [];
	const win: any = { requestAnimationFrame(cb: () => void) { pending.push(cb); return pending.length; } };

	const schedule = (spec: ItemSpec) => {
		mod.scheduleAtNextAnimationFrame(win, () => {
			log.push(spec.id);
			for (const insert of spec.inserts) {
				mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => { log.push(insert.id); }, insert.priority);
			}
		}, spec.priority);
	};

	for (const frame of script.frames) {
		for (const item of frame.items) {
			schedule(item);
		}
		const callbacks = pending;
		pending = [];
		if (callbacks.length !== 1) {
			return `internal error: ${callbacks.length} callbacks requested for the frame`;
		}
		if (frame.unregisterAfter !== null) {
			const id = mod.__getWindowId(win);
			// let the first `unregisterAfter` callbacks run, then close the window
			const inner = callbacks[0];
			const wrapper = () => {
				mod.__fireWindowUnregister(id);
				inner();
			};
			wrapper();
		} else {
			callbacks[0]();
		}
	}
	const errors = mod.__unexpectedErrors.length;
	const drained = pending.length;
	return `${log.join(',')}|errors=${errors}|leftoverFrames=${drained}`;
}

const variants: Record<string, string> = {
	current: './variants/current.mts',
	'sort-once': './variants/sort-once.mts',
	'ordered-insert': './variants/ordered-insert.mts',
	heap: './variants/heap.mts',
	'stable-heap': './variants/stable-heap.mts',
};

const loaded: Record<string, VariantModule> = {};
for (const [name, path] of Object.entries(variants)) {
	loaded[name] = await import(path) as VariantModule;
}

const seeds = Number(process.argv[2] ?? 500);
const results: Record<string, { mismatches: number; firstMismatch: string | null }> = {};
for (const name of Object.keys(variants)) {
	if (name === 'current') { continue; }
	results[name] = { mismatches: 0, firstMismatch: null };
}

for (let seed = 1; seed <= seeds; seed++) {
	const script = makeScript(seed);
	const expected = await run(loaded.current, script);
	for (const name of Object.keys(variants)) {
		if (name === 'current') { continue; }
		const actual = await run(loaded[name], script);
		if (actual !== expected) {
			results[name].mismatches++;
			if (!results[name].firstMismatch) {
				results[name].firstMismatch = `seed=${seed}\n  current : ${expected.slice(0, 300)}\n  ${name.padEnd(8)}: ${actual.slice(0, 300)}`;
			}
		}
	}
}

console.log(`differential equivalence over ${seeds} randomized schedules:\n`);
for (const [name, r] of Object.entries(results)) {
	const verdict = r.mismatches === 0 ? 'IDENTICAL' : `DIVERGED in ${r.mismatches}/${seeds} schedules`;
	console.log(`${name.padEnd(16)} ${verdict}`);
	if (r.firstMismatch) {
		console.log(`  first divergence:\n${r.firstMismatch.split('\n').map(l => '  ' + l).join('\n')}`);
	}
}
