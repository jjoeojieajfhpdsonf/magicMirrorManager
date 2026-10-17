/* MagicMirror Manager – web app (vanilla JS, no build step). */
"use strict";

// ---------- tiny helpers ----------

function h(tag, props, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "text") el.textContent = v;
		else if (k === "html") el.innerHTML = v; // only used for our own icons
		else if (k === "style") el.style.cssText = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (["value", "checked", "disabled", "hidden", "open", "selected"].includes(k)) el[k] = v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of kids.flat(Infinity)) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

// replaceChildren that ignores null/false entries
function fill(el, ...kids) {
	el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
	return el;
}

const ICONS = {
	mirror: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'><rect x='5' y='2.5' width='14' height='19' rx='3'/><path d='M8.5 6.5h3M8.5 9h5M12.5 17.5h3'/></svg>",
	modules: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linejoin='round'><rect x='3.5' y='3.5' width='7' height='7' rx='2'/><rect x='13.5' y='3.5' width='7' height='7' rx='2'/><rect x='3.5' y='13.5' width='7' height='7' rx='2'/><rect x='13.5' y='13.5' width='7' height='7' rx='2'/></svg>",
	system: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'><path d='M4 7h10M18 7h2M4 17h2M10 17h10'/><circle cx='16' cy='7' r='2.2'/><circle cx='8' cy='17' r='2.2'/></svg>",
	plus: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round'><path d='M12 5v14M5 12h14'/></svg>",
	close: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round'><path d='M6 6l12 12M18 6L6 18'/></svg>",
	check: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12.5l4.5 4.5L19 7.5'/></svg>",
	x: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.6' stroke-linecap='round'><path d='M7 7l10 10M17 7L7 17'/></svg>",
	undo: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 7L5 11l4 4'/><path d='M5 11h9a5 5 0 010 10h-2'/></svg>",
	chev: "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><path d='M9 6l6 6-6 6'/></svg>",
	refresh: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20 11a8 8 0 10-2.3 5.7'/><path d='M20 5v6h-6'/></svg>",
	rotate: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linejoin='round'><rect x='7' y='3' width='10' height='18' rx='2.5'/><path d='M3 17.5V9a3 3 0 013-3' stroke-linecap='round'/></svg>",
	warn: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round'><path d='M12 8v5M12 16.5v.5'/></svg>"
};
const icon = (name) => h("span", { html: ICONS[name], style: "display:contents" });

function store(key, value) {
	try {
		if (value === undefined) return localStorage.getItem(key);
		localStorage.setItem(key, value);
	} catch {
		return null;
	}
	return value;
}

async function api(method, url, body) {
	const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
	let data = null;
	try {
		data = await res.json();
	} catch {
		// not JSON
	}
	if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
	return data;
}

let toastTimer;
function toast(text, bad = false) {
	const el = document.getElementById("toast");
	el.textContent = text;
	el.className = `toast${bad ? " bad" : ""}`;
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 2600);
}

async function guard(fn) {
	try {
		return await fn();
	} catch (err) {
		toast(err.message, true);
		return undefined;
	}
}

// ---------- app state ----------

const S = {
	state: null,
	tab: store("tab") || "mirror",
	modules: null,
	catalog: null,
	status: null,
	landscape: false,
	logsOpen: false
};

setLang(store("lang"));

// Laptop/desktop: mirror on the left, an inspector panel on the right instead of sheets.
const wideQuery = window.matchMedia("(min-width: 980px)");
const isWide = () => wideQuery.matches;
wideQuery.addEventListener("change", () => render());

// Called after every edit of the draft.
function applied(res) {
	S.state = res;
	renderPending();
	refreshMirror();
}

async function refresh() {
	const st = await guard(() => api("GET", "/api/state"));
	if (st) {
		S.state = st;
		if (st.settings) S.landscape = st.settings.orientation === "landscape";
	}
	render();
}

async function loadModules() {
	const m = await guard(() => api("GET", "/api/modules"));
	if (m) S.modules = m;
	return S.modules;
}

async function loadStatus() {
	const st = await api("GET", "/api/status").catch(() => null);
	S.status = st;
	renderTabs();
	if (S.tab === "system" && !document.querySelector(".sheet")) renderView();
}

function isRunning(st) {
	if (!st) return false;
	const p = st.process;
	return st.http && st.http.up && (!p || p.kind !== "pm2" || p.status === "online");
}

function changeText(c) {
	const p = { ...c.p };
	if (p.m) p.m = moduleLabel(p.m);
	if ("pos" in p) p.pos = posLabel(p.pos);
	return t(c.k, p);
}

// ---------- rendering ----------

function render() {
	renderTabs();
	renderView();
	renderPending();
}

function renderTabs() {
	const nav = document.getElementById("tabs");
	fill(nav, 
		...["mirror", "modules", "system"].map((tab) => {
			const updates = tab === "modules" && S.modules && S.modules.modules.some((m) => m.update && m.update.behind > 0);
			const down = tab === "system" && S.status && !isRunning(S.status);
			const badge = updates ? h("span", { class: "badge" }) : down ? h("span", { class: "badge bad" }) : null;
			return h("button", { class: S.tab === tab ? "active" : "", onclick: () => switchTab(tab), "aria-label": t(`tab.${tab}`) }, icon(tab), badge, t(`tab.${tab}`));
		})
	);
}

function switchTab(tab) {
	S.tab = tab;
	store("tab", tab);
	window.scrollTo(0, 0);
	render();
	if (tab === "modules") loadModules().then(renderView);
	if (tab === "system") loadStatus();
}

function renderView() {
	const view = document.getElementById("view");
	view.dataset.tab = S.tab;
	document.getElementById("title").textContent = t(`tab.${S.tab}`);
	if (!S.state) return;
	if (!S.state.ok) {
		fill(view, setupView());
		return;
	}
	const fn = { mirror: mirrorView, modules: modulesView, system: systemView }[S.tab] || mirrorView;
	fill(view, fn());
}

function setupView() {
	const s = S.state.setup;
	return h(
		"div",
		{},
		h("div", { class: "section-title" }, t("setup.title")),
		h("div", { class: "note warn" }, s.problem === "noConfig" ? t("setup.noConfig", { error: s.error }) : t("setup.text", { dir: s.mmDir }))
	);
}

function renderPending() {
	const foot = isWide() && S.tab === "mirror" ? document.querySelector(".inspector-foot") : null;
	const bar = document.getElementById("pending");
	const el = foot || bar;
	const st = S.state;
	const has = st && st.ok && (st.draft || st.conflict);
	document.body.classList.toggle("has-pending", !!has && !foot);
	if (foot) bar.hidden = true;
	if (!has) {
		el.hidden = true;
		return;
	}
	el.hidden = false;
	if (st.conflict) {
		el.replaceChildren(h("div", { class: "grow small", style: "font-weight:500;color:var(--warn)" }, t("pending.conflict")), h("button", { class: "btn", onclick: discardDraft }, t("pending.discard")));
		return;
	}
	const n = st.draft.changes.length;
	el.replaceChildren(
		h("button", { class: "grow", style: "text-align:left", onclick: pendingSheet }, n === 1 ? t("pending.one") : t("pending.many", { n })),
		h("button", { class: "btn primary", onclick: applyDraft, disabled: !!st.job }, t("pending.apply"))
	);
}

