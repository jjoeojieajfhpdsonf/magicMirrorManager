"use strict";
// The official list of third-party modules (modules.magicmirror.builders), cached locally
// so search keeps working offline.
const path = require("node:path");
const { httpGet, readJSON, writeJSON } = require("./util");

const SOURCE = "https://modules.magicmirror.builders/data/modules.json";
const IMAGE_BASE = "https://modules.magicmirror.builders/images/";
const MAX_AGE = 24 * 60 * 60 * 1000;

class Catalog {
	constructor(dataDir) {
		this.file = path.join(dataDir, "catalog.json");
		this.data = readJSON(this.file, null);
		this.loading = null;
	}

	async get({ refresh = false } = {}) {
		const fresh = this.data && Date.now() - this.data.updated < MAX_AGE;
		if (!fresh || refresh) await this.load();
		if (!this.data) return { modules: [], updated: null, error: this.error || "Module list not available" };
		return { modules: this.data.modules, updated: this.data.updated, imageBase: IMAGE_BASE, error: this.error || null };
	}

	load() {
		if (!this.loading) {
			this.loading = (async () => {
				const res = await httpGet(SOURCE, { timeout: 20000 });
				if (res.status !== 200) {
					this.error = `Could not load the module list (${res.error || `HTTP ${res.status}`})`;
					return;
				}
				try {
					const list = JSON.parse(res.body).modules || [];
					const modules = list.map((m) => ({
						id: m.id,
						name: m.name,
						maintainer: m.maintainer,
						url: m.url,
						description: m.description,
						category: m.category,
						stars: m.stars || 0,
						lastCommit: m.lastCommit,
						archived: !!m.isArchived,
						image: m.image || null,
						tags: m.tags || [],
						license: m.license || null
					}));
					this.data = { updated: Date.now(), modules };
					this.error = null;
					writeJSON(this.file, this.data);
				} catch (err) {
					this.error = `Module list could not be read: ${err.message}`;
				}
			})().finally(() => {
				this.loading = null;
			});
		}
		return this.loading;
	}

	find(id) {
		if (!id || !this.data) return null;
		return this.data.modules.find((m) => m.id === id) || null;
	}

	// Best match for an installed module (by repository URL, then by name).
	match(name, remoteUrl) {
		if (!this.data) return null;
		const norm = (u) => String(u || "").toLowerCase().replace(/\.git$/, "").replace(/\/$/, "").replace(/^git@github\.com:/, "https://github.com/");
		const url = norm(remoteUrl);
		return (url && this.data.modules.find((m) => norm(m.url) === url)) || this.data.modules.find((m) => m.name === name) || null;
	}
}

module.exports = { Catalog, IMAGE_BASE };
