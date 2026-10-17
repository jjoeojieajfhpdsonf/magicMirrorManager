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
const { writeAtomic } = require("./lib/util");
const { setupDemo } = require("./lib/demo");

const PORT = Number(process.env.PORT) || 8090;
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
const jobs = new Jobs();
const modules = new Modules(mirror, DATA_DIR);
const catalog = new Catalog(DATA_DIR);

// ---------- working copy: the draft if there is one, otherwise config.js ----------

function working() {
	const current = mirror.readConfig();
	const hash = mirror.configHash(current);
	const draft = store.getDraft();
	if (draft && draft.base === hash && draft.text !== current) return { text: draft.text, current, hash, draft };
	if (draft && draft.base !== hash) return { text: current, current, hash, draft: null, conflict: draft };
	return { text: current, current, hash, draft: null };
}

function saveWorking(w, text, change) {
	if (text === w.current) {
		store.clearDraft();
		return;
	}
	const changes = w.draft ? w.draft.changes.slice() : [];
	if (change) changes.push(change);
	store.saveDraft({ base: w.hash, text, changes });
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
		mm: { dir: mirror.dir, version: mirror.version(), configPath: mirror.configPath },
		positions: mirror.positions(),
		builtins: mirror.builtinModules(),
		entries,
		parseError,
		draft: w.draft ? { changes: w.draft.changes, updated: w.draft.updated } : null,
		conflict: w.conflict ? { changes: w.conflict.changes } : null,
		job: jobs.current ? { id: jobs.current.id, type: jobs.current.type } : null
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
	step("verify", "done", v.warnings.length ? v.warnings.join("\n") : "");
	return { ok: true, warnings: v.warnings };
}

// ---------- HTTP plumbing ----------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

function send(req, res, status, body, type = "application/json; charset=utf-8") {
	let data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
	const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
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
	saveWorking(w, text, change);
	return { ...state(), index: index !== undefined ? index : body.index };
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
			const { text, change } = C.ops.add(w.text, { module: result.name, position: body.position || null });
			saveWorking(w, text, change);
			result.addedToDraft = true;
		}
		return result;
	});
});

route("GET", "/api/catalog", async (body, p, query) => catalog.get({ refresh: query.get("refresh") === "1" }));

function isActive(name) {
	try {
		return C.listEntries(mirror.readConfig()).some((e) => e.module === name && !e.disabled);
	} catch {
		return true;
	}
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (!url.pathname.startsWith("/api/")) {
		if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", "text/plain");
		return serveStatic(req, res, url.pathname);
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

server.listen(PORT, HOST, () => {
	console.log(`MagicMirror Manager ${VERSION} on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
	console.log(DEMO ? `Demo mode (fake mirror in ${mmDir})` : `MagicMirror: ${mirror.dir}`);
});
