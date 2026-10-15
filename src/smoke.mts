const name = process.argv[2];
const m: any = await import(`./variants/${name}.mts`);
const pending: Array<() => void> = [];
const win: any = { requestAnimationFrame: (cb: () => void) => { pending.push(cb); return pending.length; } };
const order: string[] = [];
for (let i = 0; i < 3; i++) { m.scheduleAtNextAnimationFrame(win, () => order.push('a' + i), i); }
m.scheduleAtNextAnimationFrame(win, () => { order.push('mid'); m.runAtThisOrScheduleAtNextAnimationFrame(win, () => order.push('ins'), 99); }, 0);
while (pending.length) { pending.shift()!(); }
console.log(name, '=>', order.join(','));
