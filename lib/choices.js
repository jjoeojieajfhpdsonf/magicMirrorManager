"use strict";
// Guesses the allowed values of a text option from how the module's code uses it:
//   this.config.theme === "winter"        switch (this.config.mode) { case "a": … }
//   ["a", "b"].includes(this.config.x)     this.themes[this.config.theme]  (keys of themes)
// Modules don't declare their choices anywhere, so this is a best effort for a dropdown.
const P = require("./jsparse");

const STR = /(["'`])((?:(?!\1)[^\\\n]){1,40})\1/;

function findChoices(src, key) {
	const k = key.replace(/[$]/g, "\\$");
	const ref = `(?:this\\.)?config\\.${k}\\b`;
	const found = new Set();
	let m;

	// comparisons, both directions
	const cmp1 = new RegExp(`${ref}\\s*[!=]==?\\s*${STR.source}`, "g");
	while ((m = cmp1.exec(src))) found.add(m[2]);
	const cmp2 = new RegExp(`${STR.source}\\s*[!=]==?\\s*${ref}`, "g");
	while ((m = cmp2.exec(src))) found.add(m[2]);

	// switch (config.key) { case "x": … }
	const sw = new RegExp(`switch\\s*\\(\\s*${ref}\\s*\\)\\s*\\{`, "g");
	while ((m = sw.exec(src))) {
		const body = blockAfter(src, m.index + m[0].length - 1);
		for (const c of body.matchAll(new RegExp(`case\\s+${STR.source}\\s*:`, "g"))) found.add(c[2]);
	}

	// ["a", "b"].includes(config.key) / .indexOf(config.key)
	const inc = new RegExp(`\\[([^\\[\\]]{1,400})\\]\\s*\\.\\s*(?:includes|indexOf)\\(\\s*${ref}\\s*\\)`, "g");
	while ((m = inc.exec(src))) for (const s of m[1].matchAll(new RegExp(STR.source, "g"))) found.add(s[2]);

	// lookup tables: something[config.key] -> keys of "something: { … }" / "something = { … }"
	const look = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\[\\s*${ref}\\s*\\]`, "g");
	const tables = new Set();
	while ((m = look.exec(src))) tables.add(m[1]);
	if (tables.size) {
		let tokens = null;
		for (const name of tables) {
			if (name === "config") continue;
			const def = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\s*[:=]\\s*\\{`, "g");
			while ((m = def.exec(src))) {
				try {
					tokens = tokens || P.tokenize(src);
					const pos = m.index + m[0].length - 1;
					const i = tokens.findIndex((t) => t.s === pos);
					if (i === -1) continue;
					const obj = P.parseValueAt(src, tokens, i);
					for (const p of obj.props) if (p.key) found.add(p.key);
				} catch {
					// not a plain object literal
				}
			}
		}
	}
	// "typeof this.config.x === 'string'" is a type check, not a choice
	for (const t of ["string", "number", "boolean", "object", "undefined", "function", "bigint", "symbol"]) found.delete(t);
	return [...found];
}

// Text of the { … } block starting at index `open` (strings and comments are not special-cased;
// good enough for switch bodies).
function blockAfter(src, open) {
	let depth = 0;
	for (let i = open; i < src.length && i < open + 20000; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open, i);
	}
	return src.slice(open, open + 20000);
}

module.exports = { findChoices };