async function discardDraft() {
	const st = await guard(() => api("POST", "/api/draft/discard"));
	if (st) S.state = st;
	render();
}

async function applyDraft() {
	const job = await guard(() => api("POST", "/api/apply"));
	if (job) jobSheet(job);
}

// ---------- mirror view (layout sketch) ----------

const MAIN_POSITIONS = ["top_bar", "top_left", "top_center", "top_right", "upper_third", "middle_center", "lower_third", "bottom_left", "bottom_center", "bottom_right", "bottom_bar"];

function chip(e) {
	const cls = ["chip"];
	if (e.disabled) cls.push("off");
	if (!e.installed && !e.disabled) cls.push("missing");
	if (isWide() && S.selected === e.index) cls.push("sel");
	return h("button", { class: cls.join(" "), "data-index": e.index, title: e.module }, moduleLabel(e.module), e.header ? h("small", {}, e.header) : !e.installed && !e.disabled ? h("small", {}, t("mirror.notInstalled")) : null);
}

function mirrorView() {
	const st = S.state;
	if (st.parseError) return h("div", { class: "note bad" }, st.parseError);
	if (S.selected !== undefined && S.selected !== null && !st.entries[S.selected]) S.selected = null;
	const wrap = mirrorWrap();
	if (!isWide()) {
		const fab = h("button", { class: "fab", "aria-label": t("add.title"), onclick: () => addSheet() }, icon("plus"));
		return h("div", {}, wrap, fab);
	}
	const panel = h("div", { class: "inspector-main" });
	const inspector = h("aside", { class: "inspector" }, panel, h("div", { class: "inspector-foot" }));
	const studio = h("div", { class: "studio" }, h("div", { class: "stage" }, wrap), inspector);
	queueMicrotask(() => {
		fillInspector(panel);
		renderPending();
	});
	return studio;
}

function inspectorHost() {
	return document.querySelector(".inspector-main");
}

// Inspector content: the selected module, the "add" list, or a calm hint.
function fillInspector(host = inspectorHost(), mode = null) {
	if (!host || !host.isConnected) return;
	if (S.selected !== null && S.selected !== undefined && S.state.entries[S.selected]) return entrySheet(S.selected, host);
	if (mode === "add") return addSheet(null, host);
	fill(
		host,
		h(
			"div",
			{ class: "inspector-empty" },
			h("div", { class: "muted" }, t("inspector.hint")),
			h("button", { class: "btn", onclick: () => fillInspector(host, "add") }, icon("plus"), t("add.title"))
		)
	);
}

// Re-draws only the mirror sketch (keeps the inspector as it is).
function refreshMirror() {
	const old = document.querySelector("#view .mirror-wrap");
	if (old && S.tab === "mirror") old.replaceWith(mirrorWrap());
}

function mirrorWrap() {
	const st = S.state;
	const known = new Set(st.positions);
	const groups = {};
	for (const e of st.entries) {
		if (!e.module) continue;
		const pos = e.position && known.has(e.position) ? e.position : "";
		(groups[pos] = groups[pos] || []).push(e);
	}
	const region = (pos, extraClass = "") =>
		h("div", { class: `region area-${pos || "none"} ${extraClass} ${(groups[pos] || []).length ? "" : "empty"}`, "data-pos": pos, "data-label": posLabel(pos || null) }, extraClass ? h("div", { class: "tray-label" }, posLabel(pos || null)) : null, (groups[pos] || []).map(chip));

	const mirror = h("div", { class: `mirror${S.landscape ? " landscape" : ""}` }, MAIN_POSITIONS.filter((p) => known.has(p)).map((p) => region(p)));
	const tray = h("div", { class: "tray" }, ["fullscreen_above", "fullscreen_below"].filter((p) => known.has(p)).map((p) => region(p, "tray-region")), region("", "tray-region"));
	const foot = h(
		"div",
		{ class: "mirror-foot" },
		h("div", { class: "hint" }, st.entries.length ? t("mirror.dragHint") : t("mirror.empty")),
		h("button", { class: "icon-btn", "aria-label": t("mirror.rotate"), title: t("mirror.rotate"), onclick: toggleOrientation }, icon("rotate"))
	);
	const wrap = h("div", { class: `mirror-wrap${S.landscape ? " is-landscape" : ""}` }, h("div", { class: "mirror-col" }, mirror, tray, foot));
	setupDrag(wrap);
	return wrap;
}

function toggleOrientation() {
	S.landscape = !S.landscape;
	refreshMirror();
	guard(() => api("POST", "/api/settings", { orientation: S.landscape ? "landscape" : "portrait" }));
}

