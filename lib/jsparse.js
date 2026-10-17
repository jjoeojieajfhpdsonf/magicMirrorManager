"use strict";
// A small JavaScript scanner for config.js and module files.
//
// It understands just enough JavaScript to locate object and array literals together
// with their exact source ranges. That lets us change one spot of config.js (a single
// property, a single module entry) instead of regenerating the whole file, so comments,
// functions and the user's formatting survive every edit.

const { UserError } = require("./errors");

const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

function lineOf(src, pos) {
	let n = 1;
	for (let k = 0; k < pos && k < src.length; k++) if (src[k] === "\n") n++;
	return n;
}

function tokenize(src) {
	const tokens = [];

	function regexAllowed() {
		const prev = tokens[tokens.length - 1];
		if (!prev) return true;
		if (prev.t === "p") return !(prev.v === ")" || prev.v === "]" || prev.v === "}");
		if (prev.t === "id") return REGEX_KEYWORDS.has(prev.v);
		return false;
	}

	function skipString(q, pos) {
		const start = pos++;
		while (pos < src.length) {
			const c = src[pos];
			if (c === "\\") pos += 2;
			else if (c === q) return pos + 1;
			else if (c === "\n") break;
			else pos++;
		}
		throw new UserError(`Unterminated string (line ${lineOf(src, start)})`);
	}

	// Template literal including nested ${ … } expressions.
	function skipTemplate(pos) {
		const start = pos++;
		while (pos < src.length) {
			const c = src[pos];
			if (c === "\\") pos += 2;
			else if (c === "`") return pos + 1;
			else if (c === "$" && src[pos + 1] === "{") {
				pos += 2;
				let depth = 1;
				while (pos < src.length && depth > 0) {
					const t = readToken(pos, true);
					if (!t) break;
					pos = t.e;
					if (t.t === "p" && t.v === "{") depth++;
					else if (t.t === "p" && t.v === "}") depth--;
				}
			} else pos++;
		}
		throw new UserError(`Unterminated template string (line ${lineOf(src, start)})`);
	}

	function skipRegex(pos) {
		const start = pos++;
		let inClass = false;
		while (pos < src.length) {
			const c = src[pos];
			if (c === "\\") pos += 2;
			else if (c === "\n") throw new UserError(`Unterminated regular expression (line ${lineOf(src, start)})`);
			else if (inClass) {
				if (c === "]") inClass = false;
				pos++;
			} else if (c === "[") {
				inClass = true;
				pos++;
			} else if (c === "/") {
				pos++;
				break;
			} else pos++;
		}
		while (pos < src.length && /[a-z]/i.test(src[pos])) pos++;
		return pos;
	}

	// Reads the next token at pos, skipping whitespace and comments.
	// `nested` is set inside template expressions (no regex heuristics there).
	function readToken(pos, nested) {
		for (;;) {
			while (pos < src.length && /\s/.test(src[pos])) pos++;
			if (src.startsWith("//", pos)) {
				const nl = src.indexOf("\n", pos);
				pos = nl === -1 ? src.length : nl;
				continue;
			}
			if (src.startsWith("/*", pos)) {
				const end = src.indexOf("*/", pos + 2);
				if (end === -1) throw new UserError(`Unterminated comment (line ${lineOf(src, pos)})`);
				pos = end + 2;
				continue;
			}
			break;
		}
		if (pos >= src.length) return null;
		const c = src[pos];
		if (c === "\"" || c === "'") return { t: "s", s: pos, e: skipString(c, pos) };
		if (c === "`") return { t: "tpl", s: pos, e: skipTemplate(pos) };
		if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[pos + 1] || ""))) {
			let e = pos + 1;
			while (e < src.length && /[\w.]/.test(src[e])) e++;
			return { t: "n", s: pos, e };
		}
		if (/[A-Za-z_$\u0080-￿]/.test(c)) {
			let e = pos + 1;
			while (e < src.length && /[\w$\u0080-￿]/.test(src[e])) e++;
			return { t: "id", s: pos, e, v: src.slice(pos, e) };
		}
		if (c === "/" && !nested && regexAllowed()) return { t: "re", s: pos, e: skipRegex(pos) };
		return { t: "p", s: pos, e: pos + 1, v: c };
	}

	let i = 0;
	while (i < src.length) {
		const t = readToken(i, false);
		if (!t) break;
		tokens.push(t);
		i = t.e;
	}
	return tokens;
}

