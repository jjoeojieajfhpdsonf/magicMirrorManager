/* Settings described by the module itself (mm-manager.json in the module folder).
   See docs/module-schema.md. Without such a file the generic editor is used. */
"use strict";

// label in the current language: "text" or { de: "…", en: "…" }
function L(v) {
	if (v === null || v === undefined) return "";
	if (typeof v !== "object") return String(v);
	return v[LANG] || v.en || v.de || Object.values(v)[0] || "";
}

// which sub-sections are open (kept across redraws)
const schemaOpen = new Set();

// The settings section for a module with a schema.
// values: current value per key (or the default); save(key, value) stores a value.
function schemaSettings(schema, valueOf, isSet, save, reset) {
	const wrap = h("div");
	const fields = schema.fields.filter((f) => !f.hidden);
	const row = (f) => schemaField(f, valueOf(f.key), (v) => save(f.key, v), isSet(f.key) ? () => reset(f.key) : null);
	wrap.append(h("div", { class: "section-title" }, t("entry.settings")));
	const main = fields.filter((f) => !f.advanced);
	const groups = [];
	let plain = [];
	for (const f of main) {
		// maps and lists get a card of their own
		if (f.type === "map" || f.type === "list") {
			if (plain.length) groups.push(h("div", { class: "card" }, plain.map(row)));
			plain = [];
			groups.push(h("div", { class: "section-sub" }, L(f.label)), f.help ? h("div", { class: "section-help" }, L(f.help)) : null, row(f));
		} else plain.push(f);
	}
	if (plain.length) groups.push(h("div", { class: "card" }, plain.map(row)));
	wrap.append(...groups.filter(Boolean));
	const adv = fields.filter((f) => f.advanced);
	if (adv.length) {
		const key = "advanced";
		const list = h("div", { class: "card", style: "margin-top:8px", hidden: !schemaOpen.has(key) }, adv.map(row));
		const toggle = h("button", { class: `row more-toggle${schemaOpen.has(key) ? " open" : ""}`, onclick: () => {
			if (schemaOpen.has(key)) schemaOpen.delete(key);
			else schemaOpen.add(key);
			list.hidden = !schemaOpen.has(key);
			toggle.classList.toggle("open", schemaOpen.has(key));
		} }, h("span", { class: "grow" }, t("schema.advanced")), h("span", { class: "chev", html: ICONS.chev }));
		wrap.append(h("div", { class: "card", style: "margin-top:16px" }, toggle), list);
	}
	return wrap;
}

// One setting. onReset is set when the value was changed (or can be cleared).
function schemaField(f, value, onChange, onReset) {
	if (f.type === "map") return mapField(f, value || {}, onChange);
	if (f.type === "list") return listField(f, Array.isArray(value) ? value : [], onChange);
	const wide = ["tags", "colors", "text", "hours"].includes(f.type);
	// in a row the help goes on its own line below, so it doesn't squeeze the label next to the control
	const help = f.help ? h("div", { class: wide ? "d" : "help-line" }, L(f.help)) : null;
	const label = h("div", { class: "label" }, h("div", { class: "k" }, L(f.label) || f.key), wide ? help : null);
	const reset = onReset ? h("button", { class: "reset", title: t("entry.reset"), "aria-label": t("entry.reset"), onclick: onReset }, icon("undo")) : null;
	const control = schemaControl(f, value, onChange);
	return h("div", { class: `field described${onReset ? " changed" : ""}${wide ? " col" : ""}` }, wide ? [h("div", { class: "top-line" }, label, reset), control] : [label, reset, control, help]);
}