// Drag & drop with pointer events: mouse drags right away, touch after a short press.
function setupDrag(root) {
	let pending = null;
	let drag = null;
	let suppressClick = false;

	const clearMarks = () => {
		root.querySelectorAll(".over").forEach((r) => r.classList.remove("over"));
		root.querySelectorAll(".drop-line").forEach((l) => l.remove());
	};

	const start = () => {
		if (!pending) return;
		const src = pending.chip;
		const rect = src.getBoundingClientRect();
		const ghost = src.cloneNode(true);
		ghost.classList.add("ghost");
		ghost.style.width = `${rect.width}px`;
		document.body.append(ghost);
		src.classList.add("placeholder-src");
		root.classList.add("dragging");
		drag = { src, ghost, index: Number(src.dataset.index), target: null };
		if (navigator.vibrate) navigator.vibrate(8);
		move(pending.x, pending.y);
	};

	const move = (x, y) => {
		drag.ghost.style.left = `${x}px`;
		drag.ghost.style.top = `${y}px`;
		const el = document.elementFromPoint(x, y);
		const reg = el && el.closest(".region");
		clearMarks();
		if (!reg || !root.contains(reg)) {
			drag.target = null;
			return;
		}
		reg.classList.add("over");
		const chips = [...reg.querySelectorAll(".chip")].filter((c) => c !== drag.src);
		const horizontal = reg.classList.contains("tray-region");
		let before = null;
		for (const c of chips) {
			const r = c.getBoundingClientRect();
			const after = horizontal ? (y < r.top ? true : y > r.bottom ? false : x < r.left + r.width / 2) : y < r.top + r.height / 2;
			if (after) {
				before = c;
				break;
			}
		}
		if (!horizontal) {
			const line = h("div", { class: "drop-line" });
			if (before) reg.insertBefore(line, before);
			else reg.append(line);
		}
		drag.target = { position: reg.dataset.pos || null, before: before ? Number(before.dataset.index) : null };
	};

	const end = async (commit) => {
		clearTimeout(pending && pending.timer);
		pending = null;
		if (!drag) return;
		const d = drag;
		drag = null;
		d.ghost.remove();
		d.src.classList.remove("placeholder-src");
		root.classList.remove("dragging");
		clearMarks();
		suppressClick = true;
		setTimeout(() => (suppressClick = false), 50);
		if (!commit || !d.target) return;
		const e = S.state.entries[d.index];
		if (d.target.before === d.index) return;
		const res = await guard(() => api("POST", "/api/op", { op: "move", index: d.index, module: e.module, position: d.target.position, before: d.target.before }));
		if (!res) return;
		const sel = S.selected;
		if (sel !== null && sel !== undefined) {
			if (sel === d.index) S.selected = res.index;
			else {
				let x = sel - (sel > d.index ? 1 : 0);
				x += x >= res.index ? 1 : 0;
				S.selected = x;
			}
		}
		applied(res);
		if (isWide() && S.selected === res.index) fillInspector();
	};

	root.addEventListener("pointerdown", (ev) => {
		const c = ev.target.closest(".chip");
		if (!c || ev.button > 0) return;
		pending = { chip: c, x: ev.clientX, y: ev.clientY, type: ev.pointerType };
		if (ev.pointerType !== "mouse") pending.timer = setTimeout(start, 260);
	});
	const onMove = (ev) => {
		if (drag) {
			ev.preventDefault();
			move(ev.clientX, ev.clientY);
			return;
		}
		if (!pending) return;
		const dist = Math.hypot(ev.clientX - pending.x, ev.clientY - pending.y);
		if (pending.type === "mouse" && dist > 5) {
			pending.x = ev.clientX;
			pending.y = ev.clientY;
			start();
		} else if (pending.type !== "mouse" && dist > 8) {
			clearTimeout(pending.timer);
			pending = null;
		} else {
			pending.x = ev.clientX;
			pending.y = ev.clientY;
		}
	};
	const onUp = () => end(true);
	const onCancel = () => end(false);
	const onTouchMove = (ev) => {
		if (drag) ev.preventDefault();
	};
	window.addEventListener("pointermove", onMove, { passive: false });
	window.addEventListener("pointerup", onUp);
	window.addEventListener("pointercancel", onCancel);
	document.addEventListener("touchmove", onTouchMove, { passive: false });
	root.addEventListener("contextmenu", (ev) => {
		if (ev.target.closest(".chip")) ev.preventDefault();
	});
	root.addEventListener("click", (ev) => {
		const c = ev.target.closest(".chip");
		if (!c) return;
		if (suppressClick) return;
		const index = Number(c.dataset.index);
		if (isWide()) {
			S.selected = index;
			refreshMirror();
			fillInspector();
		} else entrySheet(index);
	});
	// remove global listeners when the view is replaced
	const obs = new MutationObserver(() => {
		if (!root.isConnected) {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			document.removeEventListener("touchmove", onTouchMove);
			obs.disconnect();
		}
	});
	obs.observe(document.getElementById("view"), { childList: true });
}

// ---------- sheets ----------

function openSheet({ onClose } = {}) {
	const host = document.getElementById("sheets");
	const backdrop = h("div", { class: "backdrop" });
	const head = h("div", { class: "sheet-head" });
	const body = h("div", { class: "sheet-body" });
	const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, head, body);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		backdrop.remove();
		sheet.remove();
		document.removeEventListener("keydown", onKey);
		if (!host.children.length) document.body.style.overflow = "";
		if (onClose) onClose();
	};
	const onKey = (e) => {
		if (e.key === "Escape" && host.lastElementChild === sheet) close();
	};
	backdrop.addEventListener("click", close);
	document.addEventListener("keydown", onKey);
	host.append(backdrop, sheet);
	document.body.style.overflow = "hidden";
	const setHead = (title, sub, ...extra) => {
		fill(head, h("div", { class: "grow" }, h("h2", {}, title), sub ? h("div", { class: "sub" }, sub) : null), ...extra, h("button", { class: "close-btn", "aria-label": t("common.close"), onclick: close }, icon("close")));
	};
	return { sheet, body, close, setHead, get closed() { return closed; } };
}

// Same interface as openSheet, but renders into the inspector panel.
function openPanel(host, { onClose } = {}) {
	const head = h("div", { class: "sheet-head" });
	const body = h("div", { class: "sheet-body" });
	fill(host, head, body);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		if (onClose) onClose();
	};
	const setHead = (title, sub, ...extra) => {
		const closeBtn = onClose ? h("button", { class: "close-btn", "aria-label": t("common.close"), onclick: close }, icon("close")) : null;
		fill(head, ...[h("div", { class: "grow" }, h("h2", {}, title), sub ? h("div", { class: "sub" }, sub) : null), ...extra, closeBtn].filter(Boolean));
	};
	return { sheet: host, body, close, setHead, get closed() { return closed; } };
}

function confirmSheet(text, yesLabel, danger = false) {
	return new Promise((resolve) => {
		let answer = false;
		const s = openSheet({ onClose: () => resolve(answer) });
		s.setHead(text);
		s.body.append(
			h(
				"div",
				{ class: "btn-row" },
				h("button", { class: "btn", onclick: () => s.close() }, t("common.cancel")),
				h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => { answer = true; s.close(); } }, yesLabel || t("common.yes"))
			)
		);
	});
}

// Mini mirror to choose a region.
function picker(current, onPick, { allowNone = true } = {}) {
	const positions = S.state.positions;
	const el = h("div", { class: "picker" });
	const all = [...positions.filter((p) => MAIN_POSITIONS.includes(p) || p.startsWith("fullscreen"))];
	for (const p of all) {
		el.append(h("button", { class: `area-${p}${current === p ? " sel" : ""}`, onclick: () => onPick(p) }, posLabel(p)));
	}
	if (allowNone) el.append(h("button", { class: `p-none${!current ? " sel" : ""}`, onclick: () => onPick(null) }, t("pos.none")));
	return el;
}

// ---------- module entry sheet ----------

