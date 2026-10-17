/* Form editor for module settings that are lists or objects (no code needed).
   Works on plain data: strings, numbers, booleans, null, arrays and objects. */
"use strict";

// Returns an element that edits `value`, or null if the value can't be shown as a form.
// onChange(newValue) is called with the complete new value after every change.
// template: a value of the same shape (e.g. the module's default) used for new list entries.
function dataEditor(value, onChange, template) {
	if (Array.isArray(value)) return listEditor(value, onChange, Array.isArray(template) ? template : null);
	if (value && typeof value === "object") return objectEditor(value, onChange, template && typeof template === "object" ? template : null);
	return valueInput(value, onChange);
}

function valueInput(value, onChange) {
	if (typeof value === "boolean") {
		return h("label", { class: "switch" }, h("input", { type: "checkbox", checked: value, onchange: (e) => onChange(e.target.checked) }), h("span"));
	}
	if (typeof value === "number") {
		return h("input", {
			class: "input num",
			value: String(value),
			style: numberWidth(value),
			inputmode: "decimal",
			onchange: (e) => {
				const n = Number(e.target.value.replace(",", "."));
				if (e.target.value.trim() === "" || !Number.isFinite(n)) e.target.value = String(value);
				else onChange(n);
			}
		});
	}
	return h("input", { class: "input grow-input", value: value === null ? "" : String(value), spellcheck: "false", onchange: (e) => onChange(e.target.value) });
}

// number fields grow with long values (e.g. 604800000)
function numberWidth(value) {
	return `width:${Math.max(7, String(value).length + 3)}ch`;
}

const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

function objectEditor(obj, onChange, template) {
	const box = h("div", { class: "form-obj" });
	for (const key of Object.keys(obj)) {
		const child = obj[key];
		const set = (v) => onChange({ ...obj, [key]: v });
		const tpl = template ? template[key] : undefined;
		if (isPrimitive(child)) {
			box.append(h("div", { class: `form-row${typeof child === "string" || child === null ? " wide" : ""}` }, h("span", { class: "form-key" }, key), valueInput(child, set)));
		} else {
			const ed = dataEditor(child, set, tpl);
			box.append(h("div", { class: "form-group" }, h("div", { class: "form-key" }, key), ed || h("div", { class: "muted small" }, "–")));
		}
	}
	return box;
}

function listEditor(arr, onChange, template) {
	const sample = arr.length ? arr : template || [];
	if (sample.every(isPrimitive)) return tagEditor(arr, onChange, sample.some((v) => typeof v === "number"));
	if (!sample.every((v) => v && typeof v === "object" && !Array.isArray(v))) return null;

	const box = h("div", { class: "form-list" });
	arr.forEach((item, i) => {
		const set = (v) => onChange(arr.map((x, k) => (k === i ? v : x)));
		const remove = () => onChange(arr.filter((x, k) => k !== i));
		const title = Object.values(item).find((v) => typeof v === "string" && v) || `${i + 1}`;
		box.append(
			h(
				"div",
				{ class: "form-card" },
				h("div", { class: "form-card-head" }, h("span", { class: "form-card-title" }, Array.isArray(title) ? title.join(", ") : String(title)), h("button", { class: "reset", title: t("form.remove"), "aria-label": t("form.remove"), onclick: remove }, icon("close"))),
				objectEditor(item, set, template && template[0])
			)
		);
	});
	const base = (template && template[0]) || arr[0];
	// a new entry has the shape of the existing ones (or of the module's example) with empty texts
	if (base) box.append(h("button", { class: "btn ghost form-add", onclick: () => onChange([...arr, blank(base)]) }, icon("plus"), t("form.addEntry")));
	return box;
}

// Simple lists ("Monday", "Tuesday" …): tags with × and a field to add more.
function tagEditor(arr, onChange, numeric) {
	const add = (text) => {
		const v = text.trim();
		if (!v) return;
		const n = Number(v.replace(",", "."));
		onChange([...arr, numeric && Number.isFinite(n) ? n : v]);
	};
	const input = h("input", {
		class: "tag-input",
		placeholder: t("form.add"),
		spellcheck: "false",
		onkeydown: (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				add(e.target.value);
			}
		},
		onchange: (e) => add(e.target.value)
	});
	return h(
		"div",
		{ class: "tags" },
		arr.map((v, i) => h("span", { class: "tag" }, String(v), h("button", { "aria-label": t("form.remove"), onclick: () => onChange(arr.filter((x, k) => k !== i)) }, "×"))),
		input
	);
}

// Same shape with empty texts: a fresh entry based on an existing one.
function blank(v) {
	if (typeof v === "string") return "";
	if (Array.isArray(v)) return [];
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]));
	return v;
}

function sameData(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
