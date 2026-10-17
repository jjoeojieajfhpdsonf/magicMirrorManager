"use strict";
// Installed third-party modules: list, install, update (with backup and rollback), uninstall.
const fs = require("node:fs");
const path = require("node:path");
const { run, readJSON, writeJSON, timestamp } = require("./util");
const { UserError } = require("./errors");
const C = require("./config");

const NAME = /^[A-Za-z0-9][\w.-]*$/;
const REPO_URL = /^https:\/\/[\w.-]+(:\d+)?\/[\w.~-]+(\/[\w.~-]+)+?(\.git)?\/?$/;
const KEEP_TRASH = 10;

class Modules {
	constructor(mirror, dataDir) {
		this.mirror = mirror;
		this.updatesFile = path.join(dataDir, "updates.json");
		this.backupDir = path.join(dataDir, "backups", "modules");
		this.trashDir = path.join(dataDir, "trash");
		fs.mkdirSync(this.backupDir, { recursive: true });
		fs.mkdirSync(this.trashDir, { recursive: true });
	}

	dirOf(name) {
		if (!NAME.test(name)) throw new UserError("Invalid module name");
		return path.join(this.mirror.modulesDir(), name);
	}

	// Folders in modules/ (without "default", hidden folders and files).
	installedNames() {
		let names = [];
		try {
			names = fs.readdirSync(this.mirror.modulesDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "default" && d.name !== "node_modules").map((d) => d.name);
		} catch {
			// no modules folder yet
		}
		return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	}

	gitInfo(dir) {
		const gitDir = path.join(dir, ".git");
		if (!fs.existsSync(gitDir)) return null;
		const info = { remote: null, head: null, branch: null };
		try {
			const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
			if (head.startsWith("ref: ")) {
				const ref = head.slice(5);
				info.branch = ref.replace("refs/heads/", "");
				const refFile = path.join(gitDir, ref);
				if (fs.existsSync(refFile)) info.head = fs.readFileSync(refFile, "utf8").trim();
				else {
					const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
					const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
					if (line) info.head = line.split(" ")[0];
				}
			} else info.head = head;
			const cfg = fs.readFileSync(path.join(gitDir, "config"), "utf8");
			const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
			if (m) info.remote = m[1];
		} catch {
			// partial info is fine
		}
		return info;
	}

	packageVersion(dir) {
		const pkg = readJSON(path.join(dir, "package.json"), null);
		return pkg && pkg.version ? pkg.version : null;
	}

	list(catalog, configText) {
		const updates = readJSON(this.updatesFile, {});
		let entries = [];
		try {
			entries = C.listEntries(configText);
		} catch {
			// config can't be parsed; show modules without usage info
		}
		const modules = this.installedNames().map((name) => {
			const dir = path.join(this.mirror.modulesDir(), name);
			const git = this.gitInfo(dir);
			const cat = catalog.match(name, git && git.remote);
			const u = updates[name];
			return {
				name,
				valid: fs.existsSync(path.join(dir, `${name}.js`)),
				version: this.packageVersion(dir),
				commit: git && git.head ? git.head.slice(0, 7) : null,
				git: !!git,
				remote: git ? git.remote : null,
				used: entries.filter((e) => e.module === name).length,
				description: cat ? cat.description : null,
				catalogId: cat ? cat.id : null,
				image: cat ? cat.image : null,
				archived: cat ? cat.archived : false,
				update: u && git && u.head === git.head ? u : null,
				previous: this.previousVersion(name)
			};
		});
		return { modules, builtins: this.mirror.builtinModules(), checked: updates._checked || null, checking: !!this.checking };
	}

	info(name, catalog) {
		if (this.mirror.builtinModules().includes(name)) return { builtin: true };
		let dir;
		try {
			dir = this.dirOf(name);
		} catch {
			return null;
		}
		const git = this.gitInfo(dir);
		const cat = catalog.match(name, git && git.remote);
		return { builtin: false, url: cat ? cat.url : git && git.remote, description: cat ? cat.description : null, image: cat ? cat.image : null };
	}

