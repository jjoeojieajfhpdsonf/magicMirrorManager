"use strict";
// Live preview: a second, small HTTP server that forwards everything to the running
// MagicMirror, with two exceptions:
//   - the config the browser loads is replaced by the draft (GET <basePath>config/ as JSON
//     since MagicMirror 2.34, config/config.js as a script before),
//   - the page gets a tiny script that reports where each module is drawn.
// It needs its own port because MagicMirror's front end uses absolute paths
// (/socket.io, /modules …) that can't live below a sub path of the manager.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateConfig } = require("./config");

const AGENT_PATH = "/__mmm-preview/agent.js";
const AGENT_FILE = path.join(__dirname, "..", "public", "preview-agent.js");

class Preview {
	constructor({ port, host, mirror, draftText }) {
		this.port = port;
		this.host = host;
		this.mirror = mirror;
		this.draftText = draftText;
		this.server = null;
		// Which MagicMirror start each preview page was loaded from, and which socket.io
		// session belongs to which page. See guardSocket().
		this.pages = new Map();
		this.sids = new Map();
		this.startupCache = { value: null, at: 0 };
	}

	start() {
		this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => this.fail(res, err)));
		this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head).catch(() => socket.destroy()));
		this.server.on("error", (err) => {
			console.error(`Live preview disabled: ${err.message}`);
			this.server = null;
		});
		this.server.listen(this.port, this.host);
	}

	target() {
		const url = new URL(this.mirror.baseUrl() + "/");
		const basePath = url.pathname;
		return { url, basePath, secure: url.protocol === "https:", hostname: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
	}

	async handle(req, res) {
		const t = this.target();
		const pathname = req.url.split("?")[0];
		if (pathname === AGENT_PATH) {
			res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
			res.end(fs.readFileSync(AGENT_FILE));
			return;
		}
		if (req.method === "GET" && (pathname === `${t.basePath}config/` || pathname === `${t.basePath}config`)) return this.serveConfig(req, res, t);
		if (req.method === "GET" && pathname === `${t.basePath}config/config.js`) return this.serveConfigScript(req, res);
		if (req.method === "GET" && pathname === t.basePath) return this.serveIndex(req, res, t);
		if (pathname.includes("/socket.io/") && !(await this.guardSocket(req, res, t))) return;
		this.forward(req, res, t);
	}

	// A preview page loaded before MagicMirror restarted must not talk to the new process:
	// socket.io would reconnect on its own and modules like MMM-WatchDog react to that
	// (its node_helper exits when a PING arrives before the page sent its config).
	async guardSocket(req, res, t) {
		const page = this.pageOf(req);
		if (page === null) return true;
		if (this.pages.get(page) === (await this.startup(t))) return true;
		res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("This preview was loaded before MagicMirror restarted.");
		return false;
	}

	pageOf(req) {
		const sid = new URL(req.url, "http://x").searchParams.get("sid");
		if (sid && this.sids.has(sid)) return this.sids.get(sid);
		try {
			const page = new URL(req.headers.referer).searchParams.get("mmm");
			return page && this.pages.has(page) ? page : null;
		} catch {
			return null;
		}
	}

	async startup(t) {
		if (Date.now() - this.startupCache.at < 1500) return this.startupCache.value;
		try {
			const r = await this.fetch(t, `${t.basePath}startup`);
			this.startupCache = { value: r.status === 200 ? r.body : null, at: Date.now() };
		} catch {
			this.startupCache = { value: null, at: Date.now() };
		}
		return this.startupCache.value;
	}

	remember(map, key, value, max) {
		map.set(key, value);
		if (map.size > max) map.delete(map.keys().next().value);
	}

	// The live config of MagicMirror (with all its defaults) plus the draft on top.
	async serveConfig(req, res, t) {
		const live = await this.fetch(t, `${t.basePath}config/`);
		if (live.status !== 200) return this.fail(res, new Error(`MagicMirror answered ${live.status}`));
		const base = JSON.parse(live.body);
		let draft;
		try {
			draft = evaluateConfig(this.draftText(), this.mirror.configPath, { redactSecrets: true });
		} catch (err) {
			return this.fail(res, err);
		}
		const merged = { ...base, ...JSON.parse(serialize(draft)) };
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(merged));
	}

	// Older MagicMirror versions load config.js as a script and merge the defaults themselves.
	serveConfigScript(req, res) {
		let draft;
		try {
			draft = evaluateConfig(this.draftText(), this.mirror.configPath, { redactSecrets: true });
		} catch (err) {
			return this.fail(res, err);
		}
		res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
		res.end(`var config = ${toScript(draft)};\nif (typeof module !== "undefined") { module.exports = config; }\n`);
	}

	async serveIndex(req, res, t) {
		const id = new URL(req.url, "http://x").searchParams.get("mmm");
		if (id) this.remember(this.pages, id, await this.startup(t), 100);
		const page = await this.fetch(t, t.basePath);
		const html = page.body.replace("</body>", `<script src="${AGENT_PATH}"></script>\n</body>`);
		// same-origin referrers let us tell the requests of different preview pages apart
		res.writeHead(page.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin" });
		res.end(html);
	}

	forward(req, res, t) {
		const lib = t.secure ? https : http;
		const headers = { ...req.headers, host: `${t.hostname}:${t.port}` };
		delete headers["accept-encoding"];
		// MagicMirror rejects requests from a foreign origin; to it, we are the page.
		if (headers.origin) headers.origin = t.url.origin;
		if (headers.referer) headers.referer = t.url.origin + "/";
		const up = lib.request({ hostname: t.hostname, port: t.port, path: req.url, method: req.method, headers, rejectUnauthorized: false }, (r) => {
			const h = { ...r.headers };
			delete h["x-frame-options"];
			delete h["strict-transport-security"];
			if (h["content-security-policy"]) h["content-security-policy"] = h["content-security-policy"].replace(/frame-ancestors[^;]*;?/g, "");
			// remember the socket.io session of a preview page (from the handshake answer)
			const page = req.url.includes("/socket.io/") && !/[?&]sid=/.test(req.url) ? this.pageOf(req) : null;
			if (page !== null) {
				let body = "";
				r.setEncoding("utf8");
				r.on("data", (c) => (body += c));
				r.on("end", () => {
					const m = /"sid":"([^"]+)"/.exec(body);
					if (m) this.remember(this.sids, m[1], page, 500);
					delete h["content-length"];
					res.writeHead(r.statusCode, h);
					res.end(body);
				});
				return;
			}
			res.writeHead(r.statusCode, h);
			r.pipe(res);
		});
		up.on("error", (err) => this.fail(res, err));
		req.pipe(up);
	}

	// WebSockets (socket.io) are piped through as raw TCP.
	async upgrade(req, socket, head) {
		const t = this.target();
		const page = this.pageOf(req);
		if (page !== null && this.pages.get(page) !== (await this.startup(t))) {
			socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
			return;
		}
		const connect = t.secure ? (cb) => tls.connect({ host: t.hostname, port: t.port, rejectUnauthorized: false }, cb) : (cb) => net.connect(t.port, t.hostname, cb);
		const up = connect(() => {
			const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const k = req.rawHeaders[i];
				const key = k.toLowerCase();
				const value = key === "host" ? `${t.hostname}:${t.port}` : key === "origin" ? t.url.origin : req.rawHeaders[i + 1];
				lines.push(`${k}: ${value}`);
			}
			up.write(lines.join("\r\n") + "\r\n\r\n");
			if (head && head.length) up.write(head);
			socket.pipe(up).pipe(socket);
		});
		const close = () => {
			socket.destroy();
			up.destroy();
		};
		up.on("error", close);
		socket.on("error", close);
	}

	fetch(t, url) {
		const lib = t.secure ? https : http;
		return new Promise((resolve, reject) => {
			const r = lib.get({ hostname: t.hostname, port: t.port, path: url, headers: { "accept-encoding": "identity" }, rejectUnauthorized: false, timeout: 8000 }, (res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode, body }));
			});
			r.on("timeout", () => r.destroy(new Error("MagicMirror did not answer")));
			r.on("error", reject);
		});
	}

	fail(res, err) {
		if (res.headersSent) return res.destroy();
		res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(`Preview not available: ${err.message}`);
	}
}