async function entrySheet(index, host = null) {
	const s = host
		? openPanel(host, { onClose: () => { S.selected = null; refreshMirror(); fillInspector(host); } })
		: openSheet({ onClose: () => render() });
	let d = null;
	let idx = index;
	let moreOpen = false;

	async function load() {
		d = await guard(() => api("GET", `/api/entry/${idx}`));
		if (!d) return s.close();
		draw();
	}

	async function op(body, { reload = true } = {}) {
		const res = await guard(() => api("POST", "/api/op", { index: idx, module: d.module, ...body }));
		if (!res) return false;
		if (typeof res.index === "number") idx = res.index;
		if (host) S.selected = idx;
		applied(res);
		if (reload) await load();
		return true;
	}

	function draw() {
		const entry = S.state.entries[idx] || {};
		const sw = h("label", { class: "switch", title: t("entry.on") }, h("input", { type: "checkbox", checked: !d.disabled, onchange: (e) => op({ op: "toggle", disabled: !e.target.checked }) }), h("span"));
		s.setHead(moduleLabel(d.module), d.module !== moduleLabel(d.module) ? d.module : null, sw);

		const parts = [];
		if (entry.installed === false) parts.push(h("div", { class: "note bad" }, t("mirror.notInstalled")));

		parts.push(h("div", { class: "section-title" }, t("entry.position")));
		parts.push(picker(d.position, (pos) => op({ op: "move", position: pos, before: null })));

		parts.push(h("div", { class: "section-title" }, t("entry.header")));
		parts.push(h("div", { class: "card" }, h("div", { class: "field" }, h("input", { class: "input wide", value: d.header, placeholder: t("entry.headerPh"), onchange: (e) => op({ op: "setHeader", header: e.target.value }) }))));

		parts.push(settingsSection());

		const info = d.info || {};
		parts.push(
			h(
				"div",
				{ class: "card", style: "margin-top:22px" },
				info.url ? h("a", { class: "row", href: info.url, target: "_blank", rel: "noopener" }, h("span", { class: "grow" }, t("entry.readme")), icon("chev")) : null,
				h("button", { class: "row", onclick: () => op({ op: "duplicate" }, { reload: false }).then((ok) => ok && (s.close(), toast(t("chg.duplicate", { m: moduleLabel(d.module) })))) }, h("span", { class: "grow" }, t("entry.duplicate"))),
				h("button", { class: "row", onclick: codeEditor }, h("span", { class: "grow" }, t("entry.asCode"))),
				h("button", { class: "row", style: "color:var(--bad)", onclick: removeEntry }, h("span", { class: "grow" }, t("entry.remove")))
			)
		);
		const scroll = s.body.scrollTop;
		fill(s.body, ...parts);
		s.body.scrollTop = scroll;
	}

	function settingsSection() {
		const wrap = h("div");
		wrap.append(h("div", { class: "section-title" }, t("entry.settings")));
		if (d.configIsCode) {
			wrap.append(h("div", { class: "note" }, t("entry.configIsCode")));
			return wrap;
		}
		const defs = d.defaults || [];
		const cur = new Map(d.options.map((o) => [o.key, o]));
		const set = [...cur.keys()];
		const others = defs.map((x) => x.key).filter((k) => !cur.has(k));
		const field = (key) => optionField(key, cur.get(key), defs.find((x) => x.key === key));
		if (set.length) wrap.append(h("div", { class: "card" }, set.map(field)));
		if (others.length) {
			const det = h("details", { style: "margin-top:8px", open: moreOpen }, h("summary", {}, t("entry.more", { n: others.length })), h("div", { class: "card" }, others.map(field)));
			det.addEventListener("toggle", () => (moreOpen = det.open));
			wrap.append(det);
		}
		if (!defs.length && !set.length) wrap.append(h("div", { class: "note" }, t("entry.noDefaults")));
		wrap.append(customAdder());
		return wrap;
	}

	function summary(v) {
		if (Array.isArray(v)) return t("entry.items", { n: v.length });
		if (v && typeof v === "object") return t("entry.fields", { n: Object.keys(v).length });
		if (v === null) return "null";
		return String(v);
	}

	function short(v) {
		const s2 = typeof v === "string" ? `"${v}"` : summary(v);
		return s2.length > 40 ? `${s2.slice(0, 40)}…` : s2;
	}

	function optionField(key, o, def) {
		const isSet = !!o;
		const src = o || def;
		const type = src.simple ? typeof src.value : "code";
		const hint = def ? (def.dynamic ? `${t("entry.default")}: ${t("entry.dynamic")}` : `${t("entry.default")}: ${short(def.value)}`) : "";
		const label = h("div", { class: "label" }, h("div", { class: "k" }, key), isSet && hint ? h("div", { class: "d" }, hint) : null);
		const reset = isSet ? h("button", { class: "reset", title: t("entry.reset"), "aria-label": t("entry.reset"), onclick: () => op({ op: "resetOption", key }) }, icon("undo")) : null;
		const setValue = (value) => {
			if (def && def.simple && value === def.value) return op(isSet ? { op: "resetOption", key } : null);
			return op({ op: "setOption", key, value });
		};
		if (type === "boolean") {
			return h("div", { class: `field${isSet ? " changed" : ""}` }, label, reset, h("label", { class: "switch" }, h("input", { type: "checkbox", checked: !!src.value, onchange: (e) => setValue(e.target.checked) }), h("span")));
		}
		if (type === "number" || type === "string") {
			const input = h("input", {
				class: `input ${type === "number" ? "num" : "text"}`,
				value: String(src.value),
				inputmode: type === "number" ? "decimal" : null,
				onchange: (e) => {
					if (type === "number") {
						const n = Number(e.target.value.replace(",", "."));
						if (e.target.value.trim() === "" || !Number.isFinite(n)) {
							e.target.value = String(src.value);
							return;
						}
						setValue(n);
					} else setValue(e.target.value);
				}
			});
			return h("div", { class: `field${isSet ? " changed" : ""}` }, label, reset, input);
		}
		// complex value: show a summary, edit as code
		const box = h("div", { class: `field col${isSet ? " changed" : ""}` });
		const sumBtn = h("button", { class: "value-sum", onclick: () => openEditor() }, src.dynamic ? t("entry.dynamic") : summary(src.value));
		box.append(h("div", { class: "top-line" }, label, reset, sumBtn));
		function openEditor() {
			const ta = h("textarea", { class: "code", spellcheck: "false", value: src.code, rows: Math.min(14, Math.max(4, src.code.split("\n").length + 1)) });
			const err = h("div", { class: "note bad", hidden: true });
			const row = h(
				"div",
				{ class: "btn-row" },
				h("button", { class: "btn", onclick: () => draw() }, t("entry.cancel")),
				h("button", {
					class: "btn primary",
					onclick: async () => {
						try {
							await api("POST", "/api/op", { op: "setOption", index: idx, module: d.module, key, code: ta.value }).then((res) => {
								applied(res);
							});
							await load();
						} catch (e) {
							err.textContent = e.message;
							err.hidden = false;
						}
					}
				}, t("entry.save"))
			);
			sumBtn.remove();
			box.append(ta, err, row);
			ta.focus();
		}
		return box;
	}

	function customAdder() {
		const key = h("input", { class: "input wide", placeholder: t("entry.customKey"), autocapitalize: "off", spellcheck: "false" });
		const val = h("textarea", { class: "code", style: "min-height:70px", placeholder: t("entry.customValue"), spellcheck: "false" });
		const err = h("div", { class: "note bad", hidden: true });
		const add = h("button", {
			class: "btn",
			onclick: async () => {
				try {
					const res = await api("POST", "/api/op", { op: "setOption", index: idx, module: d.module, key: key.value.trim(), code: val.value });
					applied(res);
					await load();
				} catch (e) {
					err.textContent = e.message;
					err.hidden = false;
				}
			}
		}, t("entry.add"));
		return h("details", { style: "margin-top:8px" }, h("summary", {}, t("entry.custom")), h("div", { class: "card", style: "padding:12px;display:flex;flex-direction:column;gap:8px" }, key, val, err, add));
	}

	function codeEditor() {
		const ta = h("textarea", { class: "code big", spellcheck: "false", value: d.entryText });
		const err = h("div", { class: "note bad", hidden: true });
		fill(s.body, 
			h("div", { class: "small muted", style: "margin:4px 4px 8px" }, t("entry.codeHint")),
			ta,
			err,
			h(
				"div",
				{ class: "btn-row" },
				h("button", { class: "btn", onclick: draw }, t("entry.cancel")),
				h("button", {
					class: "btn primary",
					onclick: async () => {
						try {
							const res = await api("POST", "/api/op", { op: "setEntryText", index: idx, module: d.module, text: ta.value });
							applied(res);
							await load();
						} catch (e) {
							err.textContent = e.message;
							err.hidden = false;
						}
					}
				}, t("entry.save"))
			)
		);
	}

	async function removeEntry() {
		if (await op({ op: "remove" }, { reload: false })) s.close();
	}

	s.setHead(moduleLabel(S.state.entries[index] && S.state.entries[index].module));
	await load();
}

