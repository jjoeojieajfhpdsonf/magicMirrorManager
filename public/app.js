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

// Grows a textarea with its content (up to 60 % of the screen).
function autosize(ta) {
	const fit = () => {
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight + 2, window.innerHeight * 0.6)}px`;
	};
	ta.addEventListener("input", fit);
	requestAnimationFrame(fit);
	return ta;
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
	eye: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8'><path d='M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z'/><circle cx='12' cy='12' r='2.8'/></svg>",
	sketch: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linejoin='round'><rect x='4' y='3' width='16' height='18' rx='3'/><rect x='7' y='6' width='5' height='3' rx='1'/><rect x='12' y='15' width='5' height='3' rx='1'/></svg>",
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
	if (res.status === 401 && data && data.login) {
		showLogin();
		throw new Error(data.error);
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
	view: "live",
	logsOpen: false
};

setLang(store("lang"));

// Laptop/desktop: mirror on the left, an inspector panel on the right instead of sheets.
const wideQuery = window.matchMedia("(min-width: 980px)");
const isWide = () => wideQuery.matches;
wideQuery.addEventListener("change", () => render());

// Called after every edit of the draft.
function applied(res, sent) {
	remapLive(sent, res);
	S.state = res;
	renderPending();
	refreshMirror();
}

// soft: only redraw when something actually changed (e.g. when coming back to the tab),
// so an open settings panel keeps its state.
async function refresh({ soft = false } = {}) {
	const st = await guard(() => api("GET", "/api/state"));
	if (!st) return;
	const same = soft && S.state && st.rev === S.state.rev && JSON.stringify(st.draft) === JSON.stringify(S.state.draft) && JSON.stringify(st.settings) === JSON.stringify(S.state.settings);
	S.state = st;
	if (st.settings) {
		S.landscape = st.settings.orientation === "landscape";
		S.view = st.settings.view || "live";
	}
	if (same) renderPending();
	else render();
}

async function loadModules() {
	const m = await guard(() => api("GET", "/api/modules"));
	if (m) S.modules = m;
	return S.modules;
}

async function loadStatus() {
	const st = await api("GET", "/api/status").catch(() => null);
	S.status = st;
	const startup = st && st.http ? st.http.startup : null;
	if (startup && LIVE.startup && startup !== LIVE.startup && isLive()) reloadPreview();
	if (startup) LIVE.startup = startup;
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
	if (p.from) p.from = dayLabel(p.from);
	if (p.until) p.until = dayLabel(p.until);
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
	if (tab === "system") {
		loadStatus();
		// look for a MagicMirror update once, if the background check hasn't run yet
		if (S.state && S.state.ok && !S.state.demo && !S.state.core) api("POST", "/api/mm/check").then(() => refresh({ soft: true })).catch(() => {});
	}
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
	if (S.state.preview && S.state.preview.health === "frozen" && !(await confirmSheet(t("pending.frozenConfirm"), t("pending.applyAnyway"), true))) return;
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
	const sub = e.disabled && e.schedule ? t("schedule.from", { d: dayLabel(e.schedule[0]) }) : e.header ? e.header : !e.installed && !e.disabled ? t("mirror.notInstalled") : null;
	return h("button", { class: cls.join(" "), "data-index": e.index, title: e.module }, moduleLabel(e.module), sub ? h("small", {}, sub) : null);
}

function mirrorView() {
	const st = S.state;
	if (st.parseError) return h("div", { class: "note bad" }, st.parseError);
	if (S.selected !== undefined && S.selected !== null && !st.entries[S.selected]) S.selected = null;
	const wrap = mirrorWrap();
	if (!isWide()) return wrap;
	const open = S.panel === "add" || (S.selected !== null && S.selected !== undefined);
	if (!open) {
		queueMicrotask(renderPending);
		return h("div", { class: "studio" }, h("div", { class: "stage" }, wrap));
	}
	const studio = h("div", { class: "studio has-panel" }, h("div", { class: "stage" }, wrap), inspectorShell());
	queueMicrotask(() => {
		fillInspector();
		renderPending();
	});
	return studio;
}

function inspectorShell() {
	return h("aside", { class: "inspector" }, h("div", { class: "inspector-main" }), h("div", { class: "inspector-foot" }));
}

// Opens the side panel (laptop) for a module or for adding one; null closes it.
// The mirror stays in place, so the live preview doesn't reload.
function showPanel(kind, index = null) {
	S.panel = kind;
	S.selected = kind === "entry" ? index : null;
	const studio = document.querySelector("#view .studio");
	if (!isWide() || !studio) return renderView();
	let insp = studio.querySelector(".inspector");
	if (kind && !insp) {
		insp = inspectorShell();
		studio.append(insp);
		studio.classList.add("has-panel");
	} else if (!kind && insp) {
		insp.remove();
		studio.classList.remove("has-panel");
	}
	refreshMirror();
	if (kind) fillInspector();
	renderPending();
}

function inspectorHost() {
	return document.querySelector(".inspector-main");
}

// Inspector content: the selected module or the "add" list.
function fillInspector(host = inspectorHost()) {
	if (!host || !host.isConnected) return;
	if (S.selected !== null && S.selected !== undefined && S.state.entries[S.selected]) return entrySheet(S.selected, host);
	if (S.panel === "add") return addSheet(null, host);
	showPanel(null);
}

// Re-draws the mirror (keeps the inspector as it is). The live preview is updated in place.
function refreshMirror() {
	const old = document.querySelector("#view .mirror-wrap");
	if (!old || S.tab !== "mirror") return;
	if (isLive() && old.querySelector(".mirror.live")) return updateLive(old);
	old.replaceWith(mirrorWrap());
}

function isLive() {
	const p = S.state && S.state.preview;
	// "pending" only blocks a fresh start (e.g. a reload after the page froze); a preview that
	// is already showing keeps running while its next version loads
	const pendingBlocks = p && p.health === "pending" && !(LIVE.box && LIVE.box.isConnected);
	return !!(p && S.view === "live" && !LIVE.failed && p.health !== "frozen" && !pendingBlocks);
}

function groupEntries(st) {
	const known = new Set(st.positions);
	const groups = {};
	for (const e of st.entries) {
		if (!e.module) continue;
		const pos = e.position && known.has(e.position) ? e.position : "";
		(groups[pos] = groups[pos] || []).push(e);
	}
	return groups;
}

function regionEl(pos, items, extraClass = "") {
	return h(
		"div",
		{ class: `region area-${pos || "none"} ${extraClass} ${items.length ? "" : "empty"}`, "data-pos": pos, "data-label": posLabel(pos || null) },
		extraClass ? h("div", { class: "tray-label" }, posLabel(pos || null)) : null,
		items.map(chip)
	);
}

// Rows next to/below the mirror: fullscreen, without position and (live) switched off.
function trayEl(st, groups, live) {
	const known = new Set(st.positions);
	const pick = (list) => (live ? list.filter((e) => !e.disabled) : list);
	const rows = ["fullscreen_above", "fullscreen_below"].filter((p) => known.has(p)).map((p) => regionEl(p, pick(groups[p] || []), "tray-region"));
	rows.push(regionEl("", pick(groups[""] || []), "tray-region"));
	if (live) {
		// filled by drawHits() once the preview has drawn its modules
		rows.push(h("div", { class: "region tray-region static hidden-row empty" }, h("div", { class: "tray-label" }, t("mirror.notVisible"))));
		const off = st.entries.filter((e) => e.module && e.disabled);
		if (off.length) rows.push(h("div", { class: "region tray-region static" }, h("div", { class: "tray-label" }, t("mirror.off")), off.map(chip)));
	}
	return h("div", { class: "tray" }, rows);
}

function footEl(st) {
	const liveLabel = t(S.view === "live" ? "mirror.sketch" : "mirror.live");
	return h(
		"div",
		{ class: "mirror-foot" },
		h("div", { class: "hint" }, LIVE.failed && S.view === "live" ? t("mirror.liveFailed") : st.preview && st.preview.health === "pending" && S.view === "live" ? t("mirror.checking") : st.entries.length ? t("mirror.dragHint") : t("mirror.empty")),
		h("button", { class: "btn", onclick: () => (isWide() ? showPanel("add") : addSheet()) }, icon("plus"), t("add.short")),
		st.preview ? h("button", { class: "icon-btn", "aria-label": liveLabel, title: liveLabel, onclick: toggleView }, icon(S.view === "live" ? "sketch" : "eye")) : null,
		h("button", { class: "icon-btn", "aria-label": t("mirror.rotate"), title: t("mirror.rotate"), onclick: toggleOrientation }, icon("rotate"))
	);
}

function mirrorWrap() {
	const st = S.state;
	const groups = groupEntries(st);
	const known = new Set(st.positions);
	const live = isLive();
	let mirror;
	if (live) {
		// Regions are only drop targets here.
		const regions = h("div", { class: "live-regions" }, MAIN_POSITIONS.filter((p) => known.has(p)).map((p) => regionEl(p, [])));
		mirror = h("div", { class: `mirror live${S.landscape ? " landscape" : ""}` }, liveFrame(), regions, h("div", { class: "live-hits" }));
	} else {
		mirror = h("div", { class: `mirror${S.landscape ? " landscape" : ""}` }, MAIN_POSITIONS.filter((p) => known.has(p)).map((p) => regionEl(p, groups[p] || [])));
	}
	const frozen = st.preview && st.preview.health === "frozen" && S.view === "live";
	const warn = frozen ? h("div", { class: "note bad frozen-note" }, t("mirror.frozen")) : null;
	const wrap = h("div", { class: `mirror-wrap${S.landscape ? " is-landscape" : ""}` }, h("div", { class: "mirror-col" }, warn, mirror, footEl(st)), trayEl(st, groups, live));
	// while the server finds out whether this draft freezes the preview, look again shortly
	if (!live && st.preview && st.preview.health === "pending" && S.view === "live") setTimeout(() => refresh({ soft: false }), 6000);
	setupDrag(wrap);
	if (live) queueMicrotask(() => updateLive(wrap, true));
	return wrap;
}

// ---------- live preview ----------

const LIVE = { box: null, cur: null, next: null, rev: null, layout: null, ready: false, started: 0, failed: false, timer: null, observer: null, scale: 1 };

function previewSize() {
	return S.landscape ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
}

function previewUrl() {
	const p = S.state.preview;
	// every page gets its own id, so the proxy can cut off pages from before a restart
	const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
	return `${location.protocol}//${location.hostname}:${p.port}${p.path || "/"}?mmm=${id}`;
}