// Turns tokens into a tree of objects, arrays and opaque expressions.
class Parser {
	constructor(src, tokens) {
		this.src = src;
		this.tk = tokens;
	}

	isP(i, v) {
		const t = this.tk[i];
		return !!t && t.t === "p" && t.v === v;
	}

	line(i) {
		return lineOf(this.src, this.tk[i] ? this.tk[i].s : this.src.length);
	}

	value(i) {
		if (!this.tk[i]) throw new UserError("Unexpected end of file");
		if (this.isP(i, "{")) return this.object(i);
		if (this.isP(i, "[")) return this.array(i);
		return this.other(i);
	}

	// Any other expression: everything up to the next comma or closing bracket at depth 0.
	other(i) {
		const start = i;
		let depth = 0;
		while (i < this.tk.length) {
			const t = this.tk[i];
			if (t.t === "p") {
				if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
				else if (t.v === ")" || t.v === "]" || t.v === "}") {
					if (depth === 0) break;
					depth--;
				} else if ((t.v === "," || t.v === ";") && depth === 0) break;
			}
			i++;
		}
		if (i === start) throw new UserError(`Value expected (line ${this.line(i)})`);
		return { type: "expr", s: this.tk[start].s, e: this.tk[i - 1].e, next: i };
	}

	object(i) {
		const node = { type: "object", s: this.tk[i].s, props: [] };
		const open = i;
		i++;
		while (!this.isP(i, "}")) {
			if (i >= this.tk.length) throw new UserError(`Object is never closed (line ${this.line(open)})`);
			const t = this.tk[i];
			let prop;
			if ((t.t === "id" || t.t === "s" || t.t === "n") && this.isP(i + 1, ":")) {
				const raw = this.src.slice(t.s, t.e);
				const key = t.t === "s" ? unquote(raw) : raw;
				const val = this.value(i + 2);
				prop = { key, s: t.s, value: val, e: val.e };
				i = val.next;
			} else {
				// Shorthand, methods, spread, computed keys: kept as an opaque unit.
				const val = this.other(i);
				prop = { key: null, s: val.s, e: val.e, value: val };
				i = val.next;
			}
			if (this.isP(i, ",")) {
				prop.comma = this.tk[i].e;
				i++;
			} else if (!this.isP(i, "}")) {
				throw new UserError(`Missing comma (line ${this.line(i)})`);
			}
			node.props.push(prop);
		}
		node.e = this.tk[i].e;
		node.next = i + 1;
		return node;
	}

	array(i) {
		const node = { type: "array", s: this.tk[i].s, items: [] };
		const open = i;
		i++;
		while (!this.isP(i, "]")) {
			if (i >= this.tk.length) throw new UserError(`List is never closed (line ${this.line(open)})`);
			if (this.isP(i, ",")) throw new UserError(`Empty list entry, double comma? (line ${this.line(i)})`);
			const val = this.value(i);
			i = val.next;
			if (this.isP(i, ",")) {
				val.comma = this.tk[i].e;
				i++;
			} else if (!this.isP(i, "]")) {
				throw new UserError(`Missing comma (line ${this.line(i)})`);
			}
			node.items.push(val);
		}
		node.e = this.tk[i].e;
		node.next = i + 1;
		return node;
	}
}

function unquote(lit) {
	if (lit[0] === "\"") return JSON.parse(lit);
	const inner = lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, "\\\"");
	return JSON.parse(`"${inner}"`);
}

