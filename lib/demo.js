"use strict";
// Demo mode: creates a small fake MagicMirror installation so the manager can be tried
// without a mirror. Restarts are simulated; everything else (config edits, backups,
// rollback, git installs) works on these files for real.
const fs = require("node:fs");
const path = require("node:path");

const BUILTIN_DEFAULTS = {
	alert: "{\n\teffect: \"slide\",\n\talert_effect: \"jelly\",\n\tdisplay_time: 3500,\n\tposition: \"center\",\n\twelcome_message: false\n}",
	calendar: "{\n\tmaximumEntries: 10,\n\tmaximumNumberOfDays: 365,\n\tlimitDays: 0,\n\tpastDaysCount: 0,\n\tdisplaySymbol: true,\n\tdefaultSymbol: \"calendar-alt\",\n\tshowLocation: false,\n\tdisplayRepeatingCountTitle: false,\n\twrapEvents: false,\n\tmaxTitleLength: 25,\n\tfetchInterval: 60 * 60 * 1000,\n\tanimationSpeed: 2000,\n\tfade: true,\n\ttimeFormat: \"relative\",\n\tdateFormat: \"MMM Do\",\n\tcolored: false,\n\tcalendars: [\n\t\t{\n\t\t\tsymbol: \"calendar-alt\",\n\t\t\turl: \"https://www.calendarlabs.com/templates/ical/US-Holidays.ics\"\n\t\t}\n\t]\n}",
	clock: "{\n\tdisplayType: \"digital\",\n\ttimeFormat: config.timeFormat,\n\ttimezone: null,\n\tdisplaySeconds: true,\n\tshowPeriod: true,\n\tshowDate: true,\n\tshowTime: true,\n\tshowWeek: false,\n\tdateFormat: \"dddd, LL\",\n\tsendNotifications: false,\n\tanalogSize: \"200px\",\n\tanalogFace: \"simple\",\n\tshowSunTimes: false,\n\tshowMoonTimes: false,\n\tlat: 47.630539,\n\tlon: -122.344147\n}",
	compliments: "{\n\tcompliments: {\n\t\tanytime: [\"Hey there sexy!\"],\n\t\tmorning: [\"Good morning, handsome!\", \"Enjoy your day!\"],\n\t\tevening: [\"Wow, you look hot!\", \"You look nice!\"]\n\t},\n\tupdateInterval: 30000,\n\tremoteFile: null,\n\tfadeSpeed: 4000,\n\tmorningStartTime: 3,\n\tafternoonStartTime: 12,\n\teveningStartTime: 17,\n\trandom: true\n}",
	helloworld: "{\n\ttext: \"Hello World!\"\n}",
	newsfeed: "{\n\tfeeds: [\n\t\t{\n\t\t\ttitle: \"New York Times\",\n\t\t\turl: \"https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml\",\n\t\t\tencoding: \"UTF-8\"\n\t\t}\n\t],\n\tshowAsList: false,\n\tshowSourceTitle: true,\n\tshowPublishDate: true,\n\tshowDescription: false,\n\twrapTitle: true,\n\thideLoading: false,\n\treloadInterval: 5 * 60 * 1000,\n\tupdateInterval: 10 * 1000,\n\tanimationSpeed: 2.5 * 1000,\n\tmaxNewsItems: 0\n}",
	updatenotification: "{\n\tupdateInterval: 10 * 60 * 1000,\n\trefreshInterval: 24 * 60 * 60 * 1000,\n\tignoreModules: [],\n\tsendUpdatesNotifications: false,\n\tupdates: [],\n\tupdateTimeout: 2 * 60 * 1000,\n\tupdateAutorestart: false\n}",
	weather: "{\n\tweatherProvider: \"openmeteo\",\n\troundTemp: false,\n\ttype: \"current\",\n\tlang: config.language,\n\tunits: config.units,\n\ttempUnits: config.units,\n\twindUnits: config.units,\n\tupdateInterval: 10 * 60 * 1000,\n\tanimationSpeed: 1000,\n\tshowFeelsLike: true,\n\tshowHumidity: \"none\",\n\tshowSun: true,\n\tdegreeLabel: false,\n\tmaxNumberOfDays: 5,\n\tcolored: false,\n\tfade: true\n}"
};

