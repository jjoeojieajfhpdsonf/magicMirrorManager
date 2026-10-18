# Changelog

## Unreleased

- Seasonal suggestions in the modules tab (Halloween, Christmas, winter, New Year's Eve, Valentine's Day, Easter): modules already installed, and matching ones from the official list.
- Date windows per module: `showBetween: ["10-15", "11-01"]` next to the module in `config.js`; the manager switches it on and off every year (checked hourly, applied with check and rollback).
- Modules can describe their settings in `mm-manager.json` (labels in several languages, help texts, sliders, date pickers, a switch per entry, cards for lists, an "Advanced" section). See `docs/module-schema.md`.
- "Check now" runs in the background without a window. If another action is running (e.g. a date window switching a module off), it waits instead of failing. "Another action is still running" now says which one.
- Dropdown values are also found in helper scripts next to the module's main file.
- Guard against settings that freeze the mirror: huge numbers ask first; a draft whose preview hangs is remembered, shown as a sketch with a warning and applying asks first.

## 0.9.0 – 2026-10-17

First public version.

- **Live preview:** the mirror tab shows the real MagicMirror page with your collected changes. Move modules by drag and drop right in the preview; moving, switching off, titles and settings show up at once.
- **Safe apply:** changes are collected first, then checked (including MagicMirror's own config check), backed up, written atomically, MagicMirror is restarted and watched. If it doesn't run, the previous `config.js` comes back automatically.
- **Surgical config edits:** only the changed spot of `config.js` is touched; comments, functions and `${ENV}` placeholders stay.
- **Settings without code:** defaults are read from each module's source; switches, fields, dropdowns (values found in the module's code), and forms for lists and nested settings.
- **Modules:** search the official module list, install, update (checked every 6 hours), undo the last update, uninstall to a trash and restore from it.
- **MagicMirror updates** with the same check and automatic rollback; Node.js requirements are checked first.
- **History** of every applied change with one-tap restore.
- Works with pm2 (detected automatically) or any restart command (Docker, systemd).
- Optional password (also protects the live preview), German and English interface, phone and laptop layouts, demo mode.