// ---------- add module ----------

async function addSheet(preset = null, host = null) {
	const s = host ? openPanel(host, { onClose: () => fillInspector(host) }) : openSheet({ onClose: () => render() });
	s.setHead(t("add.title"));
	let pos = preset || "top_left";
	const mods = await loadModules();
	const draw = () => {
		const pick = picker(pos, (p) => {
			pos = p;
			draw();
		});
		const item = (name) =>
			h(
				"button",
				{
					class: "row",
					onclick: async () => {
						const res = await guard(() => api("POST", "/api/op", { op: "add", module: name, position: pos }));
						if (!res) return;
						toast(t("chg.add", { m: moduleLabel(name) }));
						if (host) {
							S.selected = res.entries.length - 1;
							applied(res);
							fillInspector(host);
						} else {
							S.state = res;
							s.close();
						}
					}
				},
				h("div", { class: "grow" }, h("div", { class: "title" }, moduleLabel(name)), moduleLabel(name) !== name ? h("div", { class: "sub" }, name) : null),
				icon("plus")
			);
		const installed = mods ? mods.modules.filter((m) => m.valid).map((m) => m.name) : [];
		fill(s.body, 
			h("div", { class: "section-title" }, t("add.where")),
			pick,
			installed.length ? h("div", { class: "section-title" }, t("add.installed")) : null,
			installed.length ? h("div", { class: "card" }, installed.map(item)) : null,
			h("div", { class: "section-title" }, t("add.builtin")),
			h("div", { class: "card" }, S.state.builtins.map(item)),
			h("button", { class: "btn block", style: "margin-top:18px", onclick: () => { if (!host) s.close(); catalogSheet(); } }, t("add.search"))
		);
	};
	draw();
}

// ---------- pending changes ----------

async function pendingSheet() {
	const s = openSheet();
	s.setHead(t("pending.details"));
	const st = S.state;
	const list = h("div", { class: "card" }, st.draft.changes.map((c) => h("div", { class: "row" }, h("span", { class: "grow" }, changeText(c)))));
	const diffBox = h("div", { class: "diff" });
	const det = h("details", { style: "margin-top:12px" }, h("summary", {}, t("pending.diff")), diffBox);
	det.addEventListener("toggle", async () => {
		if (!det.open || diffBox.childElementCount) return;
		const r = await guard(() => api("GET", "/api/draft/diff"));
		if (r) fill(diffBox, ...renderDiff(r.diff));
	});
	s.body.append(
		list,
		det,
		h(
			"div",
			{ class: "btn-row" },
			h("button", { class: "btn danger", onclick: async () => { await discardDraft(); s.close(); } }, t("pending.discard")),
			h("button", { class: "btn primary", onclick: () => { s.close(); applyDraft(); } }, t("pending.apply"))
		)
	);
}

function renderDiff(diff) {
	return diff.map((d) => h("div", { class: d.type === "+" ? "add" : d.type === "-" ? "del" : d.type === "…" ? "gap" : "" }, d.type === "…" ? "⋯" : `${d.type} ${d.line}`));
}

// ---------- jobs ----------

function jobSheet(job, { onDone } = {}) {
	const s = openSheet({ onClose: () => refresh().then(() => S.tab === "modules" && loadModules().then(renderView)) });
	let timer = null;
	const title = t(`job.${job.type}`, { name: job.title });
	s.setHead(title);

	const draw = (j) => {
		const steps = h(
			"div",
			{ class: "steps" },
			j.steps.map((st) => {
				let detail = st.detail || "";
				if (st.key === "verify" && st.state === "running" && /^\d+$/.test(detail)) detail = t("job.seconds", { n: detail });
				if (j.type === "checkUpdates" && st.state === "done") detail = Number(detail) ? t("job.updatesFound", { n: detail }) : t("job.noUpdates");
				if (st.key === "pull" && detail === "same") detail = t("job.noUpdates");
				const ic = st.state === "done" ? icon("check") : st.state === "failed" ? icon("x") : null;
				return h("div", { class: `step ${st.state}` }, h("div", { class: "ic" }, ic), h("div", { class: "grow" }, h("div", { class: "name" }, t(`step.${st.label}`)), detail ? h("div", { class: "detail" }, detail) : null));
			})
		);
		const parts = [steps];
		if (j.status !== "running") parts.push(resultBlock(j));
		if (j.lines && j.lines.length) parts.push(h("details", {}, h("summary", {}, t("job.log")), h("div", { class: "log" }, j.lines.join("\n"))));
		if (j.status !== "running") parts.push(h("button", { class: "btn block", style: "margin-top:14px", onclick: () => s.close() }, t("job.close")));
		fill(s.body, ...parts);
	};

	const poll = async () => {
		let j;
		try {
			j = await api("GET", `/api/job/${job.id}`);
		} catch {
			timer = setTimeout(poll, 1500);
			return;
		}
		if (s.closed) return;
		draw(j);
		if (j.status === "running") timer = setTimeout(poll, 700);
		else {
			refresh();
			if (onDone) onDone(j);
		}
	};
	draw(job);
	poll();
	return () => clearTimeout(timer);
}

