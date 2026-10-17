"use strict";
// End-to-end test against a real MagicMirror running under pm2.
//
//   MM_DIR=~/MagicMirror MM_PM2_NAME=MagicMirror node test/integration.js
//
// It changes the real config (and restores it at the end), installs MMM-SimpleText from
// GitHub and uses a module that crashes on purpose to prove the automatic rollback.
// Don't run it against a mirror you care about.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const MM_DIR = path.resolve(process.env.MM_DIR || path.join(os.homedir(), "MagicMirror"));
const CONFIG = path.join(MM_DIR, "config", "config.js");
const PORT = Number(process.env.TEST_PORT) || 8098;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-it-"));
const CRASH = path.join(MM_DIR, "modules", "MMM-CrashTest");
const SIMPLE = path.join(MM_DIR, "modules", "MMM-SimpleText");

const originalConfig = fs.readFileSync(CONFIG, "utf8");
let server;
let passed = 0;

async function api(method, url, body) {
	const res = await fetch(BASE + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json();
	return { status: res.status, data };
}

async function job(method, url, body) {
	const r = await api(method, url, body);
	assert.equal(r.status, 200, JSON.stringify(r.data));
	for (;;) {
		await new Promise((res) => setTimeout(res, 500));
		const j = await api("GET", `/api/job/${r.data.id}`);
		if (j.data.status !== "running") return j.data;
	}
}

async function step(name, fn) {
	process.stdout.write(`• ${name} … `);
	const t0 = Date.now();
	await fn();
	passed++;
	console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

const entries = async () => (await api("GET", "/api/state")).data.entries;
const find = async (name) => (await entries()).find((e) => e.module === name);

async function main() {
	// a module whose node_helper kills MagicMirror two seconds after start
	fs.mkdirSync(CRASH, { recursive: true });
	fs.writeFileSync(path.join(CRASH, "MMM-CrashTest.js"), "Module.register(\"MMM-CrashTest\", { defaults: { delay: 2000 } });\n");
	fs.writeFileSync(path.join(CRASH, "node_helper.js"), "const NodeHelper = require(\"node_helper\");\nmodule.exports = NodeHelper.create({ start() { setTimeout(() => process.exit(1), 2000); } });\n");
	fs.rmSync(SIMPLE, { recursive: true, force: true });

	server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, MM_DIR, HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
	server.stderr.on("data", (d) => process.stderr.write(d));
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(`${BASE}/api/state`);
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	await step("MagicMirror is found and running", async () => {
		const st = await api("GET", "/api/status");
		assert.equal(st.data.process.found, true, JSON.stringify(st.data.process));
		assert.equal(st.data.process.status, "online");
		assert.equal(st.data.http.up, true);
	});

	await step("valid change: move the clock, apply, mirror restarts and runs", async () => {
		const clock = await find("clock");
		const before = (await api("GET", "/api/status")).data.http.startup;
		const r = await api("POST", "/api/op", { op: "move", index: clock.index, module: "clock", position: "top_right", before: null });
		assert.equal(r.status, 200, JSON.stringify(r.data));
		const j = await job("POST", "/api/apply");
		assert.equal(j.status, "done", JSON.stringify(j));
		assert.match(fs.readFileSync(CONFIG, "utf8"), /module: "clock",\s+position: "top_right"/);
		const after = (await api("GET", "/api/status")).data.http.startup;
		assert.notEqual(after, before, "MagicMirror should have been restarted");
	});

	await step("broken module: mirror crashes, change is rolled back automatically", async () => {
		const configBefore = fs.readFileSync(CONFIG, "utf8");
		const r = await api("POST", "/api/op", { op: "add", module: "MMM-CrashTest", position: "top_center" });
		assert.equal(r.status, 200);
		const j = await job("POST", "/api/apply");
		assert.equal(j.status, "rolledBack", JSON.stringify(j));
		assert.equal(fs.readFileSync(CONFIG, "utf8"), configBefore);
		const st = await api("GET", "/api/status");
		assert.equal(st.data.http.up, true);
		assert.equal(st.data.process.status, "online");
		await api("POST", "/api/draft/discard");
	});

	await step("invalid config is refused before anything is written", async () => {
		const text = fs.readFileSync(CONFIG, "utf8").replace("modules: [", "modules: [\n\t\t{ module: \"MMM-DoesNotExist\", position: \"top_left\" },");
		const r = await api("POST", "/api/config", { text });
		assert.equal(r.data.ok, false);
		assert.match(r.data.errors.join(), /not installed/);
		const r2 = await api("POST", "/api/config", { text: "let config = { modules: [ { module: \"clock\" ] };" });
		assert.equal(r2.data.ok, false);
	});

	await step("install MMM-SimpleText from GitHub and show it", async () => {
		const j = await job("POST", "/api/modules/install", { url: "https://github.com/SaltyRiver/MMM-SimpleText", name: "MMM-SimpleText", position: "bottom_center" });
		assert.equal(j.status, "done", JSON.stringify(j));
		assert.ok(fs.existsSync(path.join(SIMPLE, "MMM-SimpleText.js")));
		const a = await job("POST", "/api/apply");
		assert.equal(a.status, "done", JSON.stringify(a));
		assert.ok(await find("MMM-SimpleText"));
	});

	await step("settings: defaults are read from the module", async () => {
		const e = await find("MMM-SimpleText");
		const d = await api("GET", `/api/entry/${e.index}`);
		assert.ok(Array.isArray(d.data.defaults) && d.data.defaults.length > 0, "defaults expected");
	});

	await step("update: an outdated module is found and updated", async () => {
		await run("git", ["reset", "--quiet", "--hard", "HEAD~1"], SIMPLE);
		const c = await job("POST", "/api/modules/check-updates");
		assert.equal(c.status, "done");
		assert.ok(c.result.available >= 1, JSON.stringify(c));
		const u = await job("POST", "/api/modules/MMM-SimpleText/update");
		assert.equal(u.status, "done", JSON.stringify(u));
		assert.notEqual(u.result.from, u.result.to);
	});

	await step("update failure: the module folder is restored", async () => {
		await run("git", ["reset", "--quiet", "--hard", "HEAD~1"], SIMPLE);
		const head = (await run("git", ["rev-parse", "HEAD"], SIMPLE)).trim();
		await run("git", ["remote", "set-url", "origin", "https://github.com/SaltyRiver/does-not-exist-mmm"], SIMPLE);
		const u = await job("POST", "/api/modules/MMM-SimpleText/update");
		assert.equal(u.status, "rolledBack", JSON.stringify(u));
		assert.equal((await run("git", ["rev-parse", "HEAD"], SIMPLE)).trim(), head);
		await run("git", ["remote", "set-url", "origin", "https://github.com/SaltyRiver/MMM-SimpleText"], SIMPLE);
	});

	await step("uninstall: refused while in use, works after removing it", async () => {
		const r = await api("POST", "/api/modules/MMM-SimpleText/uninstall");
		assert.equal(r.status, 400);
		const e = await find("MMM-SimpleText");
		await api("POST", "/api/op", { op: "remove", index: e.index, module: "MMM-SimpleText" });
		const a = await job("POST", "/api/apply");
		assert.equal(a.status, "done", JSON.stringify(a));
		const u = await job("POST", "/api/modules/MMM-SimpleText/uninstall");
		assert.equal(u.status, "done");
		assert.ok(!fs.existsSync(SIMPLE));
		assert.ok(fs.readdirSync(path.join(DATA, "trash")).some((d) => d.startsWith("MMM-SimpleText-")));
	});

	await step("history: restore the very first state", async () => {
		const h = (await api("GET", "/api/history")).data.history;
		const first = h[h.length - 1];
		const j = await job("POST", `/api/history/${first.id}/restore`);
		assert.equal(j.status, "done", JSON.stringify(j));
		assert.equal(fs.readFileSync(CONFIG, "utf8"), originalConfig);
	});
}

function run(cmd, args, cwd) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")}: ${out}`))));
	});
}

main()
	.then(() => console.log(`\n${passed} integration checks passed`))
	.catch((err) => {
		console.error("\nFAILED:", err.message);
		process.exitCode = 1;
	})
	.finally(() => {
		if (server) server.kill();
		fs.writeFileSync(CONFIG, originalConfig);
		fs.rmSync(CRASH, { recursive: true, force: true });
		fs.rmSync(SIMPLE, { recursive: true, force: true });
		fs.rmSync(DATA, { recursive: true, force: true });
	});
