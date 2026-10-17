"use strict";
// Reading, validating and surgically editing MagicMirror's config.js.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const util = require("node:util");
const { createRequire } = require("node:module");
const P = require("./jsparse");
const { toJS, evalExpression, toPlain, isData } = require("./jsvalue");
const { UserError } = require("./errors");
const { inWindow, validMD } = require("./seasons");

// ---------- environment variables, the way MagicMirror resolves them ----------

function readEnvFile(configPath) {
	const envFile = configPath.replace(/\.[^.]+$/, "") + ".env";
	try {
		return util.parseEnv(fs.readFileSync(envFile, "utf8"));
	} catch {
		return {};
	}
}

function substituteEnv(text, env) {
	let out = text;
	for (const [k, v] of Object.entries(env)) out = out.replaceAll(`\${${k}}`, v);
	return out;
}

// Evaluates config.js like MagicMirror does (CommonJS, ${VAR} substitution).
// With redactSecrets, SECRET_* variables become "**SECRET_X**" like in MagicMirror's browser copy.
function evaluateConfig(text, configPath, { redactSecrets = false } = {}) {
	const env = { ...process.env, ...readEnvFile(configPath) };
	if (redactSecrets) for (const k of Object.keys(env)) if (k.startsWith("SECRET_")) env[k] = `**${k}**`;
	const code = substituteEnv(text, env);
	const mod = { exports: {} };
	const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
	const sandbox = {
		module: mod,
		exports: mod.exports,
		require: createRequire(configPath),
		process,
		console: quiet,
		__filename: configPath,
		__dirname: path.dirname(configPath)
	};
	try {
		vm.runInNewContext(code, sandbox, { filename: configPath, timeout: 3000 });
	} catch (err) {
		const m = new RegExp(`${escapeRe(configPath)}:(\\d+)`).exec(String(err && err.stack));
		throw new UserError(`${m ? `Line ${m[1]}: ` : ""}${err && err.message ? err.message : String(err)}`);
	}
	const cfg = mod.exports;
	if (!cfg || typeof cfg !== "object" || Object.keys(cfg).length === 0) throw new UserError("The configuration is empty. Is the module.exports line at the end missing?");
	return cfg;
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- module entries ----------

function safeEval(text) {
	try {
		return evalExpression(text);
	} catch {
		return undefined;
	}
}

function field(src, obj, key) {
	const p = P.getProp(obj, key);
	return p ? safeEval(src.slice(p.value.s, p.value.e)) : undefined;
}

// All module entries with their key fields.
function listEntries(src) {
	return P.findModulesArray(src).items.map((it, index) => {
		if (it.type !== "object") return { index, module: null, invalid: true, line: P.lineOf(src, it.s) };
		const module = field(src, it, "module");
		const cfg = P.getProp(it, "config");
		return {
			index,
			module: typeof module === "string" ? module : null,
			position: field(src, it, "position") || null,
			header: field(src, it, "header") || null,
			disabled: field(src, it, "disabled") === true,
			hasConfig: !!(cfg && (cfg.value.type !== "object" || cfg.value.props.length > 0)),
			schedule: scheduleOf(src, it),
			line: P.lineOf(src, it.s)
		};
	});
}

// The date window of an entry: showBetween: ["MM-DD", "MM-DD"] (ignored by MagicMirror itself).
function scheduleOf(src, node) {
	const v = field(src, node, "showBetween");
	return Array.isArray(v) && v.length === 2 && validMD(v[0]) && validMD(v[1]) ? [v[0], v[1]] : null;
}

// Returns the entry node; `expectName` guards against edits based on a stale view.
function entryNode(src, index, expectName) {
	const arr = P.findModulesArray(src);
	const node = arr.items[index];
	if (!node || node.type !== "object") throw new UserError("Module entry not found");
	if (expectName !== undefined && field(src, node, "module") !== expectName) throw new UserError("The configuration has changed in the meantime. Please reload.");
	return { arr, node };
}

// Everything the settings screen needs about one entry.
function entryDetails(src, index) {
	const { node } = entryNode(src, index);
	const cfg = P.getProp(node, "config");
	const options = [];
	let configIsCode = false;
	if (cfg && cfg.value.type === "object") {
		for (const p of cfg.value.props) {
			if (p.key === null) {
				configIsCode = true;
				continue;
			}
			const code = src.slice(p.value.s, p.value.e);
			let value;
			let ok = true;
			try {
				value = evalExpression(code);
			} catch {
				ok = false;
			}
			const simple = ok && ["boolean", "number", "string"].includes(typeof value);
			options.push({ key: p.key, code: P.dedent(code), value: simple ? value : ok ? toPlain(value) : null, simple, data: ok && isData(value) });
		}
	} else if (cfg) configIsCode = true;
	return {
		index,
		module: field(src, node, "module"),
		header: field(src, node, "header") || "",
		position: field(src, node, "position") || null,
		disabled: field(src, node, "disabled") === true,
		schedule: scheduleOf(src, node),
		options,
		configIsCode,
		entryText: P.dedent(src.slice(node.s, node.e))
	};
}

// ---------- edits: each returns { text, change } ----------

const ops = {
	toggle(src, { index, module, disabled }) {
		const { node } = entryNode(src, index, module);
		const text = disabled ? P.setProperty(src, node, "disabled", "true", { after: "module" }) : P.removeProperty(src, node, "disabled");
		return { text, change: { k: disabled ? "chg.off" : "chg.on", p: { m: module } } };
	},

	setHeader(src, { index, module, header }) {
		const { node } = entryNode(src, index, module);
		const h = String(header || "").trim();
		const text = h ? P.setProperty(src, node, "header", JSON.stringify(h), { after: "position" }) : P.removeProperty(src, node, "header");
		return { text, change: { k: h ? "chg.header" : "chg.headerRemoved", p: { m: module, h } } };
	},

	// Moves an entry into a region, before entry `before` (array index) or to the end of the region.
	move(src, { index, module, position, before }) {
		const { node } = entryNode(src, index, module);
		const oldPos = field(src, node, "position") || null;
		const pos = position || null;
		const entries = listEntries(src);
		const count = entries.length;
		let t = null;
		if (before !== null && before !== undefined) {
			t = Number(before);
			if (!(Number.isInteger(t) && t >= 0 && t <= count)) throw new UserError("Invalid target position");
		} else {
			const others = entries.filter((e) => e.position === pos && e.index !== index);
			if (others.length) t = others[others.length - 1].index + 1;
		}
		let text = src;
		let newIndex = index;
		if (t !== null && t !== index && t !== index + 1) {
			text = P.moveItem(text, P.findModulesArray(text), index, t >= count ? null : t);
			newIndex = t > index ? t - 1 : t;
		}
		if (pos !== oldPos) {
			const n = P.findModulesArray(text).items[newIndex];
			text = pos ? P.setProperty(text, n, "position", JSON.stringify(pos), { after: "module" }) : P.removeProperty(text, n, "position");
		}
		if (text === src) return { text, change: null, index };
		return { text, index: newIndex, change: pos !== oldPos ? { k: "chg.move", p: { m: module, pos } } : { k: "chg.reorder", p: { m: module } } };
	},

	remove(src, { index, module }) {
		const { arr } = entryNode(src, index, module);
		return { text: P.removeItem(src, arr, index), change: { k: "chg.remove", p: { m: module } } };
	},

	add(src, { module, position, config }) {
		if (typeof module !== "string" || !/^[\w.-]+(\/[\w.-]+)?$/.test(module)) throw new UserError("Invalid module name");
		const obj = { module };
		if (position) obj.position = position;
		if (config && typeof config === "object" && Object.keys(config).length) obj.config = config;
		const arr = P.findModulesArray(src);
		const text = P.insertItem(src, arr, arr.items.length, toJS(obj, P.detectIndentUnit(src)));
		return { text, change: { k: "chg.add", p: { m: module, pos: position || null } } };
	},

	duplicate(src, { index, module }) {
		const { arr, node } = entryNode(src, index, module);
		const text = P.insertItem(src, arr, index + 1, P.dedent(src.slice(node.s, node.e)));
		return { text, change: { k: "chg.duplicate", p: { m: module } } };
	},

	// Sets one option: either a JSON value (`value`) or JavaScript source (`code`).
	setOption(src, { index, module, key, value, code }) {
		if (typeof key !== "string" || !/^[A-Za-z_$][\w$]*$/.test(key)) throw new UserError("Invalid option name");
		const { node } = entryNode(src, index, module);
		let valueText;
		if (code !== undefined) {
			valueText = String(code).trim();
			try {
				evalExpression(valueText);
			} catch (err) {
				throw new UserError(`"${key}" is not a valid value: ${err.message}`);
			}
		} else {
			valueText = toJS(value, P.detectIndentUnit(src));
		}
		let text = src;
		if (!P.getProp(node, "config")) text = P.setProperty(text, node, "config", "{}");
		const cfg = P.getProp(entryNode(text, index).node, "config");
		if (cfg.value.type !== "object") throw new UserError("This module's config is not a plain object. Please edit it as code.");
		text = P.setProperty(text, cfg.value, key, valueText);
		return { text, change: { k: "chg.option", p: { m: module, key } } };
	},

	resetOption(src, { index, module, key }) {
		const { node } = entryNode(src, index, module);
		const cfg = P.getProp(node, "config");
		if (!cfg || cfg.value.type !== "object" || !P.getProp(cfg.value, key)) return { text: src, change: null };
		let text = P.removeProperty(src, cfg.value, key);
		const n2 = entryNode(text, index).node;
		const cfg2 = P.getProp(n2, "config");
		if (cfg2.value.type === "object" && cfg2.value.props.length === 0) text = P.removeProperty(text, n2, "config");
		return { text, change: { k: "chg.optionReset", p: { m: module, key } } };
	},

	// Show the module only between two dates every year; switches it on/off for today right away.
	setSchedule(src, { index, module, from, until }) {
		if (!validMD(from) || !validMD(until)) throw new UserError("Invalid date (expected MM-DD)");
		const { node } = entryNode(src, index, module);
		let text = P.setProperty(src, node, "showBetween", toJS([from, until]), { after: "position" });
		const n2 = entryNode(text, index).node;
		text = inWindow(new Date(), from, until) ? P.removeProperty(text, n2, "disabled") : P.setProperty(text, n2, "disabled", "true", { after: "module" });
		return { text, change: { k: "chg.schedule", p: { m: module, from, until } } };
	},

	clearSchedule(src, { index, module }) {
		const { node } = entryNode(src, index, module);
		return { text: P.removeProperty(src, node, "showBetween"), change: { k: "chg.scheduleOff", p: { m: module } } };
	},

	// Replaces a whole entry with source text.
	setEntryText(src, { index, module, text: entryText }) {
		const { node } = entryNode(src, index, module);
		const t = String(entryText || "").trim();
		let val;
		try {
			val = evalExpression(t);
		} catch (err) {
			throw new UserError(`Not a valid entry: ${err.message}`);
		}
		if (!val || typeof val !== "object" || typeof val.module !== "string") throw new UserError("The entry needs at least \"module\".");
		const text = src.slice(0, node.s) + P.reindent(t, P.indentAt(src, node.s)) + src.slice(node.e);
		return { text, change: { k: "chg.code", p: { m: val.module } } };
	}
};

// ---------- validation ----------

// Thorough check of a config text. ctx: { configPath, positions, moduleExists(name) }.
// Returns { ok, errors: [string], warnings: [string], config }.
function validate(text, ctx) {
	const errors = [];
	const warnings = [];
	const done = () => ({ ok: errors.length === 0, errors, warnings });
	let cfg;
	try {
		P.findModulesArray(text);
		cfg = evaluateConfig(text, ctx.configPath);
	} catch (e) {
		errors.push(e.message);
		return done();
	}
	if (!Array.isArray(cfg.modules)) {
		errors.push("\"modules\" must be a list");
		return done();
	}
	cfg.modules.forEach((m, i) => {
		if (!m || typeof m !== "object" || Array.isArray(m)) return errors.push(`Entry ${i + 1} is not an object`);
		if (typeof m.module !== "string") return errors.push(`Entry ${i + 1} has no "module" name`);
		if (m.position !== undefined && typeof m.position !== "string") errors.push(`${m.module}: position must be a string`);
		else if (m.position && ctx.positions && !ctx.positions.includes(m.position)) warnings.push(`${m.module}: unknown position "${m.position}", the module will not be shown`);
		if (m.disabled) return;
		if (ctx.moduleExists && !ctx.moduleExists(m.module)) errors.push(`${m.module}: module is not installed`);
		if (m.config !== undefined && (typeof m.config !== "object" || m.config === null)) errors.push(`${m.module}: "config" must be an object`);
	});
	return { ...done(), config: cfg };
}

module.exports = { evaluateConfig, listEntries, entryDetails, ops, validate, readEnvFile };
