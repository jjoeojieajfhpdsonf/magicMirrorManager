"use strict";
const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Runs a command without a shell. Resolves { code, out } (stdout+stderr), never rejects.
function run(cmd, args, { cwd, timeout = 120000, env, onLine } = {}) {
	return new Promise((resolve) => {
		let out = "";
		let buf = "";
		let child;
		try {
			child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: -1, out: err.message });
			return;
		}
		const timer = setTimeout(() => {
			out += `\n[timeout after ${Math.round(timeout / 1000)} s]`;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3000).unref();
		}, timeout);
		const onData = (d) => {
			const s = d.toString();
			out += s;
			if (out.length > 2_000_000) out = out.slice(-1_000_000);
			if (onLine) {
				buf += s;
				const lines = buf.split(/\r?\n|\r/);
				buf = lines.pop();
				for (const l of lines) if (l.trim()) onLine(l.replace(ANSI, ""));
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: -1, out: `${out}\n${err.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (onLine && buf.trim()) onLine(buf.replace(ANSI, ""));
			resolve({ code: code === null ? -1 : code, out: out.replace(ANSI, "") });
		});
	});
}

// Minimal HTTP(S) GET. Resolves { status, body, headers } or { status: 0, error }.
function httpGet(url, { timeout = 5000, maxBytes = 20_000_000, redirects = 3 } = {}) {
	return new Promise((resolve) => {
		let lib;
		try {
			lib = new URL(url).protocol === "https:" ? https : http;
		} catch (err) {
			resolve({ status: 0, error: err.message });
			return;
		}
		const req = lib.get(url, { timeout, rejectUnauthorized: !/^https:\/\/(localhost|127\.)/.test(url), headers: { "User-Agent": "magicmirror-manager" } }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
				res.resume();
				resolve(httpGet(new URL(res.headers.location, url).toString(), { timeout, maxBytes, redirects: redirects - 1 }));
				return;
			}
			const chunks = [];
			let size = 0;
			res.on("data", (c) => {
				size += c.length;
				if (size > maxBytes) req.destroy(new Error("response too large"));
				else chunks.push(c);
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", (err) => resolve({ status: 0, error: err.message }));
		});
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", (err) => resolve({ status: 0, error: err.message }));
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Writes a file atomically (temp file + rename) so a crash never leaves half a file.
function writeAtomic(file, text) {
	const tmp = `${file}.mmm-tmp-${process.pid}`;
	fs.writeFileSync(tmp, text);
	try {
		const mode = fs.statSync(file).mode;
		fs.chmodSync(tmp, mode);
	} catch {
		// new file
	}
	fs.renameSync(tmp, file);
}

function readJSON(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJSON(file, value) {
	writeAtomic(file, JSON.stringify(value, null, "\t"));
}

function timestamp(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Reads the last `bytes` of a file starting at `from` (or the tail if from is undefined).
function readTail(file, bytes = 64 * 1024, from) {
	try {
		const size = fs.statSync(file).size;
		const start = from !== undefined ? Math.max(0, Math.min(from, size)) : Math.max(0, size - bytes);
		const len = Math.min(size - start, from !== undefined ? 4 * 1024 * 1024 : bytes);
		if (len <= 0) return "";
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, start);
		fs.closeSync(fd);
		return buf.toString("utf8").replace(ANSI, "");
	} catch {
		return "";
	}
}

function fileSize(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

module.exports = { run, httpGet, sleep, writeAtomic, readJSON, writeJSON, timestamp, readTail, fileSize, ANSI };