function parseValueAt(src, tokens, index) {
	return new Parser(src, tokens).value(index);
}

// Finds the configuration object in config.js ("config = { … }" or "module.exports = { … }").
function findConfigObject(src) {
	const tokens = tokenize(src);
	const p = new Parser(src, tokens);
	for (let i = 0; i < tokens.length - 2; i++) {
		const t = tokens[i];
		if (t.t === "id" && t.v === "config" && p.isP(i + 1, "=") && p.isP(i + 2, "{")) return p.object(i + 2);
	}
	for (let i = 0; i < tokens.length - 4; i++) {
		const t = tokens[i];
		if (t.t === "id" && t.v === "module" && p.isP(i + 1, ".") && tokens[i + 2].v === "exports" && p.isP(i + 3, "=") && p.isP(i + 4, "{")) {
			return p.object(i + 4);
		}
	}
	throw new UserError("No configuration object (config = { … }) found");
}

function findModulesArray(src) {
	const root = findConfigObject(src);
	const prop = root.props.find((pr) => pr.key === "modules");
	if (!prop || prop.value.type !== "array") throw new UserError("No module list (modules: [ … ]) found");
	return prop.value;
}

function getProp(obj, key) {
	return obj && obj.type === "object" ? obj.props.find((p) => p.key === key) : undefined;
}

// ---------- text editing helpers ----------

function lineStart(src, pos) {
	return src.lastIndexOf("\n", pos - 1) + 1;
}

function indentAt(src, pos) {
	return /^[ \t]*/.exec(src.slice(lineStart(src, pos), pos))[0];
}

function onlyWhitespaceBefore(src, pos) {
	return /^[ \t]*$/.test(src.slice(lineStart(src, pos), pos));
}

// End of the line if only whitespace or a comment follows pos; otherwise -1.
function restOfLineEnd(src, pos) {
	let nl = src.indexOf("\n", pos);
	if (nl === -1) nl = src.length;
	const rest = src.slice(pos, nl);
	if (/^[ \t]*(\/\/.*)?$/.test(rest) || /^[ \t]*\/\*.*\*\/[ \t]*$/.test(rest)) return nl;
	return -1;
}

// Start of the "//" comment lines directly above line start ls (they belong to the entry).
function commentBlockStart(src, ls) {
	let s = ls;
	while (s > 0) {
		const prevLs = lineStart(src, s - 1);
		if (/^[ \t]*\/\//.test(src.slice(prevLs, s - 1))) s = prevLs;
		else break;
	}
	return s;
}

function detectIndentUnit(src) {
	let tabs = 0;
	let spaces = 0;
	const widths = {};
	for (const l of src.split("\n")) {
		if (l.startsWith("\t")) tabs++;
		else {
			const m = /^( +)\S/.exec(l);
			if (m) {
				spaces++;
				widths[m[1].length] = (widths[m[1].length] || 0) + 1;
			}
		}
	}
	if (tabs >= spaces) return "\t";
	const sizes = Object.keys(widths).map(Number);
	return " ".repeat(sizes.includes(2) ? 2 : sizes.includes(4) ? 4 : Math.min(...sizes) || 2);
}

// Indents every line but the first.
function reindent(text, indent) {
	return text.split("\n").map((l, k) => (k === 0 || l.trim() === "" ? l : indent + l)).join("\n");
}

// Removes the common indentation of all lines but the first (for displaying a value).
function dedent(text) {
	const lines = text.split("\n");
	if (lines.length < 2) return text;
	let cut = Infinity;
	for (const l of lines.slice(1)) if (l.trim()) cut = Math.min(cut, /^[ \t]*/.exec(l)[0].length);
	if (!isFinite(cut)) return text;
	return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)[0].length)))].join("\n");
}

