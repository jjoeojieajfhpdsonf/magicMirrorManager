# Describing your module's settings (`mm-manager.json`)

Without any help, MagicMirror Manager reads a module's `defaults` and shows one field per key: switches for booleans, fields for numbers and text, dropdowns for values it finds in the code, forms for lists and objects. The key names are shown as they are (`fireworksHours`, `checkInterval` …).

If you write a module, you can do better: put a file called `mm-manager.json` next to your module's main file. The manager then shows your labels (in the user's language), help texts, dropdowns with readable names, sliders, date pickers, a switch per entry of a map, and cards for lists. Settings you mark as `advanced` go behind an "Advanced" row.

The file is optional and only read by the manager. MagicMirror ignores it. Settings the user has in `config.js` but your file doesn't describe still show up, under "Other settings".

A complete example is [MMM-SwissOverlay's mm-manager.json](https://github.com/jjoeojieajfhpdsonf/MMM-SwissOverlay/blob/main/mm-manager.json).

## Format

```json
{
	"fields": [
		{ "key": "style", "type": "select", "label": { "en": "Style", "de": "Stil" },
		  "choices": [ { "value": "graphics", "label": { "en": "Drawings", "de": "Grafiken" } },
		               { "value": "emoji", "label": "Emoji" } ] },
		{ "key": "opacity", "type": "range", "label": "Opacity", "min": 0.1, "max": 1, "step": 0.05 },
		{ "key": "fps", "type": "number", "label": "Frames per second", "min": 10, "max": 60, "advanced": true }
	]
}
```

`fields` is the list of settings, in the order they are shown. Every field has:

| Property | Meaning |
|---|---|
| `key` | The key in `config` (and in your `defaults`) |
| `type` | See below. Without a type, a text field is used. |
| `label` | Name shown to the user |
| `help` | Short explanation below the name (optional) |
| `advanced` | `true` puts the field behind "Advanced" |
| `hidden` | `true` leaves it out completely |
| `default` | Only needed when your `defaults` don't have the value (e.g. inside maps and lists) |

Any text (`label`, `help`, `placeholder`, choice labels) is either a plain string or an object with one string per language: `{ "en": "…", "de": "…" }`. English is used when the user's language is missing.

The default value comes from your module's `defaults`. When the user picks the default again, the key is removed from `config.js`, so the file stays short.

## Types

| Type | Shows | Value |
|---|---|---|
| `toggle` | A switch | `true` / `false` |
| `select` | A dropdown of `choices: [{ value, label }]` | Any JSON value, including `null` |
| `number` | A number field; `min`/`max` are enforced, empty means default | Number |
| `range` | A slider with `min`, `max`, `step` | Number |
| `text` | A text field (`placeholder`, `nullable: true` stores `null` when empty) | String |
| `date` | Day and month, every year (`placeholder` is shown while unset) | `"MM-DD"` |
| `fulldate` | A calendar date | `"YYYY-MM-DD"` or `null` |
| `hours` | Two times of day; unset means all day | `["18:00", "23:00"]` |
| `tags` | A list of short texts (e.g. emojis) | `["🎃", "👻"]` |
| `colors` | A list of colour pickers | `["#ff9a3c", "#ffffff"]` |
| `map` | One row with a switch per known entry; tap to change its details | See below |
| `list` | One card per item; items can be added and removed | See below |

### `map`: switch entries on and off and change them

For settings like `occasions: { halloween: false, advent: { candles: false } }`, where your module has a fixed set of entries and the user overrides some of them:

```json
{
	"key": "occasions", "type": "map", "label": "Occasions",
	"keys": [
		{ "value": "halloween", "label": "Halloween", "hint": "24 – 31 October",
		  "defaults": { "from": "10-24", "until": "10-31", "emojis": ["🎃", "🦇"] } },
		{ "value": "advent", "label": "Advent", "hint": "1st Advent to 23 December" }
	],
	"fields": [
		{ "key": "from", "type": "date", "label": "From", "placeholder": "as planned" },
		{ "key": "emojis", "type": "tags", "label": "Emojis" },
		{ "key": "candles", "type": "toggle", "label": "Candles", "default": true, "only": ["advent"] }
	]
}
```

- `keys` are the entries. `hint` is shown under the name while nothing is changed. `defaults` are the entry's own values, shown before the user changes anything.
- `fields` are the details of every entry. `only` limits a field to some entries.
- The switch writes `name: false` when only switched off, and `enabled: false` when there are other changes too. Switching back on removes it again. Your module should accept both.
- Only what differs from the defaults is written: `{ halloween: { from: "10-20" } }`.

### `list`: items the user adds

```json
{
	"key": "custom", "type": "list", "label": "Own occasions", "addLabel": "Add occasion",
	"new": { "name": "", "from": "01-01", "effect": "confetti" },
	"fields": [
		{ "key": "name", "type": "text", "label": "Name" },
		{ "key": "from", "type": "date", "label": "From" },
		{ "key": "until", "type": "date", "label": "Until", "placeholder": "one day" }
	]
}
```

`new` is the item that "Add" creates. Fields that are not in `new` are optional and get a button to clear them. The item's `name` is used as the card title.

## Tips

- Keep `mm-manager.json` in sync with your `defaults`. A small test helps; see [MMM-SwissOverlay's test](https://github.com/jjoeojieajfhpdsonf/MMM-SwissOverlay/blob/main/test/schema.test.js).
- Values written as code in `config.js` (functions, variables) can't be shown in a form. The manager then shows them under "Other settings" as code.
- The manager reads the file every time the settings are opened. You don't need to restart anything while writing it.
