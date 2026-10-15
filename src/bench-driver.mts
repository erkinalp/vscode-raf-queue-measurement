/**
 * bench-driver.mts — run the full matrix, one worker process per point.
 *
 * usage: node bench-driver.mts [--quick]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('--quick');

const variants = ['current', 'sort-once', 'ordered-insert', 'heap'];
const ns = quick ? [1, 2, 10, 50, 100] : [1, 2, 3, 5, 10, 25, 50, 100, 200, 500];
const dists = ['zeros', 'mixed'];
const inserts = quick ? ['none'] : ['none', 'every:1:zero', 'every:1:max'];

interface Point {
	variant: string; n: number; priorityDist: string; insert: string;
	timerOverheadNs: number;
	fullNs: { median: number; p25: number; p75: number; min: number; mean: number };
	drainNs: { median: number; p25: number; p75: number; min: number; mean: number };
}

function innerItersFor(n: number): number {
	// The per-frame cost grows like n^2, so the iteration budget has to shrink like n^2
	// as well, otherwise one n=500 point costs minutes.
	return Math.max(150, Math.min(20000, Math.floor(20_000_000 / (n * n + 20))));
}

const points: Point[] = [];
const failures: string[] = [];
let done = 0;
const total = variants.length * ns.length * dists.length * inserts.length;

for (const variant of variants) {
	for (const n of ns) {
		for (const priorityDist of dists) {
			for (const insert of inserts) {
				const innerIters = innerItersFor(n);
				const samples = quick ? 5 : 9;
				const r = spawnSync(process.execPath, [
					join(here, 'bench-worker.mts'), variant, String(n), priorityDist, insert,
					String(innerIters), String(samples),
				], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
				done++;
				if (r.status !== 0) {
					failures.push(`${variant} n=${n} ${priorityDist} ${insert}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
					continue;
				}
				const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
				points.push(parsed);
				const f = parsed.fullNs.median;
				process.stderr.write(`[${done}/${total}] ${variant.padEnd(15)} n=${String(n).padStart(4)} ${priorityDist.padEnd(6)} ${insert.padEnd(14)} full=${f.toFixed(0)}ns\n`);
			}
		}
	}
}

mkdirSync(join(here, 'results'), { recursive: true });
const outPath = join(here, 'results', `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, points, failures }, null, 2));

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
const lines: string[] = [];
lines.push('## Per-frame cost of the animation frame queue (median of 9 samples, ns/frame)');
lines.push('');
lines.push('`full` = schedule n callbacks through `scheduleAtNextAnimationFrame` and drain them in one frame.');
lines.push('');

for (const priorityDist of dists) {
	for (const insert of inserts) {
		lines.push(`### priorities: ${priorityDist}, in-frame insertions: ${insert}`);
		lines.push('');
		const header = ['n', ...variants];
		lines.push(`| ${header.join(' | ')} |`);
		lines.push(`|${header.map(() => '---').join('|')}|`);
		for (const n of ns) {
			const row = [String(n)];
			for (const variant of variants) {
				const p = points.find(x => x.variant === variant && x.n === n && x.priorityDist === priorityDist && x.insert === insert);
				row.push(p ? p.fullNs.median.toFixed(1) : '—');
			}
			lines.push(`| ${row.join(' | ')} |`);
		}
		lines.push('');
	}
}

lines.push('### Speed-up of `ordered-insert` over `current` (full frame, median)');
lines.push('');
lines.push('| n | priorities | insertions | current ns | ordered-insert ns | speed-up |');
lines.push('|---|---|---|---|---|---|');
for (const n of ns) {
	for (const priorityDist of dists) {
		for (const insert of inserts) {
			const a = points.find(x => x.variant === 'current' && x.n === n && x.priorityDist === priorityDist && x.insert === insert);
			const b = points.find(x => x.variant === 'ordered-insert' && x.n === n && x.priorityDist === priorityDist && x.insert === insert);
			if (!a || !b) { continue; }
			lines.push(`| ${n} | ${priorityDist} | ${insert} | ${a.fullNs.median.toFixed(1)} | ${b.fullNs.median.toFixed(1)} | ${(a.fullNs.median / b.fullNs.median).toFixed(2)}× |`);
		}
	}
}
lines.push('');
lines.push('### Heap proposal (issue #272155) vs current');
lines.push('');
lines.push('| n | priorities | insertions | current ns | heap ns | heap/current |');
lines.push('|---|---|---|---|---|---|');
for (const n of ns) {
	for (const priorityDist of dists) {
		for (const insert of inserts) {
			const a = points.find(x => x.variant === 'current' && x.n === n && x.priorityDist === priorityDist && x.insert === insert);
			const b = points.find(x => x.variant === 'heap' && x.n === n && x.priorityDist === priorityDist && x.insert === insert);
			if (!a || !b) { continue; }
			lines.push(`| ${n} | ${priorityDist} | ${insert} | ${a.fullNs.median.toFixed(1)} | ${b.fullNs.median.toFixed(1)} | ${(b.fullNs.median / a.fullNs.median).toFixed(2)}× |`);
		}
	}
}
lines.push('');

writeFileSync(outPath.replace(/\.json$/, '.md'), lines.join('\n'));
process.stderr.write(`\nwrote ${outPath}\nwrote ${outPath.replace(/\.json$/, '.md')}\n`);
if (failures.length) {
	process.stderr.write(`\n${failures.length} failures:\n${failures.join('\n')}\n`);
	process.exitCode = 1;
}
