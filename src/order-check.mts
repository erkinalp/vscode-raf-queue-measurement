/**
 * order-check.mts — reproduces, against the verbatim queue code, the exact schedules used
 * by the two regression tests added to src/vs/base/test/browser/animationFrame.test.ts, so
 * the expected sequences in those tests are not hand-derived.
 *
 * usage: node order-check.mts [variant]
 */
const which = process.argv[2] ?? 'current';
const mod: any = await import(`./variants/${which}.mts`);

function newWindow() {
	const pending: Array<() => void> = [];
	return {
		win: { requestAnimationFrame: (cb: () => void) => { pending.push(cb); return pending.length; } },
		run: () => { while (pending.length) { pending.shift()!(); } },
	};
}

// 1. equal-priority callbacks, including one added while the frame is running
{
	const { win, run } = newWindow();
	const calls: string[] = [];
	mod.scheduleAtNextAnimationFrame(win, () => calls.push('a'));
	mod.scheduleAtNextAnimationFrame(win, () => calls.push('b'));
	mod.scheduleAtNextAnimationFrame(win, () => {
		calls.push('frame');
		mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => calls.push('late'), -100);
		mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => calls.push('inserted'));
	}, 100);
	run();
	console.log(`${which.padEnd(14)} equal-priority        ${JSON.stringify(calls)}`);
}

// 2. insertion points: before, between and after the callbacks that are still waiting
{
	const { win, run } = newWindow();
	const calls: string[] = [];
	mod.scheduleAtNextAnimationFrame(win, () => calls.push('a'));
	mod.scheduleAtNextAnimationFrame(win, () => calls.push('b'));
	mod.scheduleAtNextAnimationFrame(win, () => calls.push('low'), -100);
	mod.scheduleAtNextAnimationFrame(win, () => {
		calls.push('inserter');
		mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => calls.push('before'), 1000);
		mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => calls.push('between'));
		mod.runAtThisOrScheduleAtNextAnimationFrame(win, () => calls.push('after'), -1000);
	}, 100);
	run();
	console.log(`${which.padEnd(14)} insertion-boundaries  ${JSON.stringify(calls)}`);
}
