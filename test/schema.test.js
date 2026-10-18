"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSchema } = require("../lib/defaults");

function folder(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-schema-"));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	return dir;
}

test("reads mm-manager.json from the module folder", () => {
	const dir = folder({ "mm-manager.json": JSON.stringify({ fields: [{ key: "style", type: "select", choices: [{ value: "a" }] }] }) });
	assert.equal(readSchema(dir).fields[0].key, "style");
});

test("no file, broken JSON or no field list: no schema (generic editor)", () => {
	assert.equal(readSchema(folder({})), null);
	assert.equal(readSchema(folder({ "mm-manager.json": "{ fields: [" })), null);
	assert.equal(readSchema(folder({ "mm-manager.json": JSON.stringify({ fields: "x" }) })), null);
});
