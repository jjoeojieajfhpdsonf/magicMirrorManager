"use strict";
// Line diff (longest common subsequence), good enough for config files of a few hundred lines.
// Returns hunks of { type: " " | "+" | "-", line } with 2 lines of context.
function diffLines(a, b, context = 2) {
	const A = a.split("\n");
	const B = b.split("\n");
	// trim common prefix/suffix to keep the table small
	let pre = 0;
	while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
	let suf = 0;
	while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
	const a2 = A.slice(pre, A.length - suf);
	const b2 = B.slice(pre, B.length - suf);
	const n = a2.length;
	const m = b2.length;
	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const ops = [];
	for (let k = 0; k < pre; k++) ops.push({ type: " ", line: A[k], n: k + 1 });
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a2[i] === b2[j]) {
			ops.push({ type: " ", line: a2[i], n: pre + j + 1 });
			i++;
			j++;
		} else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
			ops.push({ type: "+", line: b2[j], n: pre + j + 1 });
			j++;
		} else {
			ops.push({ type: "-", line: a2[i] });
			i++;
		}
	}
	for (let k = A.length - suf; k < A.length; k++) ops.push({ type: " ", line: A[k], n: k - A.length + B.length + 1 });
	// keep only changed lines plus context
	const keep = new Array(ops.length).fill(false);
	ops.forEach((o, k) => {
		if (o.type !== " ") for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true;
	});
	const out = [];
	ops.forEach((o, k) => {
		if (keep[k]) out.push(o);
		else if (out.length && out[out.length - 1].type !== "…") out.push({ type: "…", line: "" });
	});
	if (out.length && out[out.length - 1].type === "…") out.pop();
	return out;
}

module.exports = { diffLines };