function resultBlock(j) {
	const r = j.result || {};
	const block = (kind, ic, title, text, extra) => h("div", {}, h("div", { class: `result ${kind}` }, h("div", { class: "big" }, icon(ic)), h("div", { class: "grow" }, h("div", { class: "title" }, title), text ? h("div", { class: "small muted" }, text) : null)), extra);
	if (j.status === "failed") {
		const errors = r.errors ? r.errors.join("\n") : r.reason || j.error || "";
		return block("bad", "x", t("job.failed"), r.errors ? t("job.checkFailed") : null, errors ? h("div", { class: "note bad" }, errors) : null);
	}
	if (j.status === "rolledBack") {
		return block("warn", "undo", t("job.rolledBack"), t("job.rolledBackText"), h("div", {}, h("div", { class: "note bad" }, r.reason || ""), r.log ? h("details", {}, h("summary", {}, t("job.log")), h("div", { class: "log" }, r.log)) : null));
	}
	let text = null;
	if (j.type === "apply" || j.type === "restore") text = r.notRestarted ? t("job.notRestarted") : t("job.doneApply");
	if (j.type === "install") text = r.addedToDraft ? t("job.installed") : t("job.installedOnly");
	if (j.type === "update" && r.from) text = r.from === r.to ? t("job.noUpdates") : `${r.from} → ${r.to}`;
	if (j.type === "checkUpdates") text = r.available ? t("job.updatesFound", { n: r.available }) : t("job.noUpdates");
	const warnings = (r.warnings || []).filter(Boolean);
	return block(r.notRestarted ? "warn" : "ok", "check", t("job.done"), text, warnings.length ? h("details", {}, h("summary", {}, t("job.warnings")), h("div", { class: "log" }, warnings.join("\n"))) : null);
}

// ---------- modules view ----------

function modulesView() {
	const m = S.modules;
	const wrap = h("div");
	wrap.append(
		h(
			"div",
			{ class: "btn-row", style: "margin-top:4px" },
			h("button", { class: "btn primary", onclick: () => catalogSheet() }, icon("plus"), t("modules.find")),
			h("button", { class: "btn", onclick: checkUpdates }, icon("refresh"), t("modules.checkUpdates"))
		)
	);
	if (!m) return wrap;
	const withUpdate = m.modules.filter((x) => x.update && x.update.behind > 0);
	wrap.append(
		h(
			"div",
			{ class: "section-title" },
			h("span", {}, `${t("modules.installed")} · ${m.checked ? t("modules.checked", { t: ago(m.checked) }) : t("modules.never")}`),
			withUpdate.length > 1 ? h("button", { onclick: () => updateAll(withUpdate.map((x) => x.name)) }, t("modules.updateAll")) : null
		)
	);
	if (!m.modules.length) {
		wrap.append(h("div", { class: "card" }, h("div", { class: "empty" }, t("modules.none"))));
		return wrap;
	}
	const sorted = [...m.modules].sort((a, b) => (b.update && b.update.behind ? 1 : 0) - (a.update && a.update.behind ? 1 : 0));
	wrap.append(h("div", { class: "card" }, sorted.map(moduleRow)));
	return wrap;
}

function thumb(name, image) {
	const imgBase = (S.catalog && S.catalog.imageBase) || "https://modules.magicmirror.builders/images/";
	const el = h("div", { class: "thumb" }, image ? null : moduleLabel(name).slice(0, 2));
	if (image) el.style.backgroundImage = `url("${imgBase}${encodeURIComponent(image)}")`;
	return el;
}

function moduleRow(m) {
	const pills = [];
	if (m.update && m.update.behind > 0) pills.push(h("span", { class: "pill accent" }, t("modules.update")));
	if (!m.valid) pills.push(h("span", { class: "pill bad" }, t("modules.invalid")));
	if (m.archived) pills.push(h("span", { class: "pill warn" }, t("modules.archived")));
	return h(
		"button",
		{ class: "row", onclick: () => moduleSheet(m.name) },
		thumb(m.name, m.image),
		h("div", { class: "grow" }, h("div", { class: "title" }, moduleLabel(m.name)), h("div", { class: "sub" }, m.used ? t("modules.used") : t("modules.unused"), m.description ? ` · ${m.description}` : "")),
		pills,
		h("span", { class: "chev", html: ICONS.chev })
	);
}

async function checkUpdates() {
	const job = await guard(() => api("POST", "/api/modules/check-updates"));
	if (job) jobSheet(job, { onDone: () => loadModules().then(() => { renderTabs(); renderView(); }) });
}

async function updateAll(names) {
	for (const name of names) {
		const job = await guard(() => api("POST", `/api/modules/${encodeURIComponent(name)}/update`));
		if (!job) return;
		const final = await new Promise((resolve) => jobSheet(job, { onDone: resolve }));
		if (final.status !== "done") return;
		document.querySelectorAll(".sheet .close-btn").forEach((b) => b.click());
	}
	toast(t("job.done"));
}

async function moduleSheet(name) {
	const s = openSheet({ onClose: () => loadModules().then(() => { renderTabs(); renderView(); }) });
	const m = S.modules.modules.find((x) => x.name === name);
	if (!m) return s.close();
	s.setHead(moduleLabel(m.name), m.name);
	const parts = [];
	if (m.image) {
		const hero = h("div", { class: "hero" });
		hero.style.backgroundImage = `url("${(S.catalog && S.catalog.imageBase) || "https://modules.magicmirror.builders/images/"}${encodeURIComponent(m.image)}")`;
		parts.push(hero);
	}
	if (m.description) parts.push(h("div", { style: "margin:0 4px 10px" }, m.description));
	const meta = h("div", { class: "meta" });
	if (m.version) meta.append(h("span", { class: "pill" }, `${t("modules.version")} ${m.version}`));
	if (m.commit) meta.append(h("span", { class: "pill" }, m.commit));
	meta.append(h("span", { class: "pill" }, m.used ? t("modules.used") : t("modules.unused")));
	if (m.update && m.update.localChanges) meta.append(h("span", { class: "pill warn" }, t("modules.localChanges")));
	if (m.archived) meta.append(h("span", { class: "pill warn" }, t("modules.archived")));
	parts.push(meta);
	if (m.update && m.update.behind > 0) {
		parts.push(h("div", { class: "section-title" }, `${t("modules.whatsNew")} · ${t("modules.behind", { n: m.update.behind })}`));
		parts.push(h("div", { class: "card" }, m.update.commits.slice(0, 8).map((c) => h("div", { class: "row small" }, c))));
		parts.push(h("button", { class: "btn primary block", style: "margin-top:12px", onclick: async () => {
			const job = await guard(() => api("POST", `/api/modules/${encodeURIComponent(name)}/update`));
			if (job) { s.close(); jobSheet(job); }
		} }, t("modules.updateNow")));
	}
	if (m.update && m.update.error) parts.push(h("div", { class: "note bad" }, m.update.error));
	const actions = h(
		"div",
		{ class: "card", style: "margin-top:18px" },
		m.remote ? h("a", { class: "row", href: m.remote.replace(/\.git$/, ""), target: "_blank", rel: "noopener" }, h("span", { class: "grow" }, t("modules.repo")), icon("chev")) : null,
		m.valid ? h("button", { class: "row", onclick: () => { s.close(); addModuleTo(name); } }, h("span", { class: "grow" }, t("modules.addToMirror"))) : null,
		h("button", { class: "row", style: m.used ? "color:var(--faint)" : "color:var(--bad)", onclick: () => uninstall(m, s) }, h("div", { class: "grow" }, h("div", {}, t("modules.uninstall")), m.used ? h("div", { class: "sub" }, t("modules.uninstallHint")) : null))
	);
	parts.push(actions);
	fill(s.body, ...parts);
}

