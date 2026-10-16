/**
 * inproduct.cjs — read the animation frame queue out of a real, running workbench.
 *
 * The cost curve in the README says what one drain costs at a given queue length. It cannot
 * say how long the queue actually gets; that depends on what the product does. The probe
 * patch (probe-ops.mjs) adds a per-drain histogram to `dom.ts` and publishes it as
 * `globalThis.__rafProbe`. This script boots the web workbench in headless Chrome, drives a
 * fixed scenario, and reports the histogram plus what the scenario actually did.
 *
 * No dependencies: Node's global fetch and WebSocket speak CDP directly.
 *
 * usage: node inproduct.cjs [--port 8080] [--debug-port 9222] [--seconds 40] [--out file.json]
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_PORT = Number(arg('port', '8080'));
const DEBUG_PORT = Number(arg('debug-port', '9222'));
const SECONDS = Number(arg('seconds', '40'));
const OUT = arg('out', path.join(__dirname, '..', 'results', 'inproduct.json'));
const CHROME = arg('chrome', '/usr/bin/google-chrome-stable');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await fn();
			if (value) { return value; }
		} catch (error) { lastError = error; }
		await sleep(500);
	}
	throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/** Minimal CDP client over one tab's websocket. */
class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		this.consoleLines = [];
		ws.addEventListener('message', event => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined) {
				const entry = this.pending.get(message.id);
				if (entry) {
					this.pending.delete(message.id);
					message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
				}
				return;
			}
			if (message.method === 'Runtime.consoleAPICalled') {
				const text = (message.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
				this.consoleLines.push(`${message.params.type}: ${text}`);
			}
			if (message.method === 'Runtime.exceptionThrown') {
				this.consoleLines.push(`exception: ${message.params.exceptionDetails?.text}`);
			}
		});
	}

	static async connect(wsUrl) {
		const ws = new WebSocket(wsUrl);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
		});
		return new Cdp(ws);
	}

	send(method, params = {}) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.delete(id)) { reject(new Error(`CDP timeout: ${method}`)); }
			}, 60000);
		});
	}

	async evaluate(expression) {
		const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) { throw new Error(`evaluate failed: ${result.exceptionDetails.text}`); }
		return result.result.value;
	}
}

const PROBE_EXPRESSION = `(() => {
	const p = globalThis.__rafProbe;
	if (!p) { return null; }
	const histogram = {};
	for (const key of Object.keys(p.histogram)) { histogram[key] = p.histogram[key]; }
	return JSON.stringify({ frames: p.frames, items: p.items, inFrameInserts: p.inFrameInserts, maxQueueLength: p.maxQueueLength, histogram });
})()`;

const RESET_EXPRESSION = `(() => {
	const p = globalThis.__rafProbe;
	if (!p) { return false; }
	p.frames = 0; p.items = 0; p.inFrameInserts = 0; p.maxQueueLength = 0; p.histogram = {};
	return true;
})()`;

const EVIDENCE_EXPRESSION = `JSON.stringify({
	editors: document.querySelectorAll('.monaco-editor').length,
	visibleLines: document.querySelectorAll('.view-line').length,
	textLength: (document.querySelector('.monaco-editor') || { innerText: '' }).innerText.length,
	visibilityState: document.visibilityState
})`;

async function key(cdp, { code, key, modifiers = 0 }) {
	await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, code: key, key, modifiers });
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, code: key, key, modifiers });
}

/** A fixed, reproducible interaction script. */
async function scenario(cdp) {
	const step = async (label, fn) => {
		process.stdout.write(`  scenario: ${label}\n`);
		await fn();
		await sleep(1000);
	};

	await step('command palette open/close x3', async () => {
		for (let i = 0; i < 3; i++) {
			await key(cdp, { code: 80, key: 'P', modifiers: 2 | 8 });
			await sleep(700);
			await key(cdp, { code: 27, key: 'Escape' });
			await sleep(500);
		}
	});
	await step('quick open a sample file x2', async () => {
		for (const name of ['file.js', 'file.css']) {
			await key(cdp, { code: 80, key: 'P', modifiers: 2 }); // ctrl+p
			await sleep(900);
			for (const ch of name) {
				await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
				await sleep(60);
			}
			await sleep(700);
			await key(cdp, { code: 13, key: 'Enter' });
			await sleep(1200);
		}
	});
	await step('type ~2000 characters into an editor', async () => {
		await key(cdp, { code: 78, key: 'n', modifiers: 2 }); // ctrl+n new untitled file
		await sleep(1500);
		for (let i = 0; i < 50; i++) {
			const text = `const value_${i} = compute(${i}, 'text ${i}');\n`;
			for (const ch of text) {
				await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
			}
			await sleep(220);
		}
	});
	await step('toggle sidebar and panel', async () => {
		await key(cdp, { code: 66, key: 'b', modifiers: 2 });
		await sleep(900);
		await key(cdp, { code: 66, key: 'b', modifiers: 2 });
		await sleep(600);
		await key(cdp, { code: 192, key: '`', modifiers: 2 });
		await sleep(1200);
		await key(cdp, { code: 192, key: '`', modifiers: 2 });
	});
	await step('zoom in/out x3', async () => {
		for (let i = 0; i < 3; i++) {
			await key(cdp, { code: 187, key: '=', modifiers: 2 });
			await sleep(600);
			await key(cdp, { code: 189, key: '-', modifiers: 2 });
			await sleep(600);
		}
	});
	await step('wheel scroll over the editor', async () => {
		for (let i = 0; i < 12; i++) {
			await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: i % 2 === 0 ? 300 : -300 });
			await sleep(220);
		}
	});
	await step('idle settle', async () => sleep(3000));
}

