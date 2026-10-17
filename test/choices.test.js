"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { findChoices } = require("../lib/choices");

test("keys of a lookup table (MMM-Snow style)", () => {
	const src = `Module.register("MMM-Snow", {
	defaults: { flakeCount: 100, theme: "winter" },
	themes: {
		"winter": { flakePrefix: "snow" },
		"love": { flakePrefix: "heart" },
		"water": { flakePrefix: "bubble" }
	},
	getDom() { var s = this.themes[this.config.theme]; }
});`;
	assert.deepEqual(findChoices(src, "theme").sort(), ["love", "water", "winter"]);
	assert.deepEqual(findChoices(src, "flakeCount"), []);
});

test("comparisons, switch and includes", () => {
	const src = `
	if (this.config.mode === "compact") {}
	if ('wide' == this.config.mode) {}
	switch (this.config.units) { case "metric": break; case "imperial": { x(); } break; }
	const ok = ["left", "right"].includes(this.config.align);
	if (typeof this.config.mode === "string") {}`;
	assert.deepEqual(findChoices(src, "mode").sort(), ["compact", "wide"]);
	assert.deepEqual(findChoices(src, "units").sort(), ["imperial", "metric"]);
	assert.deepEqual(findChoices(src, "align").sort(), ["left", "right"]);
});