// JSON like MagicMirror's /config: functions travel as { __mmFunction: "<source>" }.
function serialize(value) {
	return JSON.stringify(value, (key, v) => (typeof v === "function" ? { __mmFunction: functionSource(v) } : v));
}

// Method shorthand ({ format(x) { … } }) stringifies to "format(x) { … }", which is no
// valid expression on its own; turn it into a function expression.
function functionSource(fn) {
	const src = fn.toString();
	if (/^(async\s+)?(function\b|\(|[\w$]+\s*=>|class\b)/.test(src)) return src;
	const m = /^(async\s+)?(\*\s*)?[\w$]+\s*(?=\()/.exec(src);
	return m ? `${m[1] || ""}function${m[2] ? "*" : ""} ${src.slice(m[0].length)}` : src;
}

// JavaScript source for a config object, keeping functions and regular expressions.
function toScript(value) {
	const raw = [];
	const json = JSON.stringify(
		value,
		(key, v) => {
			if (typeof v === "function" || Object.prototype.toString.call(v) === "[object RegExp]") {
				raw.push(typeof v === "function" ? functionSource(v) : v.toString());
				return `__mmm_raw_${raw.length - 1}__`;
			}
			return v;
		},
		"\t"
	);
	return json.replace(/"__mmm_raw_(\d+)__"/g, (m, i) => raw[Number(i)]);
}

module.exports = { Preview, toScript };
