"use strict";
// Values <-> JavaScript source text.
const vm = require("node:vm");

const IDENT = /^[A-Za-z_$][\w$]*$/;

// Serializes a JSON-like value as a JavaScript literal in the style of the MagicMirror sample config.
function toJS(value, unit = "\t", indent = "") {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const inner = indent + unit;
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const parts = value.map((v) => toJS(v, unit, inner));
		const flat = `[${parts.join(", ")}]`;
		if (value.every((v) => v === null || typeof v !== "object") && flat.length <= 60) return flat;
		return `[\n${parts.map((p) => inner + p).join(",\n")}\n${indent}]`;
	}
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		const parts = keys.map((k) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${toJS(value[k], unit, inner)}`);
		return `{\n${parts.map((p) => inner + p).join(",\n")}\n${indent}}`;
	}
	throw new TypeError(`cannot serialize a value of type ${typeof value}`);
}

// Evaluates a single expression in an isolated context.
function evalExpression(text, globals = {}) {
	const sandbox = { ...globals };
	return vm.runInNewContext(`(${text}\n)`, sandbox, { timeout: 500, filename: "value.js" });
}

// Makes a value JSON-safe for the web app (functions, RegExps etc. become null).
function toPlain(value, depth = 0) {
	if (depth > 8) return null;
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((v) => toPlain(v, depth + 1));
	if (typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]") {
		const o = {};
		for (const k of Object.keys(value)) o[k] = toPlain(value[k], depth + 1);
		return o;
	}
	return null;
}

// True for values that are plain data (strings, finite numbers, booleans, null, arrays,
// plain objects). Those can be edited with a form; functions or regular expressions can't.
function isData(value, depth = 0) {
	if (depth > 10) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((v) => isData(v, depth + 1));
	if (typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]") return Object.values(value).every((v) => isData(v, depth + 1));
	return false;
}

function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => deepEqual(a[k], b[k]));
}

module.exports = { toJS, evalExpression, toPlain, deepEqual, isData };
