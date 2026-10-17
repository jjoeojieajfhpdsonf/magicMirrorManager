"use strict";
// MagicMirror Manager – a small, dependency-free web app to manage MagicMirror² modules.
// It runs as its own process next to MagicMirror, so it keeps working when the mirror doesn't.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");

const { Mirror } = require("./lib/mirror");
const { Store } = require("./lib/store");
const { Jobs } = require("./lib/jobs");
const { Modules } = require("./lib/modules");
const { Catalog } = require("./lib/catalog");
const C = require("./lib/config");
const { diffLines } = require("./lib/diff");
const { readDefaults } = require("./lib/defaults");
const { UserError } = require("./lib/errors");
const { writeAtomic, readJSON, writeJSON } = require("./lib/util");
const { setupDemo } = require("./lib/demo");
const { Preview } = require("./lib/preview");
const { Auth } = require("./lib/auth");
const { Core } = require("./lib/core");
const seasons = require("./lib/seasons");

const PORT = Number(process.env.PORT) || 8090;
const PREVIEW_PORT = process.env.PREVIEW_PORT === "0" ? 0 : Number(process.env.PREVIEW_PORT) || PORT + 1;
const HOST = process.env.HOST || "0.0.0.0";
const DEMO = process.env.DEMO === "1";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC = path.join(__dirname, "public");
const VERSION = require("./package.json").version;

fs.mkdirSync(DATA_DIR, { recursive: true });
const mmDir = DEMO ? setupDemo(DATA_DIR) : process.env.MM_DIR || path.join(os.homedir(), "MagicMirror");

const mirror = new Mirror({
	mmDir,
	configPath: DEMO ? null : process.env.MM_CONFIG_FILE,
	pm2Bin: process.env.PM2_BIN,
	pm2Name: process.env.MM_PM2_NAME,
	restartCmd: process.env.MM_RESTART_CMD,
	mmUrl: process.env.MM_URL,
	startTimeout: Number(process.env.MM_START_TIMEOUT) * 1000 || undefined,
	demo: DEMO,
	selfDir: __dirname
});
const store = new Store(DATA_DIR);
const auth = new Auth(process.env.PASSWORD, DATA_DIR);
const jobs = new Jobs();
const modules = new Modules(mirror, DATA_DIR);
const catalog = new Catalog(DATA_DIR);
const core = new Core(mirror);

// ---------- manager settings (shared by all devices) ----------

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const settings = () => ({ orientation: "portrait", view: "live", ...readJSON(SETTINGS_FILE, {}) });

// ---------- working copy: the draft if there is one, otherwise config.js ----------

function working() {
	const current = mirror.readConfig();
	const hash = mirror.configHash(current);
	let draft = store.getDraft();
	// config.js was changed elsewhere (by hand, another tool): replay the collected steps on it
	if (draft && draft.base !== hash) draft = rebase(draft, current, hash);
	if (draft && draft.base === hash && draft.text !== current) return { text: draft.text, current, hash, draft };
	if (draft && draft.base !== hash) return { text: current, current, hash, draft: null, conflict: draft };
	return { text: current, current, hash, draft: null };
}

// Applies the draft's steps again on the new config. Returns the new draft, or the old one
// (= conflict) if a step no longer fits, e.g. because its module was removed meanwhile.
function rebase(draft, current, hash) {
	if (!Array.isArray(draft.ops) || !draft.ops.length) return draft;
	let text = current;
	const ops = [];
	try {
		for (const o0 of draft.ops) {
			const o = { ...o0 };
			if (typeof o.index === "number") {
				// the entry may sit elsewhere now: find it by its module name
				const entries = C.listEntries(text);
				if (!entries[o.index] || entries[o.index].module !== o.module) {
					const same = entries.filter((e) => e.module === o.module);
					if (same.length !== 1) throw new Error("ambiguous");
					o.index = same[0].index;
					if (o.op === "move") o.before = null;
				}
			}
			text = C.ops[o.op](text, o).text;
			ops.push(o);
		}
	} catch {
		return draft;
	}
	const next = { ...draft, base: hash, text, ops };
	if (text === current) store.clearDraft();
	else store.saveDraft(next);
	return text === current ? null : next;
}

