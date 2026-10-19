/**
 * suspension.cjs — reproduce the display-sleep case reported on microsoft/vscode#272155:
 * while requestAnimationFrame is not being delivered, everything that schedules a callback
 * keeps appending to NEXT_QUEUE, and nothing drains it; the first frame after wake has to
 * drain the whole accumulation in one go.
 *
 * Instead of sleeping a display, this holds the rAF callbacks the workbench asks for (the
 * window keeps running its timers), then releases them, which is what the first frame after
 * wake does. It reports the accumulated queue length N, the drain duration and ns/item.
 *
 * usage: node suspension.cjs [--hold 120] [--hold 240] ... [--out file.json]
 *        (each --hold is one trial; trials run in the same page, so they are cumulative in
 *         wall time but independent in state)
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function argAll(name) {
	const out = [];
	process.argv.forEach((v, i) => { if (v === `--${name}` && process.argv[i + 1]) { out.push(Number(process.argv[i + 1])); } });
	return out;
}
function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_PORT = 8080;
const DEBUG_PORT = Number(arg('debug-port', '9410'));
const HOLDS = argAll('hold').length ? argAll('hold') : [120];
const OUT = arg('out', path.join(__dirname, '..', 'results', 'suspension.json'));
const CHROME = '/usr/bin/google-chrome-stable';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try { const v = await fn(); if (v) { return v; } } catch (e) { last = e; }
		await sleep(500);
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

class Cdp {
	constructor(ws) {
		this.ws = ws; this.nextId = 1; this.pending = new Map(); this.lines = [];
		ws.addEventListener('message', event => {
			const m = JSON.parse(event.data);
			if (m.id !== undefined) {
				const p = this.pending.get(m.id);
				if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
				return;
			}
			if (m.method === 'Runtime.exceptionThrown') { this.lines.push(`exception ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`); }
		});
	}
	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }); });
		return new Cdp(ws);
	}
	send(method, params = {}, timeout = 60000) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => { if (this.pending.delete(id)) { reject(new Error(`CDP timeout: ${method}`)); } }, timeout);
		});
	}
	async evaluate(expression, timeout) {
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
		if (r.exceptionDetails) { throw new Error(`evaluate failed: ${r.exceptionDetails.text}`); }
		return r.result.value;
	}
}

const HOLD_RAF = `(() => {
	const w = window;
	if (!w.__realRaf) { w.__realRaf = w.requestAnimationFrame.bind(w); }
	w.__held = [];
	w.requestAnimationFrame = cb => { w.__held.push(cb); return w.__held.length; };
	w.__heldAt = performance.now();
	return true;
})()`;

const RELEASE_RAF = `(() => {
	const w = window;
	const held = w.__held || [];
	if (held.length === 0) { return JSON.stringify({ released: 0, note: 'no pending frame callback' }); }
	// One pending native frame callback holds the whole accumulation (dom.ts requests a frame
	// once and only clears the flag when the runner runs).
	const started = performance.now();
	for (const cb of held) { cb(); }
	const elapsed = performance.now() - started;
	w.requestAnimationFrame = w.__realRaf;
	w.__held = [];
	const s = performance.now();
	return JSON.stringify({ released: held.length, drainMs: elapsed, probes: 'see next read', suspendedMs: s - w.__heldAt });
})()`;

const READ_PROBE = `(() => {
	const p = globalThis.__rafProbe;
	if (!p) { return null; }
	const histogram = {};
	for (const k of Object.keys(p.histogram)) { histogram[k] = p.histogram[k]; }
	return JSON.stringify({ frames: p.frames, items: p.items, inFrameInserts: p.inFrameInserts, maxQueueLength: p.maxQueueLength, histogram });
})()`;

const RESET_PROBE = `(() => {
	const p = globalThis.__rafProbe;
	if (!p) { return false; }
	p.frames = 0; p.items = 0; p.inFrameInserts = 0; p.maxQueueLength = 0; p.histogram = {};
	return true;
})()`;

/** Keep the workbench busy while frames are not being delivered (typing, palette, panels). */
async function driveActivity(cdp, untilMs) {
	let typed = 0;
	while (Date.now() < untilMs) {
		for (let i = 0; i < 40; i++) {
			await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: (typed + i) % 40 === 0 ? '\n' : 'q' });
		}
		typed += 40;
		if (typed % 400 === 0) {
			await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 80, code: 'P', key: 'P', modifiers: 2 | 8 });
			await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 80, code: 'P', key: 'P', modifiers: 2 | 8 });
			await sleep(300);
			await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
			await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
		}
		await sleep(150);
	}
	return typed;
}

