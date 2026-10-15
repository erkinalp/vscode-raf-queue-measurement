/**
 * verify.mjs — prove that the code that ships is the code that was measured.
 *
 *   variants/ordered-insert.mts  = dom-main.ts (upstream)  + FIX_OPS   [benchmarked]
 *   variants/from-patched.mts    = dom-main-fixed.ts (the patch)        [shipped]
 *
 * The animation frame section of both must be the same text.
 */
import { readFileSync } from 'node:fs';

const MARKER = 'class AnimationFrameQueueItem implements IDisposable {';

function section(path) {
	const text = readFileSync(path, 'utf8');
	const idx = text.indexOf(MARKER);
	if (idx < 0) {
		throw new Error(`no animation frame section in ${path}`);
	}
	return text.slice(idx);
}

const measured = section('variants/ordered-insert.mts');
const shipped = section('variants/from-patched.mts');

if (measured === shipped) {
	console.log('OK: the shipped dom.ts and the benchmarked ordered-insert variant are the same code');
	console.log(`    animation frame section: ${shipped.split('\n').length} lines, sha256 ${(await import('node:crypto')).createHash('sha256').update(shipped).digest('hex').slice(0, 16)}`);
	process.exit(0);
}

// Report the first differing line
const a = measured.split('\n');
const b = shipped.split('\n');
for (let i = 0; i < Math.max(a.length, b.length); i++) {
	if (a[i] !== b[i]) {
		console.error(`MISMATCH at line ${i + 1}:\n  measured: ${JSON.stringify(a[i])}\n  shipped : ${JSON.stringify(b[i])}`);
		break;
	}
}
process.exit(1);