// op: the step that led to `text` (kept so it can be replayed); null = not replayable (raw edit)
function saveWorking(w, text, change, op) {
	if (text === w.current) {
		store.clearDraft();
		return;
	}
	const changes = w.draft ? w.draft.changes.slice() : [];
	if (change) changes.push(change);
	const prevOps = w.draft ? w.draft.ops : [];
	const ops = op && Array.isArray(prevOps) ? [...prevOps, op] : null;
	store.saveDraft({ base: w.hash, text, changes, ops });
}

function state() {
	if (!mirror.exists()) {
		return { ok: false, setup: { mmDir: mirror.dir, problem: "notFound" }, version: VERSION };
	}
	let w;
	try {
		w = working();
	} catch (err) {
		return { ok: false, setup: { mmDir: mirror.dir, configPath: mirror.configPath, problem: "noConfig", error: err.message }, version: VERSION };
	}
	let entries = [];
	let parseError = null;
	try {
		entries = C.listEntries(w.text).map((e) => ({ ...e, installed: e.module ? mirror.moduleExists(e.module) : false }));
	} catch (err) {
		parseError = err.message;
	}
	return {
		ok: true,
		version: VERSION,
		demo: DEMO,
		auth: auth.enabled,
		settings: settings(),
		preview: preview && preview.server ? { port: PREVIEW_PORT, health: preview.healthOf(mirror.configHash(w.text)) } : null,
		rev: mirror.configHash(w.text),
		mm: { dir: mirror.dir, version: mirror.version(), configPath: mirror.configPath },
		positions: mirror.positions(),
		builtins: mirror.builtinModules(),
		entries,
		parseError,
		draft: w.draft ? { changes: w.draft.changes, updated: w.draft.updated } : null,
		conflict: w.conflict ? { changes: w.conflict.changes } : null,
		job: jobs.current ? { id: jobs.current.id, type: jobs.current.type } : null,
		core: core.info
	};
}

// ---------- applying a config: check, back up, write, restart, verify, roll back ----------

const APPLY_STEPS = [
	{ key: "check", label: "check" },
	{ key: "backup", label: "backup" },
	{ key: "write", label: "write" },
	{ key: "restart", label: "restart" },
	{ key: "verify", label: "verify" }
];

async function applyConfig(api, text, info) {
	const { step, log } = api;
	step("check", "running");
	const res = await mirror.check(text);
	if (!res.ok) {
		step("check", "failed", res.errors.join("\n"));
		return { status: "failed", errors: res.errors };
	}
	step("check", "done", res.warnings.join("\n"));

	step("backup", "running");
	const previous = mirror.readConfig();
	const backupId = store.addBackup(previous, { ...info, result: "pending" });
	step("backup", "done");

	const before = await mirror.snapshot();
	step("write", "running");
	writeAtomic(mirror.configPath, text);
	step("write", "done");

	const outcome = await restartAndVerify(api, before);
	if (outcome.ok) {
		store.updateBackup(backupId, { result: outcome.skipped ? "notRestarted" : "ok" });
		return { status: "done", warnings: [...res.warnings, ...(outcome.warnings || [])], notRestarted: !!outcome.skipped };
	}

	// Something went wrong: put the previous config back.
	log(`Rolling back: ${outcome.reason}`);
	api.job.steps.push({ key: "rollback", label: "rollback", state: "running", detail: "" });
	const before2 = await mirror.snapshot();
	writeAtomic(mirror.configPath, previous);
	const r = await mirror.restart();
	const v = r.ok ? await mirror.verify(before2) : { ok: false, reason: r.message };
	step("rollback", v.ok || !before.running ? "done" : "failed", v.ok ? "" : before.running ? v.reason : "MagicMirror was not running before either");
	store.updateBackup(backupId, { result: "rolledBack", reason: outcome.reason });
	return { status: "rolledBack", reason: outcome.reason, log: outcome.log, wasRunning: before.running };
}