const DEMO_CONFIG = `/* MagicMirror² config (demo)
 * Everything you change in the manager lands here – comments included.
 */
let config = {
	address: "localhost",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],

	language: "de",
	locale: "de-CH",
	timeFormat: 24,
	units: "metric",

	modules: [
		{
			module: "alert"
		},
		{
			module: "clock",
			position: "top_left",
			config: {
				displaySeconds: false,
				showWeek: true
			}
		},
		// family calendar
		{
			module: "calendar",
			header: "Termine",
			position: "top_left",
			config: {
				maximumEntries: 6,
				calendars: [
					{
						symbol: "calendar-check",
						url: "https://example.com/family.ics"
					}
				]
			}
		},
		{
			module: "weather",
			position: "top_right",
			config: {
				weatherProvider: "openmeteo",
				type: "current",
				lat: 47.3769,
				lon: 8.5417
			}
		},
		{
			module: "weather",
			position: "top_right",
			header: "Prognose",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: 47.3769,
				lon: 8.5417
			}
		},
		{
			module: "MMM-DemoTransit",
			position: "bottom_left",
			config: {
				station: "Zürich HB",
				maxEntries: 5
			}
		},
		{
			module: "compliments",
			position: "lower_third"
		},
		{
			module: "newsfeed",
			position: "bottom_bar",
			disabled: true,
			config: {
				feeds: [
					{
						title: "SRF News",
						url: "https://www.srf.ch/news/bnf/rss/1646"
					}
				]
			}
		}
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
`;

const FAKE_MODULES = {
	"MMM-DemoTransit": "{\n\tstation: \"\",\n\tmaxEntries: 8,\n\tshowPlatform: true,\n\tshowDelay: true,\n\tupdateInterval: 60 * 1000,\n\ttransportTypes: [\"train\", \"tram\", \"bus\"]\n}",
	"MMM-DemoPhotos": "{\n\talbumUrl: \"\",\n\tinterval: 30,\n\topacity: 0.6,\n\tfit: \"cover\",\n\tshuffle: true\n}"
};

function writeModule(dir, name, defaults) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.js`), `Module.register("${name}", {\n\tdefaults: ${defaults.replace(/\n/g, "\n\t")},\n\n\tgetDom() {\n\t\treturn document.createElement("div");\n\t}\n});\n`);
}

function setupDemo(dataDir) {
	const mmDir = path.join(dataDir, "demo", "MagicMirror");
	if (!fs.existsSync(path.join(mmDir, "package.json"))) {
		fs.mkdirSync(path.join(mmDir, "js"), { recursive: true });
		fs.mkdirSync(path.join(mmDir, "config"), { recursive: true });
		fs.writeFileSync(path.join(mmDir, "package.json"), JSON.stringify({ name: "magicmirror", version: "2.38.0" }, null, 2));
		fs.writeFileSync(path.join(mmDir, "config", "config.js"), DEMO_CONFIG);
		const defDir = path.join(mmDir, "defaultmodules");
		fs.mkdirSync(defDir, { recursive: true });
		fs.writeFileSync(path.join(defDir, "defaultmodules.js"), `const defaultModules = ${JSON.stringify(Object.keys(BUILTIN_DEFAULTS))};\nif (typeof module !== "undefined") { module.exports = defaultModules; }\n`);
		for (const [name, def] of Object.entries(BUILTIN_DEFAULTS)) writeModule(path.join(defDir, name), name, def);
		for (const [name, def] of Object.entries(FAKE_MODULES)) writeModule(path.join(mmDir, "modules", name), name, def);
	}
	return mmDir;
}

module.exports = { setupDemo };
