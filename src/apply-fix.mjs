/**
 * apply-fix.mjs — produce the patched dom.ts using the shared fix definition.
 * usage: node apply-fix.mjs <dom.ts> <out.ts>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FIX_OPS, applyOps, NEW_PUSH } from './fix-ops.mjs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
	console.error('usage: node apply-fix.mjs <dom.ts> <out.ts>');
	process.exit(2);
}

const source = readFileSync(inPath, 'utf8');
const out = applyOps(source, FIX_OPS);

if (!out.includes(NEW_PUSH)) {
	throw new Error('insertion call site missing after patch');
}
if (!out.includes('queue.copyWithin(low + 1, low, queue.length - 1);')) {
	throw new Error('insertion helper missing after patch');
}

writeFileSync(outPath, out);
console.log(`patched ${inPath} -> ${outPath} (+${out.split('\n').length - source.split('\n').length} lines)`);