// Sets or replaces a property of an object literal.
// opts.after: name of the property after which a new one is inserted.
function setProperty(src, obj, key, valueText, opts = {}) {
	const existing = getProp(obj, key);
	if (existing) return src.slice(0, existing.value.s) + reindent(valueText, indentAt(src, existing.s)) + src.slice(existing.value.e);

	const keyText = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
	const unit = detectIndentUnit(src);

	if (obj.props.length === 0) {
		const outer = indentAt(src, obj.s);
		const inner = outer + unit;
		return src.slice(0, obj.s) + `{\n${inner}${keyText}: ${reindent(valueText, inner)}\n${outer}}` + src.slice(obj.e);
	}

	let anchorIdx = obj.props.length - 1;
	if (opts.after) {
		const k = obj.props.findIndex((p) => p.key === opts.after);
		if (k !== -1) anchorIdx = k;
	}
	const anchor = obj.props[anchorIdx];
	const isLast = anchorIdx === obj.props.length - 1;
	// The new property gets a comma if something follows or the file uses trailing commas.
	const trailing = !isLast || anchor.comma ? "," : "";

	if (onlyWhitespaceBefore(src, anchor.s)) {
		const eol = restOfLineEnd(src, anchor.comma || anchor.e);
		if (eol !== -1) {
			const indent = indentAt(src, anchor.s);
			const head = anchor.comma ? src.slice(0, eol) : src.slice(0, anchor.e) + "," + src.slice(anchor.e, eol);
			return head + "\n" + indent + `${keyText}: ${reindent(valueText, indent)}` + trailing + src.slice(eol);
		}
	}
	// Compact style ({ a: 1, b: 2 }): insert right after the anchor.
	const newProp = `${keyText}: ${valueText}`;
	if (anchor.comma) return src.slice(0, anchor.comma) + ` ${newProp},` + src.slice(anchor.comma);
	return src.slice(0, anchor.e) + `, ${newProp}` + src.slice(anchor.e);
}

// Source range to delete when removing an entry (property or array item).
function removalRange(src, item, prev) {
	const end = item.comma || item.e;
	if (onlyWhitespaceBefore(src, item.s)) {
		const eol = restOfLineEnd(src, end);
		if (eol !== -1) return [commentBlockStart(src, lineStart(src, item.s)), eol < src.length ? eol + 1 : eol];
	}
	if (item.comma) {
		let e = item.comma;
		while (src[e] === " " || src[e] === "\t") e++;
		return [item.s, e];
	}
	// Last entry without a comma on a shared line: take the preceding comma along.
	if (prev && prev.comma) return [prev.comma - 1, item.e];
	return [item.s, item.e];
}

// Removes one entry of a list of properties/items. If the removed entry was the last one and
// had no trailing comma, the comma of the new last entry goes too (keeps the file's style).
function removeEntry(src, list, idx) {
	const item = list[idx];
	const prev = list[idx - 1];
	const [s, e] = removalRange(src, item, prev);
	if (idx === list.length - 1 && !item.comma && prev && prev.comma && prev.comma <= s) {
		return src.slice(0, prev.comma - 1) + src.slice(prev.comma, s) + src.slice(e);
	}
	return src.slice(0, s) + src.slice(e);
}

function removeProperty(src, obj, key) {
	const idx = obj.props.findIndex((p) => p.key === key);
	return idx === -1 ? src : removeEntry(src, obj.props, idx);
}

function removeItem(src, arr, idx) {
	return removeEntry(src, arr.items, idx);
}

function itemsOnOwnLines(src, arr) {
	return arr.items.every((it) => onlyWhitespaceBefore(src, it.s) && restOfLineEnd(src, it.comma || it.e) !== -1);
}

// Puts every item of a compact array on its own line.
function normalizeArray(src, arr) {
	const outer = indentAt(src, arr.s);
	const inner = outer + detectIndentUnit(src);
	const parts = arr.items.map((it) => inner + src.slice(it.s, it.e) + ",");
	return src.slice(0, arr.s) + "[\n" + parts.join("\n") + "\n" + outer + "]" + src.slice(arr.e);
}