function schemaControl(f, value, onChange) {
	switch (f.type) {
		case "toggle":
			return h("label", { class: "switch" }, h("input", { type: "checkbox", checked: !!value, onchange: (e) => onChange(e.target.checked) }), h("span"));
		case "select": {
			const choices = f.choices || [];
			const key = (v) => (v === null || v === undefined ? "" : String(v));
			const sel = h(
				"select",
				{ class: "input select", onchange: (e) => onChange(choices.find((c) => key(c.value) === e.target.value).value) },
				choices.map((c) => h("option", { value: key(c.value), selected: key(c.value) === key(value) }, L(c.label) || key(c.value) || "–"))
			);
			return sel;
		}
		case "number":
		case "range": {
			const out = h("span", { class: "range-value" }, String(value ?? ""));
			const input = h("input", {
				class: f.type === "range" ? "range" : "input num",
				type: f.type === "range" ? "range" : "text",
				inputmode: "decimal",
				min: f.min,
				max: f.max,
				step: f.step || "any",
				value: String(value ?? ""),
				placeholder: f.type === "number" ? L(f.placeholder) || t("schema.default") : null,
				oninput: (e) => (out.textContent = e.target.value),
				onchange: (e) => {
					if (String(e.target.value).trim() === "") return onChange(null);
					const n = Number(String(e.target.value).replace(",", "."));
					if (!Number.isFinite(n)) return;
					onChange(Math.min(f.max ?? n, Math.max(f.min ?? n, n)));
				}
			});
			return f.type === "range" ? h("div", { class: "range-wrap" }, input, out) : input;
		}
		case "date": // "MM-DD", every year; null = the module's own rule
			return yearlyDate(value, onChange, f.placeholder);
		case "fulldate": {
			return h("input", { class: "input", type: "date", value: value || "", onchange: (e) => onChange(e.target.value || null) });
		}
		case "hours": // ["17:00", "23:00"]; empty = all day
			return hoursRange(value, onChange);
		case "tags":
			return tagEditor(Array.isArray(value) ? value : [], onChange, false);
		case "colors":
			return colorList(Array.isArray(value) ? value : [], onChange);
		default:
			return h("input", { class: "input text", value: value ?? "", placeholder: L(f.placeholder), onchange: (e) => onChange(e.target.value === "" && f.nullable ? null : e.target.value) });
	}
}

// A yearly date. Empty means "as the module defines it" (e.g. Easter is calculated).
function yearlyDate(value, onChange, placeholder) {
	if (typeof value !== "string" || !/^\d{2}-\d{2}$/.test(value)) {
		const own = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
		return h("button", { class: "value-sum", onclick: () => onChange(todayMD()) }, own ? value : L(placeholder) || t("schema.default"));
	}
	return dateSelect(value, onChange);
}

function hoursRange(value, onChange) {
	if (!Array.isArray(value) || value.length !== 2) {
		return h("button", { class: "value-sum", onclick: () => onChange(["18:00", "23:00"]) }, t("schema.allDay"));
	}
	const [a, b] = value;
	const time = (v, other) => h("input", { class: "input time", type: "time", value: v, onchange: (e) => e.target.value && onChange(other(e.target.value)) });
	return h("div", { class: "date-select" }, time(a, (v) => [v, b]), h("span", { class: "dash" }, "–"), time(b === "24:00" ? "23:59" : b, (v) => [a, v]));
}

function todayMD() {
	const d = new Date();
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function colorList(list, onChange) {
	return h(
		"div",
		{ class: "tags" },
		list.map((c, i) =>
			h("span", { class: "tag color-tag" },
				h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(c) ? c : "#ffffff", onchange: (e) => onChange(list.map((x, k) => (k === i ? e.target.value : x))) }),
				h("button", { "aria-label": t("form.remove"), onclick: () => onChange(list.filter((x, k) => k !== i)) }, "×"))
		),
		h("button", { class: "btn ghost form-add", onclick: () => onChange([...list, "#ffffff"]) }, icon("plus"))
	);
}