function makeFrame() {
	const { w, h: ht } = previewSize();
	const fr = h("iframe", { class: "live-iframe", src: previewUrl(), tabindex: "-1", "aria-hidden": "true", title: "MagicMirror preview" });
	fr.style.width = `${w}px`;
	fr.style.height = `${ht}px`;
	fr.style.transform = `scale(${LIVE.scale})`;
	fr.map = loadedIndexes(S.state);
	return fr;
}

// MagicMirror numbers the modules that have a valid (or no) position: module_<n>_<name>.
// map[n] is the config entry drawn as module n in that frame.
function loadedIndexes(st) {
	const known = new Set(st.positions);
	return st.entries.filter((e) => e.module && (!e.position || known.has(e.position))).map((e) => e.index);
}

// Edits that shift entries also shift the numbering of the frames already loaded.
function remapLive(sent, res) {
	if (!sent) return;
	let fn = null;
	if (sent.op === "move" && typeof res.index === "number") {
		const from = sent.index;
		const to = res.index;
		fn = (v) => {
			if (v === from) return to;
			const x = v - (v > from ? 1 : 0);
			return x + (x >= to ? 1 : 0);
		};
	} else if (sent.op === "remove") {
		fn = (v) => (v === sent.index ? null : v > sent.index ? v - 1 : v);
	} else if (sent.op === "duplicate") {
		fn = (v) => (v > sent.index ? v + 1 : v);
	}
	if (!fn) return;
	for (const fr of [LIVE.cur, LIVE.next]) if (fr && fr.map) fr.map = fr.map.map((v) => (v === null ? null : fn(v)));
}

// Instant feedback: move or hide the module inside the preview that is already shown,
// while the page with the new config loads in the background.
function previewTell(msg, entryIndex, beforeIndex = null) {
	const fr = LIVE.cur;
	if (!isLive() || !fr || !fr.map || !fr.contentWindow) return;
	const id = fr.map.indexOf(entryIndex);
	if (id < 0) return;
	const before = beforeIndex === null || beforeIndex === undefined ? -1 : fr.map.indexOf(beforeIndex);
	fr.contentWindow.postMessage({ ...msg, mmmPreview: msg.type, id, before: before >= 0 ? before : null }, "*");
}

