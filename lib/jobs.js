"use strict";
// Long-running actions (apply, install, update …) run as jobs. Only one job runs at a time,
// so two actions can never interfere with each other. The web app polls the job state.
const { UserError } = require("./errors");

class Jobs {
	constructor() {
		this.jobs = new Map();
		this.current = null;
		this.seq = 0;
	}

	busy() {
		return this.current !== null;
	}

	// steps: [{ key, label }]; fn(job) does the work and uses job.step()/job.log().
	start(type, title, steps, fn) {
		if (this.current) throw new UserError("Another action is still running. Please wait until it has finished.");
		const job = {
			id: `${Date.now().toString(36)}${(++this.seq).toString(36)}`,
			type,
			title,
			status: "running",
			started: Date.now(),
			steps: steps.map((s) => ({ ...s, state: "pending", detail: "" })),
			lines: [],
			result: null
		};
		const api = {
			job,
			step: (key, state, detail = "") => {
				const s = job.steps.find((x) => x.key === key);
				if (s) {
					s.state = state;
					if (detail !== undefined) s.detail = detail;
				}
			},
			log: (line) => {
				job.lines.push(String(line));
				if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
			}
		};
		this.jobs.set(job.id, job);
		this.current = job;
		Promise.resolve()
			.then(() => fn(api))
			.then((result) => {
				job.result = result || null;
				if (job.status === "running") job.status = result && result.status ? result.status : "done";
			})
			.catch((err) => {
				job.status = "failed";
				job.error = err && err.message ? err.message : String(err);
				for (const s of job.steps) if (s.state === "running") s.state = "failed";
			})
			.finally(() => {
				job.ended = Date.now();
				// steps that never ran (e.g. after a rollback) are shown as skipped
				for (const st of job.steps) if (st.state === "pending") st.state = "skipped";
				this.current = null;
				// keep the last 20 jobs
				const ids = [...this.jobs.keys()];
				for (const id of ids.slice(0, Math.max(0, ids.length - 20))) this.jobs.delete(id);
			});
		return job;
	}

	get(id) {
		return this.jobs.get(id) || null;
	}
}

module.exports = { Jobs };