// { id: overrides } – one row per known key with a switch; tap to change details.
function mapField(f, obj, onChange) {
	const box = h("div", { class: "card" });
	for (const k of f.keys || []) {
		const ov = obj[k.value];
		const on = ov !== false && !(ov && ov.enabled === false);
		const details = ov && typeof ov === "object" ? ov : {};
		const openKey = `${f.key}.${k.value}`;
		const set = (patch) => {
			const next = { ...obj };
			const o = { ...details, ...patch };
			for (const key of Object.keys(o)) if (o[key] === null || o[key] === undefined || o[key] === "") delete o[key];
			if (o.enabled === true) delete o.enabled;
			if (o.enabled === false && Object.keys(o).length === 1) next[k.value] = false;
			else if (Object.keys(o).length) next[k.value] = o;
			else delete next[k.value];
			onChange(next);
		};
		const defaults = k.defaults || {};
		const defOf = (x) => (defaults[x.key] !== undefined ? defaults[x.key] : x.default);
		const changed = Object.keys(details).some((x) => x !== "enabled");
		const head = h(
			"div",
			{ class: "map-row" },
			h("button", { class: "map-open", onclick: () => {
				if (schemaOpen.has(openKey)) schemaOpen.delete(openKey);
				else schemaOpen.add(openKey);
				body.hidden = !schemaOpen.has(openKey);
				head.classList.toggle("open", schemaOpen.has(openKey));
			} }, h("div", { class: "grow" }, h("div", { class: `title${changed ? " changed-dot" : ""}` }, L(k.label)), h("div", { class: "sub" }, summaryOf(details, k))), h("span", { class: "chev", html: ICONS.chev })),
			h("label", { class: "switch" }, h("input", { type: "checkbox", checked: on, onchange: (e) => set({ enabled: e.target.checked }) }), h("span"))
		);
		const body = h("div", { class: "map-body", hidden: !schemaOpen.has(openKey) },
			(f.fields || []).filter((x) => x.key !== "enabled" && (!x.only || x.only.includes(k.value))).map((x) =>
				schemaField(x, details[x.key] ?? defOf(x) ?? null, (v) => set({ [x.key]: defOf(x) !== undefined && sameData(v, defOf(x)) ? null : v }), details[x.key] !== undefined ? () => set({ [x.key]: null }) : null)
			),
			changed ? h("button", { class: "btn ghost", onclick: () => set(Object.fromEntries(Object.keys(details).filter((x) => x !== "enabled").map((x) => [x, null]))) }, icon("undo"), t("schema.resetAll")) : null
		);
		if (schemaOpen.has(openKey)) head.classList.add("open");
		box.append(h("div", { class: `map-item${on ? "" : " off"}` }, head, body));
	}
	return box;
}

function summaryOf(details, k) {
	if (details.from) {
		const show = (d) => (/^\d{2}-\d{2}$/.test(d) ? dayLabel(d) : d);
		return details.until && details.until !== details.from ? `${show(details.from)} – ${show(details.until)}` : show(details.from);
	}
	return L(k.hint);
}

// A list of objects (e.g. own occasions): one card per item, fields from the schema.
function listField(f, items, onChange) {
	const box = h("div", { class: "form-list" });
	items.forEach((item, i) => {
		const set = (patch) => {
			const o = { ...item, ...patch };
			for (const key of Object.keys(o)) if (o[key] === null || o[key] === undefined || o[key] === "") delete o[key];
			onChange(items.map((x, k) => (k === i ? o : x)));
		};
		box.append(
			h("div", { class: "form-card" },
				h("div", { class: "form-card-head" }, h("span", { class: "form-card-title" }, item.name || `${i + 1}`), h("button", { class: "reset", title: t("form.remove"), onclick: () => onChange(items.filter((x, k) => k !== i)) }, icon("close"))),
				h("div", { class: "card schema-inner" }, (f.fields || []).map((x) => schemaField(x, item[x.key] ?? x.default ?? null, (v) => set({ [x.key]: v }), item[x.key] !== undefined && !(f.new && x.key in f.new) ? () => set({ [x.key]: null }) : null))))
		);
	});
	box.append(h("button", { class: "btn ghost form-add", onclick: () => onChange([...items, { ...(f.new || {}) }]) }, icon("plus"), L(f.addLabel) || t("form.addEntry")));
	return box;
}