function liveFrame() {
	LIVE.box = h("div", { class: "live-frame" }, h("div", { class: "live-loading" }, h("span", { class: "spinner" }), t("mirror.loading")));
	LIVE.next = null;
	LIVE.layout = null;
	LIVE.ready = false;
	LIVE.started = Date.now();
	LIVE.rev = S.state.rev;
	LIVE.cur = makeFrame();
	LIVE.box.append(LIVE.cur);
	watchFirstLayout(LIVE.cur);
	return LIVE.box;
}

// If the preview never reports back, fall back to the sketch.
function watchFirstLayout(frame) {
	clearTimeout(LIVE.timer);
	LIVE.timer = setTimeout(() => {
		if (frame !== LIVE.cur || LIVE.ready) return;
		LIVE.failed = true;
		const old = document.querySelector("#view .mirror-wrap");
		if (old) old.replaceWith(mirrorWrap());
	}, 30000);
}

// Loads the changed config in a hidden second frame and swaps once it has drawn its modules.
function reloadPreview() {
	if (!LIVE.box || !LIVE.box.isConnected) return;
	if (LIVE.next) LIVE.next.remove();
	const fr = makeFrame();
	fr.classList.add("next");
	LIVE.next = fr;
	LIVE.box.append(fr);
	setTimeout(() => fr === LIVE.next && swapPreview(fr), 8000);
}

function swapPreview(fr) {
	if (LIVE.cur && LIVE.cur !== fr) LIVE.cur.remove();
	fr.classList.remove("next");
	LIVE.cur = fr;
	LIVE.next = null;
	LIVE.layout = null;
}

function scalePreview(wrap) {
	const mirror = wrap.querySelector(".mirror.live");
	if (!mirror || !LIVE.box) return;
	LIVE.scale = mirror.clientWidth / previewSize().w;
	for (const fr of LIVE.box.querySelectorAll("iframe")) fr.style.transform = `scale(${LIVE.scale})`;
	const regions = wrap.querySelector(".live-regions");
	if (regions) regions.style.setProperty("--pad", `${60 * LIVE.scale}px`);
	drawHits(wrap);
}

// Updates everything around the preview without reloading it (unless the config changed).
function updateLive(wrap, first = false) {
	const st = S.state;
	const mirror = wrap.querySelector(".mirror.live");
	if (!mirror) return;
	mirror.classList.toggle("landscape", S.landscape);
	wrap.classList.toggle("is-landscape", S.landscape);
	const { w, h: ht } = previewSize();
	for (const fr of LIVE.box.querySelectorAll("iframe")) {
		fr.style.width = `${w}px`;
		fr.style.height = `${ht}px`;
	}
	if (!first) {
		wrap.querySelector(".tray").replaceWith(trayEl(st, groupEntries(st), true));
		wrap.querySelector(".mirror-foot").replaceWith(footEl(st));
		if (st.rev !== LIVE.rev) {
			LIVE.rev = st.rev;
			reloadPreview();
		}
	}
	if (!LIVE.observer) {
		LIVE.observer = new ResizeObserver(() => {
			const wr = document.querySelector("#view .mirror-wrap");
			if (wr) scalePreview(wr);
		});
	}
	LIVE.observer.disconnect();
	LIVE.observer.observe(mirror);
	scalePreview(wrap);
}

// Click and drag targets on top of the modules the preview draws.
function drawHits(wrap) {
	const layer = wrap.querySelector(".live-hits");
	const hiddenRow = wrap.querySelector(".hidden-row");
	if (!layer) return;
	if (!LIVE.ready) {
		fill(layer);
		return;
	}
	const st = S.state;
	const known = new Set(st.positions);
	const map = (LIVE.cur && LIVE.cur.map) || [];
	const rects = new Map();
	// Modules fade out for a moment when they change content (e.g. compliments). Keep their
	// last place for a few seconds instead of treating them as "not visible".
	const seen = LIVE.cur ? (LIVE.cur.seen = LIVE.cur.seen || new Map()) : new Map();
	const now = Date.now();
	for (const m of (LIVE.layout && LIVE.layout.modules) || []) {
		if (!m.hidden && m.w > 0 && m.h > 0) seen.set(m.i, { rect: m, at: now });
	}
	for (const [i, v] of seen) {
		const e = st.entries[map[i]];
		if (e && now - v.at < 5000) rects.set(e.index, v.rect);
	}
	const sc = LIVE.scale || 1;
	const hits = [];
	const missing = [];
	for (const e of st.entries) {
		if (!e.module || e.disabled || !e.position || !MAIN_POSITIONS.includes(e.position)) continue;
		const r = rects.get(e.index);
		if (!r) {
			missing.push(e);
			continue;
		}
		const hit = h("button", { class: `hit${isWide() && S.selected === e.index ? " sel" : ""}`, "data-index": e.index, "data-pos": e.position, "aria-label": moduleLabel(e.module) }, h("span", { class: "tag" }, moduleLabel(e.module)));
		hit.style.left = `${r.x * sc}px`;
		hit.style.top = `${r.y * sc}px`;
		hit.style.width = `${Math.max(r.w * sc, 24)}px`;
		hit.style.height = `${Math.max(r.h * sc, 18)}px`;
		hits.push(hit);
	}
	fill(layer, hits);
	// modules that draw nothing right now (e.g. update notification) stay reachable next to the mirror
	if (hiddenRow) {
		fill(hiddenRow, h("div", { class: "tray-label" }, t("mirror.notVisible")), missing.map(chip));
		hiddenRow.classList.toggle("empty", !missing.length);
	}
}

function setReady() {
	LIVE.ready = true;
	if (LIVE.box) LIVE.box.classList.add("ready");
}

window.addEventListener("message", (ev) => {
	const d = ev.data;
	if (!d || d.mmmPreview !== "layout") return;
	if (LIVE.next && ev.source === LIVE.next.contentWindow) {
		const fr = LIVE.next;
		if (d.modules.length && !fr.settling) {
			fr.settling = true;
			setTimeout(() => fr === LIVE.next && swapPreview(fr), 1500);
		}
		return;
	} else if (!LIVE.cur || ev.source !== LIVE.cur.contentWindow) return;
	LIVE.layout = d;
	// The first reports come before MagicMirror has created its modules.
	if (!LIVE.ready && (d.modules.length || Date.now() - LIVE.started > 8000)) setReady();
	const wrap = document.querySelector("#view .mirror-wrap");
	if (wrap && !wrap.classList.contains("dragging")) drawHits(wrap);
});