	// ---------- updates ----------

	async checkUpdates(api) {
		if (this.checking) await this.checking.catch(() => {});
		let done;
		this.checking = new Promise((r) => (done = r));
		try {
			return await this.runUpdateCheck(api);
		} finally {
			this.checking = null;
			done();
		}
	}

	// Waits for a running update check, so git never runs twice in the same folder.
	async idle() {
		if (this.checking) await this.checking.catch(() => {});
	}

	async runUpdateCheck(api) {
		api.step("fetch", "running");
		const names = this.installedNames();
		const result = { _checked: Date.now() };
		let i = 0;
		const worker = async () => {
			while (i < names.length) {
				const name = names[i++];
				const dir = path.join(this.mirror.modulesDir(), name);
				const git = this.gitInfo(dir);
				if (!git) continue;
				api.step("fetch", "running", name);
				const f = await run("git", ["fetch", "--quiet"], { cwd: dir, timeout: 60000 });
				if (f.code !== 0) {
					result[name] = { head: git.head, error: f.out.trim().split("\n").pop() };
					continue;
				}
				const c = await run("git", ["rev-list", "--count", "HEAD..@{u}"], { cwd: dir, timeout: 15000 });
				const behind = c.code === 0 ? Number(c.out.trim()) || 0 : 0;
				let commits = [];
				if (behind > 0) {
					const l = await run("git", ["log", "--format=%s", "-n", "15", "HEAD..@{u}"], { cwd: dir, timeout: 15000 });
					commits = l.out.trim().split("\n").filter(Boolean);
				}
				const s = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, timeout: 15000 });
				result[name] = { head: git.head, behind, commits, localChanges: s.out.trim() !== "", noUpstream: c.code !== 0 };
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
		writeJSON(this.updatesFile, result);
		const count = Object.values(result).filter((u) => u && u.behind > 0).length;
		api.step("fetch", "done", String(count));
		return { status: "done", available: count };
	}

	updateSteps() {
		return [
			{ key: "backup", label: "backup" },
			{ key: "pull", label: "pull" },
			{ key: "deps", label: "deps" },
			{ key: "restart", label: "restart" },
			{ key: "verify", label: "verify" }
		];
	}

	// Updates one module. Any failure restores the backup of the module folder.
	async update(api, name, { restartAndVerify, isActive }) {
		const { step, log } = api;
		await this.idle();
		const dir = this.dirOf(name);
		if (!this.gitInfo(dir)) throw new UserError("This module was not installed with git and can't be updated here");
		step("backup", "running");
		const backup = path.join(this.backupDir, name, timestamp());
		fs.mkdirSync(path.dirname(backup), { recursive: true });
		fs.cpSync(dir, backup, { recursive: true, verbatimSymlinks: true });
		step("backup", "done");
		const oldHead = this.gitInfo(dir).head;

		const restore = async (reason) => {
			log(`Restoring the previous version: ${reason}`);
			api.job.steps.push({ key: "rollback", label: "rollback", state: "running", detail: "" });
			fs.rmSync(dir, { recursive: true, force: true });
			fs.cpSync(backup, dir, { recursive: true, verbatimSymlinks: true });
			if (isActive()) {
				const before = await this.mirror.snapshot();
				const r = await this.mirror.restart();
				const v = r.ok ? await this.mirror.verify(before) : { ok: false, reason: r.message };
				step("rollback", v.ok ? "done" : "failed", v.ok ? "" : v.reason);
			} else step("rollback", "done");
			return { status: "rolledBack", reason };
		};

		step("pull", "running");
		const pull = await run("git", ["pull", "--ff-only"], { cwd: dir, timeout: 300000, onLine: log });
		if (pull.code !== 0) {
			step("pull", "failed", lastLine(pull.out));
			return restore(`git pull failed: ${lastLine(pull.out)}`);
		}
		const newHead = this.gitInfo(dir).head;
		step("pull", "done", oldHead === newHead ? "same" : `${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)}`);

		step("deps", "running");
		const diff = await run("git", ["diff", "--name-only", oldHead, newHead], { cwd: dir, timeout: 15000 });
		const changed = diff.out.split("\n");
		const needsDeps = changed.includes("package.json") || changed.includes("package-lock.json") || (this.hasDependencies(dir) && !fs.existsSync(path.join(dir, "node_modules")));
		if (needsDeps) {
			const npm = await this.npmInstall(dir, log);
			if (npm.code !== 0) {
				step("deps", "failed", lastLine(npm.out));
				return restore(`npm install failed: ${lastLine(npm.out)}`);
			}
			step("deps", "done");
		} else step("deps", "skipped");

		if (isActive()) {
			const before = await this.mirror.snapshot();
			const outcome = await restartAndVerify(api, before);
			if (!outcome.ok) return restore(outcome.reason);
		} else {
			step("restart", "skipped");
			step("verify", "skipped");
		}
		this.pruneBackups(name, backup);
		const updates = readJSON(this.updatesFile, {});
		delete updates[name];
		writeJSON(this.updatesFile, updates);
		return { status: "done", from: oldHead.slice(0, 7), to: newHead.slice(0, 7) };
	}

