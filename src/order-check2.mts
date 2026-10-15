const which = process.argv[2] ?? 'current';
const mod: any = await import(`./variants/${which}.mts`);
const pending: Array<() => void> = [];
const win: any = { requestAnimationFrame: (cb: () => void) => { pending.push(cb); return pending.length; } };
const calls: string[] = [];
mod.scheduleAtNextAnimationFrame(win, () => { calls.push('a'); });
mod.scheduleAtNextAnimationFrame(win, () => { calls.push('b'); });
mod.scheduleAtNextAnimationFrame(win, () => {
	calls.push('frame');
	mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => { calls.push('late'); }, -100);
	mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => { calls.push('inserted'); });
}, 100);
while (pending.length) { pending.shift()!(); }
console.log(which.padEnd(15), JSON.stringify(calls));