function toggleView() {
	S.view = S.view === "live" ? "sketch" : "live";
	LIVE.failed = false;
	const old = document.querySelector("#view .mirror-wrap");
	if (old) old.replaceWith(mirrorWrap());
	guard(() => api("POST", "/api/settings", { view: S.view }));
}

function toggleOrientation() {
	S.landscape = !S.landscape;
	const old = document.querySelector("#view .mirror-wrap");
	if (old && isLive() && old.querySelector(".mirror.live")) updateLive(old, true);
	else refreshMirror();
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
		root.querySelectorAll(".drop-before").forEach((l) => l.classList.remove("drop-before"));
	};

	const start = () => {
		if (!pending) return;
		const src = pending.chip;
		const entry = S.state.entries[Number(src.dataset.index)];
		const ghost = h("div", { class: "chip drag-ghost" }, moduleLabel(entry && entry.module));
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
		if (reg.classList.contains("static")) {
			drag.target = null;
			return;
		}
		reg.classList.add("over");
		const inLive = !!reg.closest(".live-regions");
		const liveHits = inLive ? [...root.querySelectorAll(".hit")].filter((c) => c.dataset.pos === reg.dataset.pos) : [];
		const chips = liveHits.concat([...reg.querySelectorAll(".chip")]).filter((c) => c !== drag.src);
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
		if (inLive) {
			if (before) before.classList.add("drop-before");
		} else if (!horizontal) {
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
		previewTell({ type: "move", position: d.target.position }, d.index, d.target.before);
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
		applied(res, { op: "move", index: d.index });
		if (isWide() && S.selected === res.index) fillInspector();
	};

	root.addEventListener("pointerdown", (ev) => {
		const c = ev.target.closest(".chip, .hit");
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
		if (ev.target.closest(".chip, .hit")) ev.preventDefault();
	});
	root.addEventListener("click", (ev) => {
		const c = ev.target.closest(".chip, .hit");
		if (!c) {
			if (isWide() && S.panel && ev.target.closest(".mirror")) showPanel(null);
			return;
		}
		if (suppressClick) return;
		const index = Number(c.dataset.index);
		if (isWide()) showPanel(S.selected === index && S.panel === "entry" ? null : "entry", index);
		else entrySheet(index);
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
		s.sheet.classList.add("confirm");
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
		? openPanel(host, { onClose: () => showPanel(null) })
		: openSheet({ onClose: () => render() });
	let d = null;
	let idx = index;
	let moreOpen = false;
	const openForms = new Set();

	async function load() {
		d = await guard(() => api("GET", `/api/entry/${idx}`));
		if (!d) return s.close();
		draw();
	}

	async function op(body, { reload = true } = {}) {
		const sent = { index: idx, module: d.module, ...body };
		if (body.op === "move") previewTell({ type: "move", position: body.position || null }, idx);
		if (body.op === "toggle") previewTell({ type: "hide", hidden: body.disabled }, idx);
		// title and settings: show them in the preview right away
		if (body.op === "setHeader") previewTell({ type: "config", header: body.header }, idx);
		if (body.op === "setOption" && body.value !== undefined) previewTell({ type: "config", patch: { [body.key]: body.value } }, idx);
		if (body.op === "resetOption") previewTell({ type: "config", reset: [body.key] }, idx);
		const res = await guard(() => api("POST", "/api/op", sent));
		if (!res) return false;
		if (typeof res.index === "number") idx = res.index;
		if (host) {
			S.selected = idx;
			S.panel = "entry";
		}
		applied(res, sent);
		if (reload) await load();
		return true;
	}

	function draw() {
		const entry = S.state.entries[idx] || {};
		const sw = h("label", { class: "switch", title: t("entry.on") }, h("input", { type: "checkbox", checked: !d.disabled, onchange: async (e) => {
			const on = e.target.checked;
			// a date window would switch it off again within the hour
			if (on && d.schedule && !inWindowToday(d.schedule)) {
				const range = `${dayLabel(d.schedule[0])} – ${dayLabel(d.schedule[1])}`;
				if (!(await confirmSheet(t("schedule.onConfirm", { m: moduleLabel(d.module), range }), t("schedule.onAnyway")))) return draw();
				await op({ op: "clearSchedule" }, { reload: false });
			}
			op({ op: "toggle", disabled: !on });
		} }), h("span"));
		s.setHead(moduleLabel(d.module), d.module !== moduleLabel(d.module) ? d.module : null, sw);

		const parts = [];
		if (entry.installed === false) parts.push(h("div", { class: "note bad" }, t("mirror.notInstalled")));

		parts.push(h("div", { class: "section-title" }, t("entry.position")));
		parts.push(picker(d.position, (pos) => op({ op: "move", position: pos, before: null })));

		parts.push(h("div", { class: "section-title" }, t("entry.header")));
		parts.push(h("div", { class: "card" }, h("div", { class: "field" }, h("input", { class: "input wide", value: d.header, placeholder: t("entry.headerPh"), onchange: (e) => op({ op: "setHeader", header: e.target.value }) }))));

		parts.push(scheduleSection());
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

	// "Show only from … until …" every year
	function scheduleSection() {
		const wrap = h("div");
		wrap.append(h("div", { class: "section-title" }, t("schedule.title")));
		const on = !!d.schedule;
		const sw = h("label", { class: "switch" }, h("input", { type: "checkbox", checked: on, onchange: (e) => (e.target.checked ? op({ op: "setSchedule", from: "12-01", until: "02-28" }) : op({ op: "clearSchedule" })) }), h("span"));
		const card = h("div", { class: "card" }, h("div", { class: "field" }, h("div", { class: "label" }, h("div", { class: "k" }, t("schedule.only")), on ? null : h("div", { class: "d" }, t("schedule.hint"))), sw));
		if (on) {
			const [from, until] = d.schedule;
			const save = (f, u) => op({ op: "setSchedule", from: f, until: u });
			card.append(h("div", { class: "field" }, h("div", { class: "label" }, h("div", { class: "k" }, t("schedule.fromLabel"))), dateSelect(from, (v) => save(v, until))));
			card.append(h("div", { class: "field" }, h("div", { class: "label" }, h("div", { class: "k" }, t("schedule.untilLabel"))), dateSelect(until, (v) => save(from, v))));
		}
		wrap.append(card);
		return wrap;
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
			const label = set.length ? t("entry.more", { n: others.length }) : t("entry.all", { n: others.length });
			const list = h("div", { class: "card", style: "margin-top:8px", hidden: !moreOpen }, others.map(field));
			const toggle = h("button", { class: `row more-toggle${moreOpen ? " open" : ""}`, onclick: () => {
				moreOpen = !moreOpen;
				list.hidden = !moreOpen;
				toggle.classList.toggle("open", moreOpen);
			} }, h("span", { class: "grow" }, label), h("span", { class: "chev", html: ICONS.chev }));
			wrap.append(h("div", { class: "card", style: "margin-top:8px" }, toggle), list);
		}
		if (!defs.length && !set.length) wrap.append(h("div", { class: "note" }, t("entry.noDefaults")));
		wrap.append(customAdder());
		return wrap;
	}

	function summary(v) {
		if (Array.isArray(v)) return t(v.length === 1 ? "entry.item" : "entry.items", { n: v.length });
		if (v && typeof v === "object") return t(Object.keys(v).length === 1 ? "entry.field" : "entry.fields", { n: Object.keys(v).length });
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
		const setValue = async (value) => {
			if (def && def.simple && value === def.value) return isSet ? op({ op: "resetOption", key }) : undefined;
			if (typeof value === "number" && def && typeof def.value === "number" && Math.abs(value) > Math.max(100000, Math.abs(def.value) * 1000)) {
				if (!(await confirmSheet(t("entry.hugeConfirm", { key, value: value.toLocaleString(LANG === "de" ? "de-CH" : "en"), def: def.value }), t("entry.setAnyway"), true))) return draw();
			}
			return op({ op: "setOption", key, value });
		};
		if (type === "boolean") {
			return h("div", { class: `field${isSet ? " changed" : ""}` }, label, reset, h("label", { class: "switch" }, h("input", { type: "checkbox", checked: !!src.value, onchange: (e) => setValue(e.target.checked) }), h("span")));
		}
		const choices = def && def.choices;
		if (type === "string" && choices) {
			const custom = "__custom__";
			const cur = String(src.value);
			const options = choices.includes(cur) ? choices : [...choices, cur];
			const select = h(
				"select",
				{
					class: "input select",
					onchange: (e) => {
						if (e.target.value !== custom) return setValue(e.target.value);
						// switch to a text field for a value the list doesn't know
						const input = h("input", { class: "input text", value: cur, onchange: (ev) => setValue(ev.target.value) });
						select.replaceWith(input);
						input.focus();
					}
				},
				options.map((c) => h("option", { value: c, selected: c === cur }, c)),
				h("option", { value: custom }, t("entry.customValueOption"))
			);
			return h("div", { class: `field${isSet ? " changed" : ""}` }, label, reset, select);
		}
		if (type === "number" || type === "string") {
			const input = h("input", {
				class: `input ${type === "number" ? "num" : "text"}`,
				value: String(src.value),
				style: type === "number" ? numberWidth(src.value) : null,
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
		// complex value: a form for plain data, code only for functions and the like
		const box = h("div", { class: `field col${isSet ? " changed" : ""}` });
		if (src.data) {
			const isOpen = openForms.has(key);
			const sumBtn = h("button", { class: `value-sum${isOpen ? " open" : ""}`, onclick: () => {
				if (openForms.has(key)) openForms.delete(key);
				else openForms.add(key);
				draw();
			} }, summary(src.value));
			box.append(h("div", { class: "top-line" }, label, reset, sumBtn));
			if (isOpen) {
				const save = (v) => (def && def.data && sameData(v, def.value) ? op({ op: "resetOption", key }) : op({ op: "setOption", key, value: v }));
				const form = dataEditor(src.value, save, def && def.data ? def.value : undefined);
				if (form) box.append(h("div", { class: "form-wrap" }, form));
			}
			return box;
		}
		const sumBtn = h("button", { class: "value-sum", onclick: () => openEditor() }, src.dynamic ? t("entry.dynamic") : summary(src.value));
		box.append(h("div", { class: "top-line" }, label, reset, sumBtn));
		function openEditor() {
			const ta = autosize(h("textarea", { class: "code", spellcheck: "false", value: src.code }));
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
		const val = h("input", { class: "input wide", placeholder: t("entry.customValue"), spellcheck: "false" });
		const err = h("div", { class: "note bad", hidden: true });
		const add = h("button", {
			class: "btn",
			onclick: async () => {
				try {
					const res = await api("POST", "/api/op", { op: "setOption", index: idx, module: d.module, key: key.value.trim(), value: guessValue(val.value) });
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
	const s = host ? openPanel(host, { onClose: () => showPanel(null) }) : openSheet({ onClose: () => render() });
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
							S.state = res;
							showPanel("entry", res.entries.length - 1);
							renderPending();
						} else {
							S.state = res;
							s.close();
						}
					}
				},
				h("div", { class: "grow" }, h("div", { class: "title" }, moduleLabel(name))),
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
				if (st.key === "verify" && st.state === "running" && /^stable:\d+$/.test(detail)) detail = t("job.stable", { n: detail.split(":")[1] });
				if (j.type === "checkUpdates" && st.state === "done") detail = Number(detail) ? t("job.updatesFound", { n: detail }) : t("job.noUpdates");
				if (st.key === "pull" && detail === "same") detail = t("job.noUpdates");
				const ic = st.state === "done" ? icon("check") : st.state === "failed" ? icon("x") : null;
				return h("div", { class: `step st-${st.state}` }, h("div", { class: "ic" }, ic), h("div", { class: "grow" }, h("div", { class: "name" }, t(`step.${st.label}`)), detail ? h("div", { class: "detail" }, detail) : null));
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
		} catch (err) {
			if (s.closed) return;
			if (/Unknown job/.test(err.message)) {
				// the manager was restarted and has forgotten the job
				fill(s.body, h("div", { class: "note warn" }, t("job.lost")), h("button", { class: "btn block", style: "margin-top:14px", onclick: () => s.close() }, t("job.close")));
				refresh();
				return;
			}
			timer = setTimeout(poll, 1500);
			return;
		}
		if (s.closed) return;
		draw(j);
		if (j.status === "running") timer = setTimeout(poll, 700);
		else {
			refresh();
			loadStatus();
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
	if (j.type === "mmUpdate") text = r.upToDate ? t("job.noUpdates") : `MagicMirror ${r.from} → ${r.to}`;
	if (j.type === "untrash") text = t("trash.restored");
	if (j.type === "checkUpdates") text = r.available ? t("job.updatesFound", { n: r.available }) : t("job.noUpdates");
	const warnings = (r.warnings || []).filter(Boolean);
	return block(r.notRestarted ? "warn" : "ok", "check", t("job.done"), text, warnings.length ? h("details", {}, h("summary", {}, t("job.warnings")), h("div", { class: "log" }, warnings.join("\n"))) : null);
}

// ---------- modules view ----------

function modulesView() {
	const m = S.modules;
	const wrap = h("div");
	wrap.append(
		h("button", { class: "btn primary block", style: "margin-top:4px", onclick: () => catalogSheet() }, icon("plus"), t("modules.find"))
	);
	if (!m) return wrap;
	wrap.append(seasonSection());
	const withUpdate = m.modules.filter((x) => x.update && x.update.behind > 0);
	wrap.append(
		h(
			"div",
			{ class: "section-title" },
			h("span", {}, `${t("modules.installed")} · ${m.checking ? t("modules.checking") : m.checked ? t("modules.checked", { t: ago(m.checked) }) : t("modules.never")}`),
			withUpdate.length > 1 ? h("button", { onclick: () => updateAll(withUpdate.map((x) => x.name)) }, t("modules.updateAll")) : h("button", { onclick: checkUpdates, disabled: !!m.checking }, t("modules.checkNow"))
		)
	);
	if (!m.modules.length) {
		wrap.append(h("div", { class: "card" }, h("div", { class: "empty" }, t("modules.none"))));
		return wrap;
	}
	const sorted = [...m.modules].sort((a, b) => (b.update && b.update.behind ? 1 : 0) - (a.update && a.update.behind ? 1 : 0));
	wrap.append(h("div", { class: "card" }, sorted.map(moduleRow)));
	wrap.append(trashSection());
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

// "Fits the season": events on now or soon, with installed and new modules for them.
function seasonSection() {
	const box = h("div");
	api("GET", "/api/suggestions")
		.then((r) => {
			const rows = [];
			for (const ev of r.events) {
				const range = `${dayLabel(ev.from)} – ${dayLabel(ev.until)}`;
				const head = h("div", { class: "season-head" }, h("span", { class: "title" }, t(`season.${ev.id}`)), h("span", { class: "sub small muted" }, ev.active ? range : t("season.soon", { n: ev.inDays, range })));
				const items = [];
				// "Halloween" under "Halloween" says the same twice: call it "your module" then
				const nameFor = (module) => (moduleLabel(module).toLowerCase() === t(`season.${ev.id}`).toLowerCase() ? t("season.yourModule") : moduleLabel(module));
				// on the mirror already: offer the window (or show it)
				for (const e of ev.used) {
					const scheduled = e.schedule && e.schedule.join() === [ev.from, ev.until].join();
					items.push(h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, nameFor(e.module)), h("div", { class: "sub" }, scheduled ? t("season.scheduled", { range }) : e.disabled ? t("season.off") : t("modules.used"))),
						scheduled ? null : h("button", { class: "btn", onclick: async () => {
							const res = await guard(() => api("POST", "/api/op", { op: "setSchedule", index: e.index, module: e.module, from: ev.from, until: ev.until }));
							if (res) {
								S.state = res;
								renderPending();
								toast(t("season.done", { m: moduleLabel(e.module), range }));
								renderView();
							}
						} }, t("season.setWindow"))));
				}
				// installed, but not on the mirror
				for (const name of ev.idle) {
					items.push(h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, nameFor(name)), h("div", { class: "sub" }, t("modules.unused"))),
						h("button", { class: "btn", onclick: async () => {
							let res = await guard(() => api("POST", "/api/op", { op: "add", module: name, position: "fullscreen_above" }));
							if (!res) return;
							res = await guard(() => api("POST", "/api/op", { op: "setSchedule", index: res.entries.length - 1, module: name, from: ev.from, until: ev.until }));
							if (res) {
								S.state = res;
								renderPending();
								toast(t("season.done", { m: moduleLabel(name), range }));
								renderView();
							}
						} }, t("season.add"))));
				}
				// from the official list
				for (const c of ev.catalog) {
					items.push(h("button", { class: "row", onclick: () => catalogDetail(c, false, null, { schedule: [ev.from, ev.until], label: t(`season.${ev.id}`) }) }, thumb(c.name, c.image), h("div", { class: "grow" }, h("div", { class: "title" }, c.name), h("div", { class: "sub" }, c.description || "")), h("span", { class: "small muted" }, `★ ${c.stars}`)));
				}
				rows.push(h("div", { class: "card season" }, head, items));
			}
			const planned = S.state.entries.filter((e) => e.module && e.schedule);
			if (planned.length) {
				rows.push(h("div", { class: "card season" }, h("div", { class: "season-head" }, h("span", { class: "title" }, t("season.planned"))),
					planned.map((e) => {
						const range = `${dayLabel(e.schedule[0])} – ${dayLabel(e.schedule[1])}`;
						const active = inWindowToday(e.schedule);
						return h("button", { class: "row", onclick: () => openOnMirror(e.module) }, h("div", { class: "grow" }, h("div", { class: "title" }, moduleLabel(e.module)), h("div", { class: "sub" }, `${range} · ${active ? t("season.activeNow") : t("schedule.from", { d: dayLabel(e.schedule[0]) })}`)), icon("chev"));
					})));
			}
			if (!rows.length) return;
			fill(box, h("div", { class: "section-title" }, t("season.title")), rows);
		})
		.catch(() => {});
	return box;
}

// Uninstalled modules wait in the manager's trash (the last 10).
function trashSection() {
	const box = h("div");
	api("GET", "/api/trash")
		.then((r) => {
			if (!r.items.length) return;
			const when = (s) => {
				const [d, tm] = s.split("_");
				return new Date(`${d}T${tm.replace(/-/g, ":")}`).toLocaleString(LANG === "de" ? "de-CH" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
			};
			const list = h("div", { class: "card", hidden: true }, r.items.map((it) =>
				h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, moduleLabel(it.name)), h("div", { class: "sub" }, when(it.time))),
					h("button", { class: "btn", onclick: async () => {
						const job = await guard(() => api("POST", `/api/trash/${encodeURIComponent(it.id)}/restore`));
						if (job) jobSheet(job);
					} }, t("trash.restore")),
					h("button", { class: "icon-btn trash-del", title: t("trash.delete"), "aria-label": t("trash.delete"), onclick: async () => {
						if (!(await confirmSheet(t("trash.deleteConfirm", { name: moduleLabel(it.name) }), t("trash.delete"), true))) return;
						if (await guard(() => api("POST", `/api/trash/${encodeURIComponent(it.id)}/delete`))) renderView();
					} }, icon("close")))
			));
			const toggle = h("button", { class: "row more-toggle", onclick: () => {
				list.hidden = !list.hidden;
				toggle.classList.toggle("open", !list.hidden);
			} }, h("span", { class: "grow" }, t("trash.title", { n: r.items.length })), h("span", { class: "chev", html: ICONS.chev }));
			fill(box, h("div", { class: "card", style: "margin-top:16px" }, toggle), h("div", { style: "margin-top:8px" }, list));
		})
		.catch(() => {});
	return box;
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
	if (m.previous) {
		parts.push(
			h("div", { class: "card", style: "margin-top:12px" }, h("button", { class: "row", onclick: async () => {
				if (!(await confirmSheet(t("modules.revertConfirm", { name: m.name, v: m.previous.version || m.previous.commit || "" }), t("modules.revert")))) return;
				const job = await guard(() => api("POST", `/api/modules/${encodeURIComponent(name)}/revert`));
				if (job) {
					s.close();
					jobSheet(job);
				}
			} }, h("div", { class: "grow" }, h("div", {}, t("modules.revert")), h("div", { class: "sub" }, [m.previous.version, m.previous.commit].filter(Boolean).join(" · "))), icon("undo")))
		);
	}
	const actions = h(
		"div",
		{ class: "card", style: "margin-top:18px" },
		m.remote ? h("a", { class: "row", href: m.remote.replace(/\.git$/, ""), target: "_blank", rel: "noopener" }, h("span", { class: "grow" }, t("modules.repo")), icon("chev")) : null,
		// already on the mirror: open it there (a second entry: "Duplicate" in its panel)
		m.used
			? h("button", { class: "row", onclick: () => { s.close(); openOnMirror(name); } }, h("span", { class: "grow" }, t("modules.editOnMirror")), icon("chev"))
			: m.valid ? h("button", { class: "row", onclick: () => { s.close(); addModuleTo(name); } }, h("span", { class: "grow" }, t("modules.addToMirror"))) : null,
		h("button", { class: "row", style: m.used ? "color:var(--faint)" : "color:var(--bad)", onclick: () => uninstall(m, s) }, h("div", { class: "grow" }, h("div", {}, t("modules.uninstall")), m.used ? h("div", { class: "sub" }, t("modules.uninstallHint")) : null))
	);
	parts.push(actions);
	fill(s.body, ...parts);
}

function openOnMirror(name) {
	const index = S.state.entries.findIndex((e) => e.module === name);
	switchTab("mirror");
	if (index < 0) return;
	if (isWide()) showPanel("entry", index);
	else entrySheet(index);
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
	const input = h("input", { type: "search", placeholder: t("catalog.searchHint"), autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
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
			urlInstallRow(query.trim(), s),
			hits.length ? h("div", { class: "card" }, rows) : /^https:\/\//i.test(query.trim()) ? null : h("div", { class: "empty" }, t("catalog.empty")),
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

// A module that isn't in the official list: install it straight from its repository address.
function urlInstallRow(text, sheet) {
	const m = /^https:\/\/[\w.-]+(?::\d+)?\/[\w.~-]+\/([\w.~-]+?)(?:\.git)?\/?$/i.exec(text);
	if (!m) return null;
	const name = m[1];
	return h(
		"div",
		{ class: "card", style: "margin-bottom:10px" },
		h("button", { class: "row", onclick: () => catalogDetail({ name, url: text.replace(/\/$/, ""), description: t("catalog.fromUrl"), stars: 0, fromUrl: true }, (S.modules ? S.modules.modules : []).some((x) => x.name === name), sheet) },
			thumb(name, null),
			h("div", { class: "grow" }, h("div", { class: "title" }, t("catalog.installUrl", { name })), h("div", { class: "sub" }, text)),
			icon("chev"))
	);
}

function catalogDetail(m, isInstalled, parent, season = null) {
	const s = openSheet();
	s.setHead(m.name, m.maintainer);
	let pos = season ? "fullscreen_above" : null;
	let useSchedule = !!season;
	const draw = () => {
		const parts = [];
		if (m.image) {
			const hero = h("div", { class: "hero" });
			hero.style.backgroundImage = `url("${(S.catalog && S.catalog.imageBase) || "https://modules.magicmirror.builders/images/"}${encodeURIComponent(m.image)}")`;
			parts.push(hero);
		}
		parts.push(h("div", { style: "margin:0 4px" }, m.description || ""));
		const meta = m.fromUrl ? null : h("div", { class: "meta" }, h("span", { class: "pill" }, `★ ${m.stars}`), m.lastCommit ? h("span", { class: "pill" }, t("catalog.updated", { t: ago(m.lastCommit) })) : null, m.license ? h("span", { class: "pill" }, m.license) : null, m.category ? h("span", { class: "pill" }, m.category) : null);
		parts.push(meta);
		if (m.archived) parts.push(h("div", { class: "note warn" }, t("catalog.archivedWarn")));
		else if (m.lastCommit && Date.now() - new Date(m.lastCommit).getTime() > 730 * 86400000) parts.push(h("div", { class: "note warn" }, t("catalog.oldWarn")));
		parts.push(h("div", { class: "card" }, h("a", { class: "row", href: m.url, target: "_blank", rel: "noopener" }, h("span", { class: "grow" }, t("entry.readme")), icon("chev"))));
		if (!isInstalled) {
			parts.push(h("div", { class: "section-title" }, t("catalog.where")));
			parts.push(picker(pos, (p) => { pos = p; draw(); }));
			if (season) {
				parts.push(h("div", { class: "card", style: "margin-top:12px" }, h("div", { class: "field" }, h("div", { class: "label" }, h("div", { class: "k" }, t("schedule.only")), h("div", { class: "d" }, `${season.label}: ${dayLabel(season.schedule[0])} – ${dayLabel(season.schedule[1])}`)), h("label", { class: "switch" }, h("input", { type: "checkbox", checked: useSchedule, onchange: (e) => (useSchedule = e.target.checked) }), h("span")))));
			}
			parts.push(
				h("button", {
					class: "btn primary block",
					style: "margin-top:14px",
					onclick: async () => {
						const job = await guard(() => api("POST", "/api/modules/install", m.fromUrl ? { url: m.url, name: m.name, position: pos } : { id: m.id, position: pos, schedule: season && useSchedule ? season.schedule : null }));
						if (job) {
							s.close();
							if (parent) parent.close();
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
			h("div", { class: "status-line" }, h("div", { class: `dot ${st ? (running ? "ok" : "bad") : ""}` }), h("div", { class: "grow" }, h("div", { class: "title", style: "font-weight:650" }, st ? (running ? t("system.running") : t("system.stopped")) : t("system.unknown")), sub.length ? h("div", { class: "sub small muted" }, sub.join(" · ")) : null), h("button", { class: "btn", onclick: restartMirror, disabled: !!S.restarting }, S.restarting ? t("system.restarting", { n: S.restarting.sec || "" }).trim() : t("system.restart"))),
			S.restartError ? h("div", { class: "note bad", style: "margin:0 16px 14px" }, S.restartError) : null,
			coreUpdateRow(),
			st ? h("div", { class: "stat-grid" }, stat(t("system.version"), st.version ? `MagicMirror ${st.version}` : "–"), stat(t("system.process"), p && p.found ? p.name : "–"), stat(t("system.restarts"), p && p.restarts !== undefined ? String(p.restarts) : "–")) : null
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
	if (S.state.auth) wrap.append(h("div", { class: "card", style: "margin-top:16px" }, h("button", { class: "row", onclick: logout }, h("span", { class: "grow" }, t("login.logout")))));
	wrap.append(h("div", { class: "hint", style: "margin-top:22px" }, t("system.about", { v: S.state.version })));
	return wrap;
}

// "MagicMirror 2.38 available" with an update button (after the background check).
function coreUpdateRow() {
	const c = S.state.core;
	if (!c || !c.behind) return null;
	const blocked = !c.nodeOk ? t("core.node", { node: c.node, have: c.nodeVersion }) : c.blocking && c.blocking.length ? t("core.changed", { files: c.blocking.join(", ") }) : null;
	return h(
		"div",
		{ class: "core-update" },
		h("div", { class: "grow" }, h("div", { class: "title" }, t("core.available", { v: c.version || "?" })), h("div", { class: "sub small muted" }, blocked || t("core.hint"))),
		h("button", { class: "btn primary", disabled: !!blocked, onclick: async () => {
			if (!(await confirmSheet(t("core.confirm", { from: c.current, to: c.version }), t("core.update")))) return;
			const job = await guard(() => api("POST", "/api/mm/update"));
			if (job) jobSheet(job, { onDone: loadStatus });
		} }, t("core.update"))
	);
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

// Restart right from the status card; no extra window.
async function restartMirror() {
	const job = await guard(() => api("POST", "/api/restart"));
	if (!job) return;
	S.restarting = { sec: 0 };
	S.restartError = null;
	const redraw = () => S.tab === "system" && !document.querySelector(".sheet") && renderView();
	redraw();
	for (;;) {
		await new Promise((r) => setTimeout(r, 800));
		let j;
		try {
			j = await api("GET", `/api/job/${job.id}`);
		} catch {
			continue;
		}
		const verify = j.steps.find((x) => x.key === "verify");
		S.restarting.sec = verify && /^\d+$/.test(verify.detail) ? verify.detail : "";
		if (j.status === "running") {
			redraw();
			continue;
		}
		S.restarting = null;
		if (j.status === "done") toast(t("system.restarted"));
		if (isLive()) reloadPreview();
		else S.restartError = (j.result && j.result.reason) || j.error || t("job.failed");
		await loadStatus();
		redraw();
		return;
	}
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

// Is today inside a yearly window ["MM-DD", "MM-DD"]?
function inWindowToday([from, until]) {
	const d = new Date();
	const x = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return from <= until ? x >= from && x <= until : x >= from || x <= until;
}

// "12-01" -> "1. Dez." / "Dec 1"
function dayLabel(mmdd) {
	const [m, d] = mmdd.split("-").map(Number);
	return new Date(2000, m - 1, d).toLocaleDateString(LANG === "de" ? "de-CH" : "en-GB", { day: "numeric", month: "short" });
}

// Day and month pickers for a yearly date ("MM-DD").
function dateSelect(mmdd, onChange) {
	const [m, d] = mmdd.split("-").map(Number);
	const day = h("select", { class: "input select date-day" }, Array.from({ length: 31 }, (_, i) => h("option", { value: i + 1, selected: i + 1 === d }, String(i + 1))));
	const month = h("select", { class: "input select date-month" }, Array.from({ length: 12 }, (_, i) => h("option", { value: i + 1, selected: i + 1 === m }, new Date(2000, i, 1).toLocaleDateString(LANG === "de" ? "de-CH" : "en-GB", { month: "long" }))));
	const change = () => onChange(`${String(month.value).padStart(2, "0")}-${String(day.value).padStart(2, "0")}`);
	day.addEventListener("change", change);
	month.addEventListener("change", change);
	return h("div", { class: "date-select" }, day, month);
}

// Value typed into "custom setting": true/false, numbers, JSON lists/objects, else text.
function guessValue(text) {
	const v = String(text).trim();
	if (v === "true" || v === "false") return v === "true";
	if (v !== "" && Number.isFinite(Number(v))) return Number(v);
	if (/^[[{]/.test(v)) {
		try {
			return JSON.parse(v);
		} catch {
			// keep as text
		}
	}
	return v;
}

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !document.querySelector(".sheet") && isWide() && S.panel && S.tab === "mirror") showPanel(null);
});

// ---------- login (only when the manager runs with a password) ----------

function showLogin() {
	if (document.querySelector(".login")) return;
	const input = h("input", { class: "input wide", type: "password", autocomplete: "current-password", placeholder: t("login.password") });
	const err = h("div", { class: "note bad", hidden: true });
	const submit = async (e) => {
		e.preventDefault();
		const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: input.value }) });
		if (res.ok) return location.reload();
		const data = await res.json().catch(() => ({}));
		err.textContent = data.error || t("common.error");
		err.hidden = false;
		input.select();
	};
	document.body.append(
		h("div", { class: "login" }, h("form", { class: "login-card", onsubmit: submit }, h("img", { src: "icon.svg", alt: "", width: 56, height: 56 }), h("h2", {}, "MagicMirror Manager"), input, err, h("button", { class: "btn primary block", type: "submit" }, t("login.submit"))))
	);
	input.focus();
}

async function logout() {
	await fetch("/api/logout", { method: "POST" });
	location.reload();
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
		if (!document.hidden && !document.querySelector(".sheet")) refresh({ soft: true });
	});
}

start();