async function main() {
	const dir = fs.mkdtempSync('/home/erkinalp/vscode-272155/susp-');
	const chrome = spawn(CHROME, [
		'--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${dir}`,
		'--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-sandbox',
		'--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding', '--window-size=1600,1000',
		`http://127.0.0.1:${APP_PORT}/`,
	], { stdio: ['ignore', 'pipe', 'pipe'] });
	chrome.stderr.on('data', () => {});

	let cdp;
	const trials = [];
	try {
		await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok, 30000, 'devtools');
		const list = await waitFor(async () => {
			const l = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
			return l.some(t => t.type === 'page' && String(t.url).startsWith('http')) ? l : null;
		}, 60000, 'app tab');
		const app = list.find(t => t.type === 'page' && String(t.url).startsWith('http'));
		cdp = await Cdp.connect(app.webSocketDebuggerUrl);
		await cdp.send('Runtime.enable');
		await cdp.send('Page.enable');
		await cdp.send('Page.bringToFront');
		await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);

		for (let attempt = 1; attempt <= 4; attempt++) {
			process.stdout.write(`boot attempt ${attempt}\n`);
			await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
			try { await waitFor(async () => await cdp.evaluate('typeof globalThis.__rafProbe !== "undefined" && globalThis.__rafProbe !== null'), 90000, 'probe'); break; }
			catch (e) { process.stdout.write(`  ${e.message}\n`); await sleep(5000); }
		}
		process.stdout.write('workbench booted\n');
		await sleep(10000);

		// prove the workbench is scheduling normally before the suspension
		const baseline = JSON.parse(await cdp.evaluate(READ_PROBE));
		process.stdout.write(`baseline: ${baseline.frames} drains, max n ${baseline.maxQueueLength}\n`);

		for (const hold of HOLDS) {
			await cdp.evaluate(RESET_PROBE);
			await cdp.evaluate(HOLD_RAF);
			process.stdout.write(`-- holding requestAnimationFrame for ${hold}s, with activity --\n`);
			const started = Date.now();
			const typed = await driveActivity(cdp, started + hold * 1000);
			const pending = await cdp.evaluate('window.__held ? window.__held.length : -1');
			const suspendedProbe = JSON.parse(await cdp.evaluate(READ_PROBE));
			const release = JSON.parse(await cdp.evaluate(RELEASE_RAF, 900000));
			const after = JSON.parse(await cdp.evaluate(READ_PROBE));
			const n = suspendedProbe.items; // items are only counted when the drain starts
			const drainMs = typeof release.drainMs === 'number' ? release.drainMs : null;
			const items = after.items || n;
			const item = { holdSeconds: hold, typedCharacters: typed, pendingFrameCallbacks: pending, drainsDuringSuspension: suspendedProbe.frames, release, drainMs, n: items, itemsPerSecond: items / hold, nsPerItem: drainMs === null ? null : (drainMs * 1e6) / Math.max(1, items) };
			trials.push(item);
			process.stdout.write(`   typed=${typed} n=${item.n} (${item.itemsPerSecond.toFixed(1)}/s) drainMs=${drainMs === null ? 'n/a' : drainMs.toFixed(1)} ns/item=${item.nsPerItem === null ? 'n/a' : item.nsPerItem.toFixed(0)}\n`);
			await sleep(5000);
		}

		const result = { generatedAt: new Date().toISOString(), app: `http://127.0.0.1:${APP_PORT}/`, chrome: CHROME, holds: HOLDS, baseline, trials, consoleTail: cdp.lines.slice(-10) };
		fs.mkdirSync(path.dirname(OUT), { recursive: true });
		fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
		process.stdout.write('\n' + JSON.stringify(trials, null, 2) + `\nwrote ${OUT}\n`);
	} finally {
		if (cdp) { try { await cdp.send('Browser.close'); } catch {} }
		chrome.kill('SIGKILL');
		try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
	}
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
