"use strict";
// Everything about the MagicMirror installation: paths, version, process control
// (pm2, a custom command, or a simulation in demo mode) and the health check.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { run, httpGet, sleep, readTail, fileSize } = require("./util");
const { DEFAULT_POSITIONS, BUILTIN_MODULES } = require("./constants");
const { evaluateConfig, validate } = require("./config");

// Log lines that mean MagicMirror did not really start with the new config.
const FATAL_PATTERNS = [
	/Could not validate config file/i,
	/Starting with default configuration/i,
	/Could not load config file/i,
	/configuration file contains syntax errors/i,
	/module configuration contains errors/i,
	/Unexpected error during startup/i,
	/Cannot find module/i,
	/EADDRINUSE/
];
const ERROR_LINE = /\[ERROR\]|\bERROR\b|Error:|Uncaught/;

class Mirror {
	constructor(opts) {
		this.dir = path.resolve(opts.mmDir);
		this.configPath = opts.configPath ? path.resolve(this.dir, opts.configPath) : path.join(this.dir, "config", "config.js");
		this.pm2Bin = opts.pm2Bin || "pm2";
		this.pm2Name = opts.pm2Name || "";
		this.restartCmd = opts.restartCmd || "";
		this.demo = !!opts.demo;
		this.startTimeout = opts.startTimeout || 90000;
		this.stableTime = opts.stableTime || 10000;
		this.urlOverride = opts.mmUrl || "";
		this.selfDir = opts.selfDir || "";
		this._positions = null;
	}

	// ---------- installation ----------

	exists() {
		return fs.existsSync(path.join(this.dir, "package.json")) && fs.existsSync(path.join(this.dir, "js"));
	}

