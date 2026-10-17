"use strict";
// Seasonal events for module suggestions and date windows ("showBetween").
// Windows are month-day pairs ("MM-DD"); a window may wrap the new year (12-01 … 02-28).

// keywords are matched against name, description and tags of the official module list
const EVENTS = [
	{ id: "halloween", from: "10-15", until: "11-01", keywords: ["halloween", "pumpkin", "spooky"] },
	{ id: "christmas", from: "11-25", until: "12-26", keywords: ["christmas", "xmas", "advent", "santa"] },
	{ id: "winter", from: "12-01", until: "02-28", keywords: ["snow", "snowflake", "winter"] },
	{ id: "newyear", from: "12-31", until: "01-01", keywords: ["new year", "newyear", "firework", "countdown"] },
	{ id: "valentine", from: "02-07", until: "02-14", keywords: ["valentine", "valentines"] },
	{ id: "easter", easter: true, keywords: ["easter", "bunny"] }
];

const pad = (n) => String(n).padStart(2, "0");
const md = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Easter Sunday (Gregorian calendar, anonymous algorithm)
function easter(year) {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return new Date(year, month - 1, day);
}

function windowOf(event, year) {
	if (!event.easter) return { from: event.from, until: event.until };
	const sunday = easter(year);
	const from = new Date(sunday);
	from.setDate(from.getDate() - 14);
	const until = new Date(sunday);
	until.setDate(until.getDate() + 1);
	return { from: md(from), until: md(until) };
}

function validMD(s) {
	const m = /^(\d{2})-(\d{2})$/.exec(String(s));
	if (!m) return false;
	const month = Number(m[1]);
	const day = Number(m[2]);
	return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

// Is the date inside the window (inclusive)? Works across the new year.
function inWindow(date, from, until) {
	const x = md(date);
	return from <= until ? x >= from && x <= until : x >= from || x <= until;
}

// Days until the window starts (0 if inside it).
function daysUntil(date, from, until) {
	if (inWindow(date, from, until)) return 0;
	const [m, d] = from.split("-").map(Number);
	let start = new Date(date.getFullYear(), m - 1, d);
	if (start < date) start = new Date(date.getFullYear() + 1, m - 1, d);
	return Math.ceil((start - date) / 86400000);
}

// Events that are on now or start within `ahead` days, closest first.
function upcoming(date = new Date(), ahead = 21) {
	return EVENTS.map((e) => {
		const w = windowOf(e, date.getFullYear());
		return { id: e.id, keywords: e.keywords, ...w, active: inWindow(date, w.from, w.until), inDays: daysUntil(date, w.from, w.until) };
	})
		.filter((e) => e.inDays <= ahead)
		.sort((a, b) => a.inDays - b.inDays);
}

function matches(text, keywords) {
	const t = String(text || "").toLowerCase();
	return keywords.some((k) => (k.includes(" ") ? t.includes(k) : new RegExp(`\\b${k}`).test(t)));
}

module.exports = { EVENTS, upcoming, inWindow, validMD, matches, windowOf };