async function restartAndVerify(api, before) {
	const { step, log } = api;
	const st = before.status;
	if (!st.found) {
		step("restart", "skipped", st.error || "");
		step("verify", "skipped");
		return { ok: true, skipped: true };
	}
	step("restart", "running");
	const r = await mirror.restart();
	if (!r.ok) {
		step("restart", "failed", r.message);
		step("verify", "skipped");
		return { ok: false, reason: `Restart failed: ${r.message}` };
	}
	step("restart", "done");
	step("verify", "running");
	const v = await mirror.verify(before, (sec) => step("verify", "running", `${sec}`));
	if (v.log) for (const l of v.log.split("\n").slice(-40)) log(l);
	if (!v.ok) {
		step("verify", "failed", v.reason);
		return { ok: false, reason: v.reason, log: v.log };
	}
	step("verify", "done");
	return { ok: true, warnings: v.warnings };
}

// ---------- HTTP plumbing ----------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

function send(req, res, status, body, type = "application/json; charset=utf-8", extra = {}) {
	let data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
	const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra };
	if (data.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /json|text|javascript|svg/.test(type)) {
		data = zlib.gzipSync(data);
		headers["Content-Encoding"] = "gzip";
	}
	headers["Content-Length"] = data.length;
	res.writeHead(status, headers);
	res.end(data);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > 2_000_000) {
				reject(new UserError("Request too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new UserError("Invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

function serveStatic(req, res, pathname) {
	const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
	const file = path.join(PUBLIC, rel);
	if (!file.startsWith(PUBLIC + path.sep)) return send(req, res, 404, "Not found", "text/plain");
	fs.readFile(file, (err, data) => {
		if (err) return send(req, res, 404, "Not found", "text/plain");
		send(req, res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
	});
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

// ---------- API ----------

route("GET", "/api/state", () => state());

route("POST", "/api/op", (body) => {
	const op = C.ops[body.op];
	if (!op || typeof op !== "function") throw new UserError("Unknown action");
	const w = working();
	const { text, change, index } = op(w.text, body);
	saveWorking(w, text, change, body);
	return { ...state(), index: index !== undefined ? index : body.index };
});

route("POST", "/api/settings", (body) => {
	const next = settings();
	if (body.orientation === "portrait" || body.orientation === "landscape") next.orientation = body.orientation;
	if (body.view === "live" || body.view === "sketch") next.view = body.view;
	writeJSON(SETTINGS_FILE, next);
	return next;
});

route("POST", "/api/draft/discard", () => {
	store.clearDraft();
	return state();
});

route("GET", "/api/draft/diff", () => {
	const w = working();
	return { diff: diffLines(w.current, w.text) };
});

route("GET", "/api/entry/:index", (body, p) => {
	const w = working();
	const d = C.entryDetails(w.text, Number(p.index));
	const defaults = d.module ? readDefaults(mirror.moduleMainFile(d.module)) : null;
	return { ...d, defaults, builtin: mirror.builtinModules().includes(d.module), info: d.module ? modules.info(d.module, catalog) : null };
});

route("POST", "/api/apply", () => {
	const w = working();
	if (!w.draft) throw new UserError("There are no changes to apply");
	const text = w.text;
	const changes = w.draft.changes;
	return jobs.start("apply", "apply", APPLY_STEPS, async (api) => {
		const result = await applyConfig(api, text, { kind: "apply", changes });
		if (result.status === "done") store.clearDraft();
		return result;
	});
});

route("GET", "/api/config", () => {
	const w = working();
	return { text: w.text, path: mirror.configPath };
});

route("POST", "/api/config", (body) => {
	if (typeof body.text !== "string") throw new UserError("Missing text");
	const res = C.validate(body.text, { configPath: mirror.configPath, positions: mirror.positions(), moduleExists: (m) => mirror.moduleExists(m) });
	if (!res.ok) return { ok: false, errors: res.errors, warnings: res.warnings };
	const w = working();
	saveWorking(w, body.text, body.text === w.text ? null : { k: "chg.raw", p: {} });
	return { ok: true, warnings: res.warnings, state: state() };
});

route("GET", "/api/job/:id", (body, p) => {
	const job = jobs.get(p.id);
	if (!job) throw new UserError("Unknown job");
	return job;
});

route("GET", "/api/status", async () => {
	const [st, probe] = await Promise.all([mirror.status(), mirror.probe()]);
	return { process: st, http: probe, url: mirror.baseUrl(), version: mirror.version(), managerVersion: VERSION, demo: DEMO };
});

route("GET", "/api/logs", () => mirror.logs(200));

route("POST", "/api/restart", () =>
	jobs.start("restart", "restart", [{ key: "restart", label: "restart" }, { key: "verify", label: "verify" }], async (api) => {
		const before = await mirror.snapshot();
		const r = await restartAndVerify(api, before);
		if (r.skipped) throw new UserError(before.status.error || "MagicMirror process not found");
		return r.ok ? { status: "done", warnings: r.warnings } : { status: "failed", reason: r.reason, log: r.log };
	})
);

route("GET", "/api/history", () => ({ history: store.history() }));

route("GET", "/api/history/:id", (body, p) => {
	const text = store.backupText(p.id);
	if (text === null) throw new UserError("Backup not found");
	return { text, diff: diffLines(mirror.readConfig(), text) };
});

route("POST", "/api/history/:id/restore", (body, p) => {
	const text = store.backupText(p.id);
	if (text === null) throw new UserError("Backup not found");
	const entry = store.history().find((h) => h.id === p.id);
	return jobs.start("restore", "restore", APPLY_STEPS, async (api) => {
		const result = await applyConfig(api, text, { kind: "restore", restoredFrom: p.id, restoredTime: entry ? entry.time : null });
		if (result.status === "done") store.clearDraft();
		return result;
	});
});

// modules: installed, updates, install, uninstall, catalog
route("GET", "/api/modules", () => modules.list(catalog, working().text));

route("POST", "/api/modules/check-updates", () => jobs.start("checkUpdates", "checkUpdates", [{ key: "fetch", label: "fetch" }], (api) => modules.checkUpdates(api)));

route("POST", "/api/modules/:name/update", (body, p) =>
	jobs.start("update", p.name, modules.updateSteps(), (api) => modules.update(api, p.name, { restartAndVerify, isActive: () => isActive(p.name) }))
);

route("POST", "/api/modules/:name/uninstall", (body, p) => {
	const w = working();
	const used = C.listEntries(w.current).some((e) => e.module === p.name) || C.listEntries(w.text).some((e) => e.module === p.name);
	if (used) throw new UserError("The module is still in the config. Remove it from the mirror first.");
	return jobs.start("uninstall", p.name, [{ key: "remove", label: "remove" }], (api) => modules.uninstall(api, p.name));
});

route("POST", "/api/modules/install", (body) => {
	const entry = catalog.find(body.id);
	const url = entry ? entry.url : body.url;
	const name = entry ? entry.name : body.name;
	return jobs.start("install", name || "?", modules.installSteps(), async (api) => {
		const result = await modules.install(api, { url, name });
		if (result.status === "done" && body.addToMirror !== false) {
			const w = working();
			const addOp = { op: "add", module: result.name, position: body.position || null };
			const { text, change } = C.ops.add(w.text, addOp);
			saveWorking(w, text, change, addOp);
			if (body.schedule && Array.isArray(body.schedule)) {
				const w2 = working();
				const index = C.listEntries(w2.text).length - 1;
				const schedOp = { op: "setSchedule", index, module: result.name, from: body.schedule[0], until: body.schedule[1] };
				const r = C.ops.setSchedule(w2.text, schedOp);
				saveWorking(w2, r.text, r.change, schedOp);
			}
			result.addedToDraft = true;
		}
		return result;
	});
});

route("POST", "/api/modules/:name/revert", (body, p) =>
	jobs.start("revert", p.name, [{ key: "restore", label: "restoreVersion" }, { key: "restart", label: "restart" }, { key: "verify", label: "verify" }], (api) =>
		modules.revert(api, p.name, { restartAndVerify, isActive: () => isActive(p.name) })
	)
);

route("GET", "/api/trash", () => ({ items: modules.trash() }));

route("POST", "/api/trash/:id/restore", (body, p) => jobs.start("untrash", p.id.replace(/-\d{4}-.*$/, ""), [{ key: "restore", label: "restore" }], (api) => modules.restoreFromTrash(api, p.id)));

route("POST", "/api/trash/:id/delete", (body, p) => {
	if (jobs.busy()) throw new UserError("Another action is still running. Please wait until it has finished.");
	modules.deleteFromTrash(p.id);
	return { items: modules.trash() };
});

route("POST", "/api/mm/check", async () => (DEMO ? null : core.check()));

route("POST", "/api/mm/update", () => {
	if (DEMO) throw new UserError("Not available in demo mode");
	return jobs.start("mmUpdate", "MagicMirror", core.steps(), (api) => core.update(api, { restartAndVerify }));
});

// Seasonal suggestions: modules for events that are on now or coming up soon.
route("GET", "/api/suggestions", async () => {
	const events = seasons.upcoming();
	if (!events.length) return { events: [] };
	const cat = await catalog.get();
	const w = working();
	let entries = [];
	try {
		entries = C.listEntries(w.text);
	} catch {
		// config can't be parsed
	}
	const installedNames = modules.installedNames();
	return {
		events: events
			.map((ev) => {
				const used = entries.filter((e) => e.module && seasons.matches(e.module, ev.keywords));
				const idle = installedNames.filter((n) => seasons.matches(n, ev.keywords) && !used.some((e) => e.module === n));
				const found = cat.modules
					.filter((m) => !m.archived && !installedNames.includes(m.name) && seasons.matches(`${m.name} ${m.description || ""} ${(m.tags || []).join(" ")}`, ev.keywords))
					.sort((a, b) => b.stars - a.stars)
					.slice(0, 5);
				return { ...ev, used, idle, catalog: found };
			})
			.filter((ev) => ev.used.length || ev.idle.length || ev.catalog.length)
	};
});

route("GET", "/api/catalog", async (body, p, query) => catalog.get({ refresh: query.get("refresh") === "1" }));

function isActive(name) {
	try {
		return C.listEntries(mirror.readConfig()).some((e) => e.module === name && !e.disabled);
	} catch {
		return true;
	}
}

// ---------- date windows: switch modules on and off (checked every hour) ----------

let lastScheduleTry = null;
function runSchedules() {
	if (jobs.busy()) return;
	let current;
	let entries;
	try {
		current = mirror.readConfig();
		entries = C.listEntries(current);
	} catch {
		return;
	}
	const today = new Date();
	// a module that is off inside its window, or on outside of it
	const due = entries.filter((e) => e.schedule && e.disabled === seasons.inWindow(today, e.schedule[0], e.schedule[1]));
	if (!due.length) return;
	// one try per day and situation, so a failing change isn't retried every hour
	const key = `${today.toDateString()} ${due.map((e) => `${e.index}:${e.disabled}`).join(",")}`;
	if (lastScheduleTry === key) return;
	lastScheduleTry = key;
	let text = current;
	const changes = [];
	for (const e of due) {
		const r = C.ops.toggle(text, { index: e.index, module: e.module, disabled: !e.disabled });
		text = r.text;
		changes.push(r.change);
	}
	const draft = store.getDraft();
	const baseBefore = mirror.configHash(current);
	jobs.start("schedule", "schedule", APPLY_STEPS, async (api) => {
		const result = await applyConfig(api, text, { kind: "schedule", changes });
		// carry pending changes over to the new config
		if (result.status === "done" && draft && draft.base === baseBefore) {
			let dt = draft.text;
			try {
				for (const e of due) {
					const d = C.listEntries(dt).find((x) => x.module === e.module && x.schedule && x.schedule.join() === e.schedule.join());
					if (d) dt = C.ops.toggle(dt, { index: d.index, module: d.module, disabled: !e.disabled }).text;
				}
				store.saveDraft({ ...draft, base: mirror.configHash(text), text: dt });
			} catch {
				// leave the draft; it will show as conflicting
			}
		}
		return result;
	});
}
setTimeout(runSchedules, 30 * 1000).unref();
setInterval(runSchedules, 60 * 60 * 1000).unref();

// ---------- automatic update checks ----------

const UPDATE_CHECK_HOURS = Number(process.env.UPDATE_CHECK_HOURS) || 6;
async function backgroundUpdateCheck() {
	if (jobs.busy() || modules.checking) return;
	try {
		await modules.checkUpdates({ step() {}, log() {} });
		if (!DEMO) await core.check();
	} catch (err) {
		console.error(`Update check failed: ${err.message}`);
	}
}
setTimeout(backgroundUpdateCheck, 60 * 1000).unref();
setInterval(backgroundUpdateCheck, UPDATE_CHECK_HOURS * 3600 * 1000).unref();

// A bug in one request must not take the whole manager down (it is the safety net).
process.on("uncaughtException", (err) => console.error("Unexpected error:", err));
process.on("unhandledRejection", (err) => console.error("Unexpected error:", err));

// ---------- server ----------

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (!url.pathname.startsWith("/api/")) {
		if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", "text/plain");
		return serveStatic(req, res, url.pathname);
	}
	try {
		// login / logout and the password check for everything else
		if (url.pathname === "/api/login" && req.method === "POST") {
			const body = await readBody(req);
			const cookie = auth.login(body.password, req.socket.remoteAddress);
			return send(req, res, 200, { ok: true }, undefined, { "Set-Cookie": cookie });
		}
		if (url.pathname === "/api/logout" && req.method === "POST") return send(req, res, 200, { ok: true }, undefined, { "Set-Cookie": auth.logout(req) });
		if (!auth.check(req)) return send(req, res, 401, { error: "Please log in", login: true });
	} catch (err) {
		return send(req, res, err instanceof UserError ? 400 : 500, { error: err.message });
	}
	const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
	if (!r) return send(req, res, 404, { error: "Not found" });
	try {
		const body = req.method === "POST" ? await readBody(req) : {};
		const params = Object.fromEntries(Object.entries(r.re.exec(url.pathname).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
		const result = await r.handler(body, params, url.searchParams);
		send(req, res, 200, result === undefined ? { ok: true } : result);
	} catch (err) {
		const user = err instanceof UserError;
		if (!user) console.error(err);
		send(req, res, user ? 400 : 500, { error: err.message || String(err) });
	}
});

// Live preview of the draft on its own port (not in demo mode: there is no real mirror).
const preview = DEMO || !PREVIEW_PORT ? null : new Preview({ port: PREVIEW_PORT, host: HOST, mirror, auth, draftText: () => working().text });
if (preview) preview.start();

server.listen(PORT, HOST, () => {
	console.log(`MagicMirror Manager ${VERSION} on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
	console.log(DEMO ? `Demo mode (fake mirror in ${mmDir})` : `MagicMirror: ${mirror.dir}`);
});
