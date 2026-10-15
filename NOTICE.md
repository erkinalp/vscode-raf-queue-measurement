## Licensing note

`dom/dom-main.ts` and the generated `src/variants/*.mts` files contain the animation frame
section of `src/vs/base/browser/dom.ts` from [microsoft/vscode](https://github.com/microsoft/vscode),
which is MIT licensed. They are included so the measurements can be reproduced offline; the
upstream file is unmodified and `src/verify.mjs` checks that the patched file and the
benchmarked variant are the same code.