function reparseAt(src, pos) {
	const tokens = tokenize(src);
	return parseValueAt(src, tokens, tokens.findIndex((t) => t.s === pos));
}

function ensureOwnLines(src, arr) {
	if (arr.items.length === 0 || itemsOnOwnLines(src, arr)) return [src, arr];
	const out = normalizeArray(src, arr);
	return [out, reparseAt(out, arr.s)];
}

// Inserts item text (without trailing comma) before item idx (idx = items.length: at the end).
function insertItem(src, arr, idx, itemText) {
	if (arr.items.length === 0) {
		const outer = indentAt(src, arr.s);
		const inner = outer + detectIndentUnit(src);
		return src.slice(0, arr.s) + `[\n${inner}${reindent(itemText, inner)},\n${outer}]` + src.slice(arr.e);
	}
	[src, arr] = ensureOwnLines(src, arr);
	if (idx < arr.items.length) {
		const target = arr.items[idx];
		const ls = commentBlockStart(src, lineStart(src, target.s));
		const indent = indentAt(src, target.s);
		return src.slice(0, ls) + indent + reindent(itemText, indent) + ",\n" + src.slice(ls);
	}
	const last = arr.items[arr.items.length - 1];
	const indent = indentAt(src, last.s);
	const eol = restOfLineEnd(src, last.comma || last.e);
	const head = last.comma ? src.slice(0, eol) : src.slice(0, last.e) + "," + src.slice(last.e, eol);
	return head + "\n" + indent + reindent(itemText, indent) + (last.comma ? "," : "") + src.slice(eol);
}

// Moves item `from` (with the comment lines above it) before item `before`, or to the end if before is null.
function moveItem(src, arr, from, before) {
	if (from === before) return src;
	[src, arr] = ensureOwnLines(src, arr);
	const last = arr.items[arr.items.length - 1];
	if (!last.comma) {
		// Give the last item a comma first so every item can move freely.
		src = src.slice(0, last.e) + "," + src.slice(last.e);
		arr = reparseAt(src, arr.s);
	}
	const it = arr.items[from];
	const chunkStart = commentBlockStart(src, lineStart(src, it.s));
	const eol = restOfLineEnd(src, it.comma);
	const chunkEnd = eol < src.length ? eol + 1 : eol;
	const chunk = src.slice(chunkStart, chunkEnd);

	let insertAt;
	if (before === null || before >= arr.items.length) {
		const lastItem = arr.items[arr.items.length - 1];
		if (lastItem === it) return src;
		insertAt = restOfLineEnd(src, lastItem.comma) + 1;
	} else {
		insertAt = commentBlockStart(src, lineStart(src, arr.items[before].s));
	}
	if (insertAt > chunkStart) return src.slice(0, chunkStart) + src.slice(chunkEnd, insertAt) + chunk + src.slice(insertAt);
	return src.slice(0, insertAt) + chunk + src.slice(insertAt, chunkStart) + src.slice(chunkEnd);
}

// Finds Module.register("name", { … }) in a module file and returns the object node.
function findModuleRegister(src) {
	const tokens = tokenize(src);
	const p = new Parser(src, tokens);
	for (let i = 0; i < tokens.length - 4; i++) {
		const t = tokens[i];
		if (t.t === "id" && t.v === "Module" && p.isP(i + 1, ".") && tokens[i + 2].v === "register" && p.isP(i + 3, "(")) {
			const first = p.value(i + 4);
			if (p.isP(first.next, ",") && p.isP(first.next + 1, "{")) return p.object(first.next + 1);
			return null;
		}
	}
	return null;
}

module.exports = {
	tokenize,
	lineOf,
	findConfigObject,
	findModulesArray,
	findModuleRegister,
	parseValueAt,
	getProp,
	setProperty,
	removeProperty,
	removeItem,
	insertItem,
	moveItem,
	detectIndentUnit,
	indentAt,
	reindent,
	dedent
};
