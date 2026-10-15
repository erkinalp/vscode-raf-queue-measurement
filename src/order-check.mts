/** Reproduces, against the verbatim code, the schedule used by the proposed unit test. */
const which = process.argv[2] ?? 'current';
const mod: any = await import(`./variants/${which}.mts`);
const pending: Array<() => void> = [];
const win: any = { requestAnimationFrame: (cb: () => void) => { pending.push(cb); return pending.length; } };
const calls: string[] = [];
mod.scheduleAtNextAnimationFrame(win, () => { calls.push('a'); }, 0);
mod.scheduleAtNextAnimationFrame(win, () => { calls.push('b'); }, 0);
mod.scheduleAtNextAnimationFrame(win, () => { calls.push('high'); }, 100);
mod.scheduleAtNextAnimationFrame(win, () => {
	calls.push('insert');
	mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => { calls.push('late-low'); }, -100);
	mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => { calls.push('inserted'); }, 0);
}, 0);
while (pending.length) { pending.shift()!(); }
console.log(which.padEnd(15), JSON.stringify(calls));
