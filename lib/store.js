"use strict";
// Persistent state in the data folder: the draft (pending changes) and the config history.
const fs = require("node:fs");
const path = require("node:path");
const { readJSON, writeJSON, writeAtomic, timestamp } = require("./util");

const KEEP_BACKUPS = 50;

class Store {
	constructor(dataDir) {
		this.dir = dataDir;
		this.backupDir = path.join(dataDir, "backups", "config");
		fs.mkdirSync(this.backupDir, { recursive: true });
		this.draftFile = path.join(dataDir, "draft.json");
		this.historyFile = path.join(dataDir, "history.json");
	}

	// ---------- draft: changes collected before they are applied ----------

	getDraft() {
		return readJSON(this.draftFile, null);
	}

	saveDraft(draft) {
		writeJSON(this.draftFile, { ...draft, updated: Date.now() });
	}

	clearDraft() {
		fs.rmSync(this.draftFile, { force: true });
	}

	// ---------- history: one backup of config.js before every applied change ----------

	history() {
		return readJSON(this.historyFile, []);
	}

	addBackup(text, info) {
		const list = this.history();
		let id = timestamp();
		while (list.some((h) => h.id === id)) id += "b";
		writeAtomic(path.join(this.backupDir, `${id}.js`), text);
		list.unshift({ id, time: Date.now(), ...info });
		for (const old of list.splice(KEEP_BACKUPS)) fs.rmSync(path.join(this.backupDir, `${old.id}.js`), { force: true });
		writeJSON(this.historyFile, list);
		return id;
	}

	updateBackup(id, patch) {
		const list = this.history();
		const h = list.find((x) => x.id === id);
		if (h) Object.assign(h, patch);
		writeJSON(this.historyFile, list);
	}

	backupText(id) {
		if (!/^[\w-]+$/.test(id)) return null;
		try {
			return fs.readFileSync(path.join(this.backupDir, `${id}.js`), "utf8");
		} catch {
			return null;
		}
	}
}

module.exports = { Store };
