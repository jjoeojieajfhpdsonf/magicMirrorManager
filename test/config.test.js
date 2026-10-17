"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../lib/config");
const P = require("../lib/jsparse");

const FIX = path.join(__dirname, "fixtures");
const sample = fs.readFileSync(path.join(FIX, "sample.config.js"), "utf8");
const tricky = fs.readFileSync(path.join(FIX, "tricky.config.js"), "utf8");
const cfgPath = path.join(FIX, "config.js");

const evalCfg = (text) => C.evaluateConfig(text, cfgPath);
// Values from the config sandbox live in another realm; compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const names = (text) => plain(evalCfg(text).modules.map((m) => m.module));

// Every edit must keep all comments of the original file.
function comments(text) {
	return (text.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) || []).filter((c) => !c.includes("http"));
}

test("lists entries of the sample config", () => {
	const list = C.listEntries(sample);
	assert.deepEqual(list.map((e) => e.module), ["alert", "updatenotification", "clock", "calendar", "compliments", "weather", "weather", "newsfeed"]);
	assert.equal(list[2].position, "top_left");
	assert.equal(list[3].header, "US Holidays");
	assert.equal(list[0].position, null);
});

test("parses the tricky config (regex, template, functions, nested braces in strings)", () => {
	const list = C.listEntries(tricky);
	assert.deepEqual(list.map((e) => e.module), ["clock", "compliments", "MMM-Example", "newsfeed"]);
	assert.equal(list[3].header, "News");
	const d = C.entryDetails(tricky, 2);
	assert.deepEqual(d.options.map((o) => o.key), ["filter", "format", "url", "apiKey", "list", "nested"]);
	assert.equal(d.options.find((o) => o.key === "apiKey").value, "${SECRET_KEY}");
	assert.equal(d.options.find((o) => o.key === "format").simple, false);
});

for (const [name, src] of [["sample", sample], ["tricky", tricky]]) {
	test(`${name}: toggle off and on again restores the exact text`, () => {
		const off = C.ops.toggle(src, { index: 1, module: C.listEntries(src)[1].module, disabled: true }).text;
		assert.equal(evalCfg(off).modules[1].disabled, true);
		assert.deepEqual(comments(off), comments(src));
		const on = C.ops.toggle(off, { index: 1, module: C.listEntries(src)[1].module, disabled: false }).text;
		assert.equal(on, src);
	});

	test(`${name}: move every entry to every place keeps the config valid`, () => {
		const list = C.listEntries(src);
		for (const e of list) {
			for (let before = 0; before <= list.length; before++) {
				const out = C.ops.move(src, { index: e.index, module: e.module, position: "middle_center", before }).text;
				const mods = evalCfg(out).modules;
				assert.equal(mods.length, list.length);
				assert.deepEqual(comments(out).sort(), comments(src).sort());
				const moved = mods.findIndex((m, k) => m.module === e.module && m.position === "middle_center" && (C.listEntries(out)[k]));
				assert.notEqual(moved, -1);
			}
		}
	});

	test(`${name}: setting, changing and resetting an option`, () => {
		const e = C.listEntries(src)[1];
		let out = C.ops.setOption(src, { index: 1, module: e.module, key: "fadeSpeed", value: 2000 }).text;
		assert.equal(evalCfg(out).modules[1].config.fadeSpeed, 2000);
		out = C.ops.setOption(out, { index: 1, module: e.module, key: "fadeSpeed", value: 500 }).text;
		assert.equal(evalCfg(out).modules[1].config.fadeSpeed, 500);
		out = C.ops.setOption(out, { index: 1, module: e.module, key: "items", code: "[\n\t{ a: 1 },\n\t{ b: /x/ }\n]" }).text;
		assert.equal(Object.prototype.toString.call(evalCfg(out).modules[1].config.items[1].b), "[object RegExp]");
		out = C.ops.resetOption(out, { index: 1, module: e.module, key: "fadeSpeed" }).text;
		out = C.ops.resetOption(out, { index: 1, module: e.module, key: "items" }).text;
		assert.equal(out, src);
	});

	test(`${name}: add, duplicate and remove entries`, () => {
		let out = C.ops.add(src, { module: "MMM-New", position: "top_center", config: { a: 1, list: ["x"] } }).text;
		assert.deepEqual(names(out).slice(-1), ["MMM-New"]);
		assert.deepEqual(plain(evalCfg(out).modules.at(-1).config), { a: 1, list: ["x"] });
		const n = C.listEntries(out).length;
		out = C.ops.duplicate(out, { index: 0, module: names(src)[0] }).text;
		assert.equal(C.listEntries(out).length, n + 1);
		out = C.ops.remove(out, { index: 1, module: names(src)[0] }).text;
		out = C.ops.remove(out, { index: n - 1, module: "MMM-New" }).text;
		assert.equal(out, src);
	});
}

test("header set and remove", () => {
	let out = C.ops.setHeader(sample, { index: 2, module: "clock", header: "Zeit" }).text;
	assert.equal(evalCfg(out).modules[2].header, "Zeit");
	out = C.ops.setHeader(out, { index: 2, module: "clock", header: "" }).text;
	assert.equal(out, sample);
});

test("stale edits are rejected", () => {
	assert.throws(() => C.ops.toggle(sample, { index: 2, module: "calendar", disabled: true }), /changed in the meantime/);
});

test("compact arrays are normalized before moving", () => {
	const src = "var config = { modules: [{ module: \"a\" }, { module: \"b\", position: \"top_left\" }, { module: \"c\" }] };\nmodule.exports = config;\n";
	const out = C.ops.move(src, { index: 2, module: "c", position: "top_left", before: 0 }).text;
	assert.deepEqual(names(out), ["c", "a", "b"]);
	assert.equal(evalCfg(out).modules[0].position, "top_left");
});

test("empty modules array: add works", () => {
	const src = "let config = {\n\tmodules: []\n};\nmodule.exports = config;\n";
	const out = C.ops.add(src, { module: "clock", position: "top_left" }).text;
	assert.deepEqual(plain(evalCfg(out).modules), [{ module: "clock", position: "top_left" }]);
});

test("validate reports syntax errors with a line number", () => {
	const broken = sample.replace("position: \"top_left\"", "position: \"top_left\" oops");
	const r = C.validate(broken, { configPath: cfgPath });
	assert.equal(r.ok, false);
	assert.match(r.errors[0], /^Line \d+:/);
});

test("validate catches missing modules and odd positions", () => {
	const r = C.validate(tricky, { configPath: cfgPath, positions: ["top_left"], moduleExists: (m) => m !== "MMM-Example" });
	assert.equal(r.ok, false);
	assert.deepEqual(r.errors, ["MMM-Example: module is not installed"]);
	assert.ok(r.warnings.some((w) => w.includes("unknown position")));
});

test("module register defaults are found", () => {
	const src = "Module.register(\"MMM-X\", {\n\tdefaults: { a: 1, b: \"x\", c: [1, 2] },\n\tstart() { this.x = 1 / 2; },\n});";
	const reg = P.findModuleRegister(src);
	assert.deepEqual(reg.props.map((p) => p.key), ["defaults", null]);
});
