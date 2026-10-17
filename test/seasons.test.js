"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../lib/seasons");
const C = require("../lib/config");

test("date windows, also across the new year", () => {
	assert.equal(S.inWindow(new Date(2026, 9, 20), "10-15", "11-01"), true);
	assert.equal(S.inWindow(new Date(2026, 10, 2), "10-15", "11-01"), false);
	assert.equal(S.inWindow(new Date(2027, 0, 10), "12-01", "02-28"), true);
	assert.equal(S.inWindow(new Date(2026, 5, 10), "12-01", "02-28"), false);
	assert.equal(S.validMD("13-01"), false);
	assert.equal(S.validMD("02-29"), true);
});

test("easter window and upcoming events", () => {
	assert.deepEqual(S.windowOf({ easter: true }, 2027), { from: "03-14", until: "03-29" }); // Easter Sunday 28 March 2027
	const ids = S.upcoming(new Date(2026, 9, 18)).map((e) => e.id);
	assert.deepEqual(ids, ["halloween"]);
	assert.ok(S.upcoming(new Date(2026, 10, 20)).some((e) => e.id === "christmas"));
	assert.equal(S.matches("MMM-Halloween", ["halloween"]), true);
	assert.equal(S.matches("MMM-SnowFall", ["snow"]), true);
	assert.equal(S.matches("Displays fireworks at midnight", ["firework"]), true);
});

test("setSchedule writes showBetween and switches for today", () => {
	const src = fs.readFileSync(path.join(__dirname, "fixtures", "sample.config.js"), "utf8");
	const today = new Date();
	const mmdd = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	const inside = [mmdd(today), mmdd(today)];
	const later = new Date(today.getTime() + 40 * 86400000);
	const outside = [mmdd(later), mmdd(later)];
	let out = C.ops.setSchedule(src, { index: 4, module: "compliments", from: outside[0], until: outside[1] }).text;
	let e = C.listEntries(out)[4];
	assert.deepEqual(e.schedule, outside);
	assert.equal(e.disabled, true);
	out = C.ops.setSchedule(out, { index: 4, module: "compliments", from: inside[0], until: inside[1] }).text;
	assert.equal(C.listEntries(out)[4].disabled, false);
	out = C.ops.clearSchedule(out, { index: 4, module: "compliments" }).text;
	assert.equal(out, src);
});