	version() {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.dir, "package.json"), "utf8")).version || null;
		} catch {
			return null;
		}
	}

	readConfig() {
		return fs.readFileSync(this.configPath, "utf8");
	}

	configHash(text) {
		return crypto.createHash("sha1").update(text === undefined ? this.readConfig() : text).digest("hex").slice(0, 12);
	}

	// Config values that matter for us (evaluated, falls back to defaults).
	configValues() {
		try {
			return evaluateConfig(this.readConfig(), this.configPath);
		} catch {
			return {};
		}
	}

	// Regions as MagicMirror itself discovers them from index.html.
	positions() {
		if (this._positions) return this._positions;
		const list = [];
		try {
			const html = fs.readFileSync(path.join(this.dir, "index.html"), "utf8");
			for (const m of html.matchAll(/"region ([^"]*)/gi)) {
				const pos = m[1].replace(" ", "_");
				if (!list.includes(pos)) list.push(pos);
			}
		} catch {
			// fall back below
		}
		this._positions = list.length ? list : DEFAULT_POSITIONS.slice();
		return this._positions;
	}

	defaultModulesDir() {
		const cfg = this.configValues();
		if (cfg.defaultModulesDir) return path.join(this.dir, cfg.defaultModulesDir);
		if (fs.existsSync(path.join(this.dir, "defaultmodules"))) return path.join(this.dir, "defaultmodules");
		return path.join(this.dir, "modules", "default");
	}

	modulesDir() {
		if (process.env.MM_MODULES_DIR) return path.resolve(this.dir, process.env.MM_MODULES_DIR);
		const cfg = this.configValues();
		return path.join(this.dir, cfg.foreignModulesDir || "modules");
	}

	builtinModules() {
		const file = path.join(this.defaultModulesDir(), "defaultmodules.js");
		try {
			const sandbox = { module: { exports: {} }, globalThis: {} };
			vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { timeout: 500 });
			const list = sandbox.module.exports;
			if (Array.isArray(list) && list.length) return Array.from(list);
		} catch {
			// fall back below
		}
		return BUILTIN_MODULES.slice();
	}

	// Folder of a module as MagicMirror resolves it.
	moduleFolder(name) {
		const base = name.split("/").pop();
		if (this.builtinModules().includes(base) && !name.includes("/")) return path.join(this.defaultModulesDir(), name);
		return path.join(this.modulesDir(), name);
	}

	moduleMainFile(name) {
		return path.join(this.moduleFolder(name), `${name.split("/").pop()}.js`);
	}

	moduleExists(name) {
		return fs.existsSync(this.moduleMainFile(name));
	}

	// Full check of a config text, optionally also with MagicMirror's own checker.
	async check(text, { withMMCheck = true } = {}) {
		const res = validate(text, { configPath: this.configPath, positions: this.positions(), moduleExists: (m) => this.moduleExists(m) });
		if (!res.ok || !withMMCheck || this.demo) return res;
		const mm = await this.mmCheck(text);
		if (mm && !mm.ok) {
			// If MagicMirror's checker also rejects the config that runs right now, it is not
			// a reliable judge for this installation: show its message as a note only.
			const current = await this.mmCheck(this.readConfig());
			if (current && !current.ok) res.warnings.push(mm.message);
			else res.errors.push(mm.message);
		}
		res.ok = res.errors.length === 0;
		return res;
	}

	// Runs MagicMirror's own config check (js/check_config.js) against a candidate file.
	async mmCheck(text) {
		const checker = path.join(this.dir, "js", "check_config.js");
		if (!fs.existsSync(checker) || !fs.existsSync(path.join(this.dir, "node_modules"))) return null;
		const dir = path.dirname(this.configPath);
		const candidate = path.join(dir, ".mm-manager-check.js");
		const envSrc = this.configPath.replace(/\.[^.]+$/, "") + ".env";
		const envDst = path.join(dir, ".mm-manager-check.env");
		try {
			fs.writeFileSync(candidate, text);
			if (fs.existsSync(envSrc)) fs.copyFileSync(envSrc, envDst);
			const r = await run(process.execPath, [checker], { cwd: this.dir, timeout: 60000, env: { MM_CONFIG_FILE: candidate } });
			if (r.code === 0) return { ok: true };
			const lines = r.out.split("\n").filter((l) => /error|line \d+/i.test(l) && !/doesn't contain/i.test(l));
			const msg = (lines.length ? lines : r.out.split("\n")).join("\n").replace(new RegExp(escapeRe(candidate), "g"), "config.js").trim();
			return { ok: false, message: `MagicMirror check: ${msg.slice(0, 1500)}` };
		} finally {
			fs.rmSync(candidate, { force: true });
			fs.rmSync(envDst, { force: true });
		}
	}

	// ---------- process control ----------

	baseUrl() {
		if (this.urlOverride) return this.urlOverride.replace(/\/$/, "");
		const cfg = this.configValues();
		const port = process.env.MM_PORT || cfg.port || 8080;
		const addr = cfg.address;
		const host = !addr || ["localhost", "0.0.0.0", "::", "127.0.0.1", "::1"].includes(addr) ? "localhost" : addr.includes(":") ? `[${addr}]` : addr;
		const basePath = (cfg.basePath || "/").replace(/\/$/, "");
		return `${cfg.useHttps ? "https" : "http"}://${host}:${port}${basePath}`;
	}

	// Any HTTP answer (even 403 from the IP whitelist) means the server is up.
	async probe() {
		if (this.demo) return { up: this._demoState !== "errored", status: 200, startup: String(this._demoStart || 0) };
		const base = this.baseUrl();
		const res = await httpGet(`${base}/`, { timeout: 4000, maxBytes: 2_000_000 });
		let startup = null;
		if (res.status > 0) {
			const s = await httpGet(`${base}/startup`, { timeout: 3000, maxBytes: 10000 });
			if (s.status === 200 && s.body.length < 100) startup = s.body;
		}
		return { up: res.status > 0, status: res.status, startup };
	}

	controllerKind() {
		if (this.demo) return "demo";
		if (this.restartCmd) return "command";
		return "pm2";
	}

	async pm2List() {
		const r = await run(this.pm2Bin, ["jlist"], { timeout: 20000 });
		if (r.code !== 0) return { error: r.out.trim().split("\n").pop() || "pm2 not available" };
		const start = r.out.indexOf("[");
		try {
			return { list: JSON.parse(r.out.slice(start)) };
		} catch {
			return { error: "Could not read the pm2 process list" };
		}
	}

	// Finds the MagicMirror process in pm2.
	pickProcess(list) {
		const own = (p) => (this.selfDir && String(p.pm2_env.pm_exec_path || "").startsWith(this.selfDir)) || p.pid === process.pid;
		const candidates = list.filter((p) => !own(p));
		if (this.pm2Name) return candidates.find((p) => p.name === this.pm2Name || String(p.pm_id) === this.pm2Name) || null;
		const inDir = (v) => typeof v === "string" && (v === this.dir || v.startsWith(this.dir + path.sep));
		return (
			candidates.find((p) => inDir(p.pm2_env.pm_exec_path)) ||
			candidates.find((p) => inDir(p.pm2_env.pm_cwd)) ||
			candidates.find((p) => /^(mm|magic\s*mirror2?|magicmirror.*)$/i.test(p.name)) ||
			null
		);
	}

	async status() {
		const kind = this.controllerKind();
		if (kind === "demo") return { kind, found: true, name: "MagicMirror (demo)", status: this._demoState || "online", restarts: this._demoRestarts || 0, uptime: this._demoStart || Date.now() };
		if (kind === "command") return { kind, found: true, name: "MagicMirror" };
		const res = await this.pm2List();
		if (res.error) return { kind, found: false, error: res.error };
		const p = this.pickProcess(res.list);
		if (!p) return { kind, found: false, error: "No MagicMirror process found in pm2", processes: res.list.map((x) => x.name) };
		return {
			kind,
			found: true,
			id: p.pm_id,
			name: p.name,
			status: p.pm2_env.status,
			restarts: p.pm2_env.restart_time,
			uptime: p.pm2_env.pm_uptime,
			memory: p.monit ? p.monit.memory : null,
			cpu: p.monit ? p.monit.cpu : null,
			outLog: p.pm2_env.pm_out_log_path,
			errLog: p.pm2_env.pm_err_log_path
		};
	}

	async restart() {
		const kind = this.controllerKind();
		if (kind === "demo") {
			this._demoState = "launching";
			await sleep(1200);
			const res = await this.check(this.readConfig(), { withMMCheck: false });
			this._demoState = res.ok ? "online" : "errored";
			this._demoRestarts = (this._demoRestarts || 0) + 1;
			this._demoStart = Date.now();
			return { ok: true };
		}
		if (kind === "command") {
			const r = await run("/bin/sh", ["-c", this.restartCmd], { timeout: 60000 });
			return r.code === 0 ? { ok: true } : { ok: false, message: r.out.trim() || `exit code ${r.code}` };
		}
		const st = await this.status();
		if (!st.found) return { ok: false, message: st.error };
		const r = await run(this.pm2Bin, ["restart", String(st.id)], { timeout: 60000 });
		return r.code === 0 ? { ok: true } : { ok: false, message: r.out.trim().split("\n").slice(-3).join("\n") };
	}

	// Snapshot before a restart, used by verify() to only look at what happened afterwards.
	async snapshot() {
		const st = await this.status();
		const probe = await this.probe();
		return {
			status: st,
			running: st.found && (st.kind !== "pm2" || st.status === "online") && probe.up,
			startup: probe.startup,
			outSize: st.outLog ? fileSize(st.outLog) : 0,
			errSize: st.errLog ? fileSize(st.errLog) : 0
		};
	}

	newLogs(before, st) {
		const parts = [];
		if (st.outLog) parts.push(readTail(st.outLog, 0, fileSize(st.outLog) < before.outSize ? 0 : before.outSize));
		if (st.errLog && st.errLog !== st.outLog) parts.push(readTail(st.errLog, 0, fileSize(st.errLog) < before.errSize ? 0 : before.errSize));
		return parts.join("\n");
	}

	// Waits until MagicMirror runs stable after a restart. Returns { ok, reason, log, warnings }.
	async verify(before, onProgress = () => {}) {
		const kind = this.controllerKind();
		if (kind === "demo") {
			const st = await this.status();
			if (st.status !== "online") return { ok: false, reason: "MagicMirror did not start (demo: config check failed)", log: "", warnings: [] };
			return { ok: true, warnings: [] };
		}
		const started = Date.now();
		let baseline = null;
		let st = await this.status();
		if (kind === "pm2") baseline = st.restarts;
		let up = false;
		while (Date.now() - started < this.startTimeout) {
			await sleep(1000);
			st = await this.status();
			if (kind === "pm2") {
				if (!st.found) return this.fail("The MagicMirror process disappeared from pm2", before, st);
				if (st.status === "errored" || st.status === "stopped") return this.fail(`MagicMirror stopped (pm2 status: ${st.status})`, before, st);
				if (st.restarts > baseline) return this.fail("MagicMirror crashed during start", before, st);
			}
			const fatal = this.fatalLine(before, st);
			if (fatal) return this.fail(fatal, before, st);
			const probe = await this.probe();
			if (probe.up && (!before.startup || !probe.startup || probe.startup !== before.startup)) {
				up = true;
				break;
			}
			onProgress(Math.round((Date.now() - started) / 1000));
		}
		if (!up) return this.fail(`MagicMirror did not respond within ${Math.round(this.startTimeout / 1000)} seconds`, before, st);
		// Stay a little longer: modules often crash right after start.
		const stableUntil = Date.now() + this.stableTime;
		while (Date.now() < stableUntil) {
			await sleep(1000);
			st = await this.status();
			if (kind === "pm2" && (st.status !== "online" || st.restarts > baseline)) return this.fail("MagicMirror crashed shortly after start", before, st);
			const fatal = this.fatalLine(before, st);
			if (fatal) return this.fail(fatal, before, st);
			const probe = await this.probe();
			if (!probe.up) return this.fail("MagicMirror stopped answering shortly after start", before, st);
		}
		const log = st.outLog ? this.newLogs(before, st) : "";
		const warnings = log.split("\n").filter((l) => ERROR_LINE.test(l)).slice(-10);
		return { ok: true, warnings, log: tailLines(log, 40) };
	}

	fatalLine(before, st) {
		if (!st || !st.outLog) return null;
		const log = this.newLogs(before, st);
		for (const line of log.split("\n")) if (FATAL_PATTERNS.some((re) => re.test(line))) return line.trim().slice(0, 300);
		return null;
	}

	fail(reason, before, st) {
		const log = st && st.outLog ? this.newLogs(before, st) : "";
		return { ok: false, reason, log: tailLines(log, 60), warnings: [] };
	}

	async logs(lines = 200) {
		if (this.demo) return { text: "[demo] MagicMirror is simulated in demo mode, there are no real logs.", source: "demo" };
		const st = await this.status();
		if (!st.found || !st.outLog) return { text: "", source: null, error: st.error || "No log files known" };
		const out = readTail(st.outLog, 96 * 1024);
		const err = st.errLog && st.errLog !== st.outLog ? readTail(st.errLog, 48 * 1024) : "";
		return { out: tailLines(out, lines), err: tailLines(err, Math.round(lines / 2)), source: "pm2" };
	}
}

function tailLines(text, n) {
	const lines = String(text || "").split("\n").filter((l) => l.trim());
	return lines.slice(-n).join("\n");
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { Mirror };