function summarize(probe) {
	const entries = Object.entries(probe.histogram).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
	const frames = probe.frames;
	const share = limit => frames ? Number((entries.filter(([len]) => len <= limit).reduce((a, [, v]) => a + v, 0) / frames * 100).toFixed(2)) : 0;
	return {
		...probe,
		meanQueueLength: frames ? Number((probe.items / frames).toFixed(3)) : 0,
		histogramByLength: Object.fromEntries(entries),
		shareOfDrainsAtMost1: share(1),
		shareOfDrainsAtMost4: share(4),
		shareOfDrainsAtMost12: share(12),
	};
}

async function main() {
	const userDataDir = fs.mkdtempSync('/home/erkinalp/vscode-272155/chrome-probe-');
	const chrome = spawn(CHROME, [
		'--headless=new',
		`--remote-debugging-port=${DEBUG_PORT}`,
		`--user-data-dir=${userDataDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-networking',
		'--disable-extensions',
		'--no-sandbox',
		// Without these Chrome throttles requestAnimationFrame for an occluded tab, and a
		// throttled page produces almost no frames to measure.
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',
		'--window-size=1600,1000',
		`http://localhost:${APP_PORT}/`,
	], { stdio: ['ignore', 'pipe', 'pipe'] });
	chrome.stderr.on('data', () => { /* chrome is chatty; the CDP calls are the signal */ });

	let cdp;
	try {
		await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok, 30000, 'chrome devtools endpoint');
		process.stdout.write('chrome devtools is up\n');

		const targets = await waitFor(async () => {
			const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
			return list.some(t => t.type === 'page' && String(t.url).startsWith('http')) ? list : null;
		}, 60000, 'the app tab');
		const app = targets.find(t => t.type === 'page' && String(t.url).startsWith('http'));
		process.stdout.write(`attaching to ${app.url}\n`);
		cdp = await Cdp.connect(app.webSocketDebuggerUrl);
		await cdp.send('Runtime.enable');
		await cdp.send('Page.enable');
		await cdp.send('Page.bringToFront');
		await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);

		// A VPN reconnect makes Chrome abort in-flight requests (net::ERR_NETWORK_CHANGED) and the
		// workbench loads ~10k modules over HTTP, so one aborted load is enough to leave the page
		// blank. Reload and retry instead of failing the measurement.
		const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
		let booted = false;
		let lastError;
		for (let attempt = 1; attempt <= 5 && !booted; attempt++) {
			process.stdout.write(`boot attempt ${attempt}: ${APP_URL}\n`);
			await cdp.evaluate('1').catch(() => undefined);
			await cdp.send('Page.navigate', { url: APP_URL });
			try {
				await waitFor(async () => await cdp.evaluate('typeof globalThis.__rafProbe !== "undefined" && globalThis.__rafProbe !== null'), 90000, 'the probe');
				booted = true;
			} catch (error) {
				lastError = error;
				process.stdout.write(`  attempt ${attempt} did not boot: ${error.message}\n`);
				const failures = cdp.consoleLines.filter(l => /ERR_NETWORK_CHANGED|SyntaxError|exception/.test(l)).slice(-3);
				if (failures.length) { process.stdout.write('  ' + failures.join('\n  ') + '\n'); }
				await sleep(5000);
			}
		}
		if (!booted) {
			process.stdout.write('the probe never appeared; page console tail:\n' + cdp.consoleLines.slice(-25).join('\n') + '\n');
			throw lastError;
		}
		process.stdout.write('workbench booted and the probe is attached\n');

		await sleep(10000); // let startup settle
		const startup = JSON.parse(await cdp.evaluate(PROBE_EXPRESSION));
		const framesPerSecond = await cdp.evaluate('new Promise(res => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(n / 2); }; requestAnimationFrame(tick); })');

		await cdp.evaluate(RESET_EXPRESSION);
		const started = Date.now();
		await scenario(cdp);
		const scenarioSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
		const scenarioPhase = JSON.parse(await cdp.evaluate(PROBE_EXPRESSION));
		const evidence = JSON.parse(await cdp.evaluate(EVIDENCE_EXPRESSION));

		await cdp.evaluate(RESET_EXPRESSION);
		await sleep(Math.max(15000, SECONDS * 1000));
		const idle = JSON.parse(await cdp.evaluate(PROBE_EXPRESSION));

		const result = {
			generatedAt: new Date().toISOString(),
			app: `http://localhost:${APP_PORT}/`,
			chrome: CHROME,
			rendererFramesPerSecond: framesPerSecond,
			scenarioSeconds,
			scenarioEvidence: evidence,
			phase: { startup: summarize(startup), scenario: summarize(scenarioPhase), idle: summarize(idle) },
			consoleTail: cdp.consoleLines.slice(-20),
		};
		fs.mkdirSync(path.dirname(OUT), { recursive: true });
		fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
		process.stdout.write(`\n${JSON.stringify({ rendererFramesPerSecond: result.rendererFramesPerSecond, scenarioSeconds, scenarioEvidence: evidence, phase: result.phase }, null, 2)}\n\nwrote ${OUT}\n`);
	} finally {
		if (cdp) { try { await cdp.send('Browser.close'); } catch { /* ignore */ } }
		chrome.kill('SIGKILL');
		try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
	}
}

main().catch(error => {
	console.error(`FAILED: ${error.message}`);
	process.exit(1);
});
