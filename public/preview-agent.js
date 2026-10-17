// Injected into the MagicMirror page of the live preview. It tells the manager
// where each module is drawn, so the manager can lay click and drag targets on top.
(() => {
	if (window.parent === window) return;
	let timer = null;

	// The area a module really draws (texts, icons, images), not its full-width wrapper.
	const contentRect = (el) => {
		let x1 = Infinity;
		let y1 = Infinity;
		let x2 = -Infinity;
		let y2 = -Infinity;
		const add = (r) => {
			if (r.width <= 0 || r.height <= 0) return;
			x1 = Math.min(x1, r.left);
			y1 = Math.min(y1, r.top);
			x2 = Math.max(x2, r.right);
			y2 = Math.max(y2, r.bottom);
		};
		const range = document.createRange();
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.nodeType === Node.TEXT_NODE) {
				if (!n.textContent.trim()) continue;
				range.selectNodeContents(n);
				add(range.getBoundingClientRect());
			} else if (!n.firstElementChild && !n.textContent.trim()) {
				add(n.getBoundingClientRect()); // icons, images, canvases
			}
		}
		const outer = el.getBoundingClientRect();
		if (x1 === Infinity) return outer;
		const pad = 8;
		const left = Math.max(outer.left, x1 - pad);
		const top = Math.max(outer.top - pad, y1 - pad);
		return { x: left, y: top, width: Math.min(outer.right, x2 + pad) - left, height: y2 + pad - top };
	};

	const report = () => {
		const modules = [];
		for (const el of document.querySelectorAll(".module")) {
			const m = /^module_(\d+)_/.exec(el.id);
			if (!m) continue;
			const r = contentRect(el);
			const style = getComputedStyle(el);
			modules.push({ i: Number(m[1]), x: r.x, y: r.y, w: r.width, h: r.height, hidden: style.display === "none" || style.visibility === "hidden" || el.classList.contains("hidden") });
		}
		window.parent.postMessage({ mmmPreview: "layout", width: innerWidth, height: innerHeight, modules }, "*");
	};

	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(report, 120);
	};

	const start = () => {
		new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
		addEventListener("resize", schedule);
		setInterval(report, 2500);
		schedule();
	};

	// Instant feedback from the manager while the page with the new config loads.
	const moduleEl = (id) => document.querySelector(`[id^="module_${id}_"]`);
	addEventListener("message", (ev) => {
		const d = ev.data;
		if (ev.source !== window.parent || !d || typeof d.mmmPreview !== "string") return;
		const el = moduleEl(d.id);
		if (!el) return;
		if (d.mmmPreview === "hide") el.style.display = d.hidden ? "none" : "";
		if (d.mmmPreview === "move") {
			if (!d.position) {
				el.style.display = "none";
				return;
			}
			const box = document.querySelector(`.region.${d.position.split("_").join(".")} > .container`);
			if (!box) return;
			const before = d.before !== null ? moduleEl(d.before) : null;
			if (before && before.parentElement === box) box.insertBefore(el, before);
			else box.appendChild(el);
			box.classList.remove("hidden");
			el.style.display = "";
		}
		schedule();
	});

	if (document.body) start();
	else addEventListener("DOMContentLoaded", start);
})();