	// The version before the last update (kept until the next update).
	previousVersion(name) {
		const dir = path.join(this.backupDir, name);
		let list = [];
		try {
			list = fs.readdirSync(dir).sort();
		} catch {
			return null;
		}
		const last = list[list.length - 1];
		if (!last) return null;
		const git = this.gitInfo(path.join(dir, last));
		return { id: last, commit: git && git.head ? git.head.slice(0, 7) : null, version: this.packageVersion(path.join(dir, last)) };
	}

	// Swaps the module folder with the backup from before the last update.
	async revert(api, name, { restartAndVerify, isActive }) {
		const { step } = api;
		await this.idle();
		const dir = this.dirOf(name);
		const prev = this.previousVersion(name);
		if (!prev) throw new UserError("There is no earlier version of this module");
		const backup = path.join(this.backupDir, name, prev.id);
		const parked = path.join(this.backupDir, name, timestamp());
		step("restore", "running");
		fs.renameSync(dir, parked);
		fs.renameSync(backup, dir);
		step("restore", "done", prev.commit || "");
		if (isActive()) {
			const outcome = await restartAndVerify(api, await this.mirror.snapshot());
			if (!outcome.ok) {
				// the old version doesn't run either: put the newer one back
				fs.renameSync(dir, backup);
				fs.renameSync(parked, dir);
				const r = await this.mirror.restart();
				if (r.ok) await this.mirror.verify(await this.mirror.snapshot());
				return { status: "rolledBack", reason: outcome.reason };
			}
		} else {
			step("restart", "skipped");
			step("verify", "skipped");
		}
		// the newer version stays available as "previous", so the undo can be undone
		const updates = readJSON(this.updatesFile, {});
		delete updates[name];
		writeJSON(this.updatesFile, updates);
		return { status: "done" };
	}

