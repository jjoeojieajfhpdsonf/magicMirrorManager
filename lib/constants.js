"use strict";
// MagicMirror regions in the order they appear on screen (fallback if index.html can't be read).
const DEFAULT_POSITIONS = [
	"top_bar",
	"top_left",
	"top_center",
	"top_right",
	"upper_third",
	"middle_center",
	"lower_third",
	"bottom_left",
	"bottom_center",
	"bottom_right",
	"bottom_bar",
	"fullscreen_above",
	"fullscreen_below"
];

const BUILTIN_MODULES = ["alert", "calendar", "clock", "compliments", "helloworld", "newsfeed", "updatenotification", "weather"];

module.exports = { DEFAULT_POSITIONS, BUILTIN_MODULES };
