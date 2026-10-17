// Injected into the MagicMirror page of the live preview. It tells the manager
// where each module is drawn, so the manager can lay click and drag targets on top.
(() => {
	if (window.parent === window) return;
	let timer = null;

	const report = () => {
		const modules = [];
		for (const el of document.querySelectorAll(".module")) {
			const m = /^module_(\d+)_/.exec(el.id);
			if (!m) continue;
			const r = el.getBoundingClientRect();
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

	if (document.body) start();
	else addEventListener("DOMContentLoaded", start);
})();