function addModuleTo(name) {
	const s = openSheet({ onClose: () => render() });
	s.setHead(moduleLabel(name), t("add.where"));
	s.body.append(
		picker(null, async (pos) => {
			const res = await guard(() => api("POST", "/api/op", { op: "add", module: name, position: pos }));
			if (res) {
				S.state = res;
				s.close();
				toast(t("chg.add", { m: moduleLabel(name) }));
			}
		})
	);
}

async function uninstall(m, sheet) {
	if (m.used) return toast(t("modules.uninstallHint"));
	if (!(await confirmSheet(t("modules.uninstallConfirm", { name: m.name }), t("modules.uninstall"), true))) return;
	const job = await guard(() => api("POST", `/api/modules/${encodeURIComponent(m.name)}/uninstall`));
	if (job) {
		sheet.close();
		jobSheet(job);
	}
}

// ---------- catalog ----------

async function catalogSheet() {
	const s = openSheet({ onClose: () => S.tab === "modules" && loadModules().then(renderView) });
	s.setHead(t("catalog.title"));
	let query = "";
	let cat = null;
	let limit = 40;
	const input = h("input", { type: "search", placeholder: t("catalog.search"), autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
	const cats = h("div", { class: "cats" });
	const list = h("div");
	s.body.append(h("div", { class: "search" }, input, cats), list);
	list.append(h("div", { class: "empty" }, t("catalog.loading")));

	if (!S.catalog || !S.catalog.modules.length) S.catalog = await guard(() => api("GET", "/api/catalog"));
	if (!S.modules) await loadModules();
	if (!S.catalog) return;
	const installed = new Set((S.modules ? S.modules.modules : []).map((m) => m.name));

	const counts = {};
	for (const m of S.catalog.modules) counts[m.category] = (counts[m.category] || 0) + 1;
	const categories = Object.keys(counts).filter(Boolean).sort((a, b) => counts[b] - counts[a]);

	const drawCats = () =>
		fill(cats, 
			h("button", { class: !cat ? "sel" : "", onclick: () => { cat = null; limit = 40; drawCats(); drawList(); } }, t("catalog.all")),
			...categories.map((c) => h("button", { class: cat === c ? "sel" : "", onclick: () => { cat = c; limit = 40; drawCats(); drawList(); } }, c))
		);

	const score = (m, q) => {
		const name = m.name.toLowerCase();
		if (!q) return 0;
		if (name === q || name === `mmm-${q}`) return 100;
		if (name.includes(q)) return 50;
		if ((m.tags || []).some((tag) => tag.toLowerCase().includes(q))) return 20;
		if ((m.description || "").toLowerCase().includes(q)) return 10;
		if ((m.maintainer || "").toLowerCase().includes(q)) return 5;
		return -1;
	};

	const drawList = () => {
		const q = query.trim().toLowerCase();
		const hits = S.catalog.modules
			.filter((m) => !cat || m.category === cat)
			.map((m) => [m, score(m, q)])
			.filter(([, sc]) => sc >= 0)
			.sort((a, b) => b[1] - a[1] || (a[0].archived - b[0].archived) || b[0].stars - a[0].stars)
			.map(([m]) => m);
		const rows = hits.slice(0, limit).map((m) =>
			h(
				"button",
				{ class: "row", onclick: () => catalogDetail(m, installed.has(m.name), s) },
				thumb(m.name, m.image),
				h("div", { class: "grow" }, h("div", { class: "title" }, m.name), h("div", { class: "sub wrap" }, m.description || "")),
				installed.has(m.name) ? h("span", { class: "pill accent" }, t("catalog.installed")) : m.archived ? h("span", { class: "pill warn" }, t("modules.archived")) : h("span", { class: "small muted" }, `★ ${m.stars}`)
			)
		);
		fill(list, 
			S.catalog.error ? h("div", { class: "note warn" }, t("catalog.offline")) : null,
			hits.length ? h("div", { class: "card" }, rows) : h("div", { class: "empty" }, t("catalog.empty")),
			hits.length > limit ? h("button", { class: "btn block ghost", style: "margin-top:8px", onclick: () => { limit += 60; drawList(); } }, t("catalog.more")) : null
		);
	};

	let deb;
	input.addEventListener("input", () => {
		clearTimeout(deb);
		deb = setTimeout(() => {
			query = input.value;
			limit = 40;
			drawList();
		}, 120);
	});
	drawCats();
	drawList();
}

function catalogDetail(m, isInstalled, parent) {
	const s = openSheet();
	s.setHead(m.name, m.maintainer);
	let pos = null;
	const draw = () => {
		const parts = [];
		if (m.image) {
			const hero = h("div", { class: "hero" });
			hero.style.backgroundImage = `url("${S.catalog.imageBase}${encodeURIComponent(m.image)}")`;
			parts.push(hero);
		}
		parts.push(h("div", { style: "margin:0 4px" }, m.description || ""));
		const meta = h("div", { class: "meta" }, h("span", { class: "pill" }, `★ ${m.stars}`), m.lastCommit ? h("span", { class: "pill" }, t("catalog.updated", { t: ago(m.lastCommit) })) : null, m.license ? h("span", { class: "pill" }, m.license) : null, m.category ? h("span", { class: "pill" }, m.category) : null);
		parts.push(meta);
		if (m.archived) parts.push(h("div", { class: "note warn" }, t("catalog.archivedWarn")));
		else if (m.lastCommit && Date.now() - new Date(m.lastCommit).getTime() > 730 * 86400000) parts.push(h("div", { class: "note warn" }, t("catalog.oldWarn")));
		parts.push(h("div", { class: "card" }, h("a", { class: "row", href: m.url, target: "_blank", rel: "noopener" }, h("span", { class: "grow" }, t("entry.readme")), icon("chev"))));
		if (!isInstalled) {
			parts.push(h("div", { class: "section-title" }, t("catalog.where")));
			parts.push(picker(pos, (p) => { pos = p; draw(); }));
			parts.push(
				h("button", {
					class: "btn primary block",
					style: "margin-top:14px",
					onclick: async () => {
						const job = await guard(() => api("POST", "/api/modules/install", { id: m.id, position: pos }));
						if (job) {
							s.close();
							parent.close();
							jobSheet(job);
						}
					}
				}, pos ? t("catalog.installShow") : t("catalog.install"))
			);
		}
		fill(s.body, ...parts);
	};
	draw();
}

// ---------- system view ----------

function systemView() {
	const st = S.status;
	const wrap = h("div");
	if (S.state.demo) wrap.append(h("div", { class: "note" }, t("system.demo")));

	const running = isRunning(st);
	const p = st && st.process;
	const sub = [];
	if (p && p.found && p.uptime && running) sub.push(t("system.uptime", { t: ago(p.uptime) }));
	if (p && !p.found) sub.push(p.error || t("system.notFound"));
	wrap.append(h("div", { class: "section-title" }, t("system.status")));
	wrap.append(
		h(
			"div",
			{ class: "card" },
			h("div", { class: "status-line" }, h("div", { class: `dot ${st ? (running ? "ok" : "bad") : ""}` }), h("div", { class: "grow" }, h("div", { class: "title", style: "font-weight:650" }, st ? (running ? t("system.running") : t("system.stopped")) : t("system.unknown")), sub.length ? h("div", { class: "sub small muted" }, sub.join(" · ")) : null), h("button", { class: "btn", onclick: restartMirror }, t("system.restart"))),
			st ? h("div", { class: "stat-grid" }, stat(t("system.version"), st.version ? `MagicMirror ${st.version}` : "–"), stat(t("system.process"), p && p.found ? p.name : "–"), stat(t("system.memory"), p && p.memory ? `${Math.round(p.memory / 1048576)} MB` : "–"), stat(t("system.restarts"), p && p.restarts !== undefined ? String(p.restarts) : "–")) : null
		)
	);

	// history
	const hist = h("div", { class: "card" }, h("div", { class: "empty" }, "…"));
	wrap.append(h("div", { class: "section-title" }, t("system.history")), hist);
	api("GET", "/api/history").then((r) => {
		if (!r.history.length) return fill(hist, h("div", { class: "empty" }, t("system.historyEmpty")));
		fill(hist, ...r.history.slice(0, 15).map(historyRow));
	}).catch(() => {});

	// log
	const logBox = h("div", { class: "log" }, "…");
	const det = h("details", { open: S.logsOpen }, h("summary", {}, t("system.logs")), logBox, h("button", { class: "btn ghost", onclick: () => loadLog(logBox) }, t("system.refresh")));
	det.addEventListener("toggle", () => {
		S.logsOpen = det.open;
		if (det.open) loadLog(logBox);
	});
	if (S.logsOpen) loadLog(logBox);
	wrap.append(h("div", { style: "margin-top:16px" }, det));

	wrap.append(h("div", { class: "card", style: "margin-top:16px" }, h("button", { class: "row", onclick: configSheet }, h("span", { class: "grow" }, t("system.config")), icon("chev"))));

	// language
	const langPref = store("lang") || "";
	const seg = h("div", { class: "seg" }, [["", t("system.langAuto")], ["de", "Deutsch"], ["en", "English"]].map(([v, label]) => h("button", { class: langPref === v ? "sel" : "", onclick: () => { store("lang", v); setLang(v); render(); } }, label)));
	wrap.append(h("div", { class: "card", style: "margin-top:16px" }, h("div", { class: "field" }, h("div", { class: "label" }, h("div", { class: "k" }, t("system.language"))), seg)));
	wrap.append(h("div", { class: "hint", style: "margin-top:22px" }, t("system.about", { v: S.state.version })));
	return wrap;
}

function stat(k, v) {
	return h("div", {}, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
}

async function loadLog(box) {
	const r = await guard(() => api("GET", "/api/logs"));
	if (!r) return;
	box.textContent = r.text !== undefined ? r.text || "–" : [r.out, r.err].filter(Boolean).join("\n\n— stderr —\n") || r.error || "–";
	box.scrollTop = box.scrollHeight;
}

function historyRow(entry) {
	const when = new Date(entry.time);
	const label = entry.kind === "restore" ? t("system.restored") : (entry.changes || []).slice(0, 2).map(changeText).join(", ") + ((entry.changes || []).length > 2 ? " …" : "");
	const res = entry.result && entry.result !== "ok" ? h("span", { class: `pill ${entry.result === "rolledBack" ? "warn" : ""}` }, t(`system.result.${entry.result}`)) : null;
	return h("button", { class: "row", onclick: () => historySheet(entry) }, h("div", { class: "grow" }, h("div", { class: "title", style: "font-weight:500" }, label || "config.js"), h("div", { class: "sub" }, `${when.toLocaleString(LANG === "de" ? "de-CH" : "en-GB", { dateStyle: "medium", timeStyle: "short" })}`)), res, h("span", { class: "chev", html: ICONS.chev }));
}

async function historySheet(entry) {
	const s = openSheet();
	const when = new Date(entry.time).toLocaleString(LANG === "de" ? "de-CH" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
	s.setHead(when);
	const r = await guard(() => api("GET", `/api/history/${encodeURIComponent(entry.id)}`));
	if (!r) return s.close();
	s.body.append(
		(entry.changes || []).length ? h("div", { class: "card" }, entry.changes.map((c) => h("div", { class: "row" }, changeText(c)))) : null,
		entry.reason ? h("div", { class: "note bad" }, entry.reason) : null,
		h("div", { class: "section-title" }, t("pending.diff")),
		h("div", { class: "diff" }, r.diff.length ? renderDiff(r.diff) : h("div", { class: "gap" }, "=")),
		h("button", {
			class: "btn primary block",
			style: "margin-top:16px",
			disabled: !r.diff.length,
			onclick: async () => {
				if (!(await confirmSheet(t("system.restoreConfirm", { t: when })))) return;
				const job = await guard(() => api("POST", `/api/history/${encodeURIComponent(entry.id)}/restore`));
				if (job) {
					s.close();
					jobSheet(job);
				}
			}
		}, t("system.restoreBefore"))
	);
}

async function restartMirror() {
	const job = await guard(() => api("POST", "/api/restart"));
	if (job) jobSheet(job, { onDone: loadStatus });
}

async function configSheet() {
	const s = openSheet();
	s.setHead("config.js", S.state.mm.configPath);
	const r = await guard(() => api("GET", "/api/config"));
	if (!r) return s.close();
	const ta = h("textarea", { class: "code big", spellcheck: "false", value: r.text });
	const msg = h("div", { hidden: true });
	s.body.append(
		h("div", { class: "small muted", style: "margin:0 4px 10px" }, t("system.configHint")),
		ta,
		msg,
		h(
			"div",
			{ class: "btn-row" },
			h("button", { class: "btn", onclick: () => s.close() }, t("common.cancel")),
			h("button", {
				class: "btn primary",
				onclick: async () => {
					const res = await guard(() => api("POST", "/api/config", { text: ta.value }));
					if (!res) return;
					if (!res.ok) {
						msg.className = "note bad";
						msg.textContent = res.errors.join("\n");
						msg.hidden = false;
						return;
					}
					S.state = res.state;
					render();
					s.close();
				}
			}, t("system.configCheck"))
		)
	);
}

// ---------- start ----------

// Resume a job that is still running (e.g. after reloading the page).
async function start() {
	await refresh();
	if (S.state && S.state.job) {
		const job = await api("GET", `/api/job/${S.state.job.id}`).catch(() => null);
		if (job) jobSheet(job);
	}
	loadStatus();
	setInterval(loadStatus, 15000);
	loadModules().then(() => {
		renderTabs();
		if (S.tab === "modules" && !document.querySelector(".sheet")) renderView();
	});
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && !document.querySelector(".sheet")) refresh();
	});
}

start();
