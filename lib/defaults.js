"use strict";
// Reads the default options of a module straight from its source:
// Module.register("MMM-Foo", { defaults: { … } }).
const fs = require("node:fs");
const path = require("node:path");
const { findChoices } = require("./choices");
const P = require("./jsparse");
const { evalExpression, toPlain, isData } = require("./jsvalue");

// Globals some modules use inside their defaults (e.g. config.language).
const GLOBALS = {
	config: { language: "en", locale: "en-US", timeFormat: 24, units: "metric" },
	moment: undefined,
	window: {},
	document: undefined
};

function readDefaults(mainFile) {
	let src;
	try {
		src = fs.readFileSync(mainFile, "utf8");
	} catch {
		return null;
	}
	let reg;
	try {
		reg = P.findModuleRegister(src);
	} catch {
		return null;
	}
	if (!reg) return null;
	const prop = P.getProp(reg, "defaults");
	if (!prop || prop.value.type !== "object") return null;
	const out = [];
	for (const p of prop.value.props) {
		if (p.key === null) continue;
		const code = P.dedent(src.slice(p.value.s, p.value.e));
		let value;
		let ok = true;
		try {
			value = evalExpression(code, GLOBALS);
		} catch {
			ok = false;
		}
		const simple = ok && ["boolean", "number", "string"].includes(typeof value);
		out.push({ key: p.key, code, value: simple ? value : ok ? toPlain(value) : null, simple, data: ok && isData(value), dynamic: !ok });
	}
	// text options: offer the values the module's code checks for as a dropdown
	let all = src;
	try {
		all += "\n" + fs.readFileSync(path.join(path.dirname(mainFile), "node_helper.js"), "utf8");
	} catch {
		// no node_helper
	}
	for (const o of out) {
		if (typeof o.value !== "string") continue;
		const choices = new Set(findChoices(all, o.key));
		if (choices.size === 0) continue;
		choices.add(o.value);
		if (choices.size >= 2) o.choices = [...choices];
	}
	return out;
}

module.exports = { readDefaults };