	trash() {
		let items = [];
		try {
			items = fs.readdirSync(this.trashDir);
		} catch {
			return [];
		}
		return items
			.map((id) => {
				const m = /^(.+)-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})$/.exec(id);
				return m ? { id, name: m[1], time: m[2] } : null;
			})
			.filter(Boolean)
			.sort((a, b) => b.time.localeCompare(a.time));
	}

	async restoreFromTrash(api, id) {
		const item = this.trash().find((x) => x.id === id);
		if (!item) throw new UserError("Not found in the trash");
		const dir = this.dirOf(item.name);
		if (fs.existsSync(dir)) throw new UserError(`${item.name} is installed already`);
		api.step("restore", "running");
		fs.renameSync(path.join(this.trashDir, id), dir);
		api.step("restore", "done");
		return { status: "done", name: item.name };
	}

	// Removes a module from the trash for good.
	deleteFromTrash(id) {
		const item = this.trash().find((x) => x.id === id);
		if (!item) throw new UserError("Not found in the trash");
		fs.rmSync(path.join(this.trashDir, item.id), { recursive: true, force: true });
	}

	// Keeps only the newest module backup.
	pruneBackups(name, keep) {
		const dir = path.join(this.backupDir, name);
		for (const d of fs.readdirSync(dir)) if (path.join(dir, d) !== keep) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
	}

	hasDependencies(dir) {
		const pkg = readJSON(path.join(dir, "package.json"), null);
		return !!(pkg && pkg.dependencies && Object.keys(pkg.dependencies).length);
	}

	npmInstall(dir, log) {
		const lock = fs.existsSync(path.join(dir, "package-lock.json"));
		const args = [lock ? "ci" : "install", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier"];
		log(`npm ${args.join(" ")}`);
		return run("npm", args, { cwd: dir, timeout: 20 * 60000, onLine: log });
	}

	// ---------- install ----------

	installSteps() {
		return [
			{ key: "download", label: "download" },
			{ key: "deps", label: "deps" },
			{ key: "check", label: "checkModule" }
		];
	}

	async install(api, { url, name }) {
		const { step, log } = api;
		await this.idle();
		const cleanUrl = String(url || "").trim().replace(/\/$/, "");
		if (!REPO_URL.test(cleanUrl)) throw new UserError("Please use an https:// repository address");
		const folder = name || cleanUrl.split("/").pop().replace(/\.git$/, "");
		const dir = this.dirOf(folder);
		if (fs.existsSync(dir)) throw new UserError(`${folder} is already installed`);
		// Clone next to the target first, so a failed install never leaves a half module behind.
		const tmp = path.join(this.mirror.modulesDir(), `.installing-${folder}`);
		fs.rmSync(tmp, { recursive: true, force: true });
		fs.mkdirSync(this.mirror.modulesDir(), { recursive: true });

		step("download", "running");
		const clone = await run("git", ["clone", "--quiet", cleanUrl, tmp], { timeout: 600000, onLine: log, env: { GIT_TERMINAL_PROMPT: "0" } });
		if (clone.code !== 0) {
			fs.rmSync(tmp, { recursive: true, force: true });
			step("download", "failed", lastLine(clone.out));
			return { status: "failed", reason: lastLine(clone.out) };
		}
		step("download", "done");

		step("deps", "running");
		if (this.hasDependencies(tmp)) {
			const npm = await this.npmInstall(tmp, log);
			if (npm.code !== 0) {
				fs.rmSync(tmp, { recursive: true, force: true });
				step("deps", "failed", lastLine(npm.out));
				return { status: "failed", reason: `npm install failed: ${lastLine(npm.out)}` };
			}
			step("deps", "done");
		} else step("deps", "skipped");

		step("check", "running");
		const main = path.join(tmp, `${folder}.js`);
		if (!fs.existsSync(main)) {
			fs.rmSync(tmp, { recursive: true, force: true });
			step("check", "failed", `${folder}.js`);
			return { status: "failed", reason: `This repository doesn't look like a MagicMirror module (${folder}.js is missing)` };
		}
		fs.renameSync(tmp, dir);
		step("check", "done");
		return { status: "done", name: folder };
	}

	// ---------- uninstall ----------

	async uninstall(api, name) {
		const dir = this.dirOf(name);
		if (!fs.existsSync(dir)) throw new UserError("Module not found");
		api.step("remove", "running");
		const target = path.join(this.trashDir, `${name}-${timestamp()}`);
		try {
			fs.renameSync(dir, target);
		} catch {
			// different file system: copy, then delete
			fs.cpSync(dir, target, { recursive: true, verbatimSymlinks: true });
			fs.rmSync(dir, { recursive: true, force: true });
		}
		const items = fs.readdirSync(this.trashDir).sort();
		for (const old of items.slice(0, Math.max(0, items.length - KEEP_TRASH))) fs.rmSync(path.join(this.trashDir, old), { recursive: true, force: true });
		api.step("remove", "done");
		return { status: "done" };
	}
}

function lastLine(text) {
	const lines = String(text || "").trim().split("\n").filter((l) => l.trim());
	return (lines.pop() || "").slice(0, 300);
}

module.exports = { Modules };
