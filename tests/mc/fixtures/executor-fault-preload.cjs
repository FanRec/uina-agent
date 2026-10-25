// Fault injection into the real bootstrap only. Production has no testMode or fault API.
const { isMainThread } = require("node:worker_threads");
if (
	isMainThread &&
	typeof process.send === "function" &&
	/\/companion\/bootstrap\.(?:ts|js)$/.test((process.argv[1] ?? "").replaceAll("\\", "/"))
) {
	let armed = false;
	process.on("message", (frame) => {
		if (armed || frame?.method !== "runtime.attach") return;
		armed = true;
		setTimeout(() => {
			if (process.env.UINA_TEST_EXECUTOR_FAULT === "block") {
				process.stderr.write("MC_FAULT_BLOCK_STARTED\n");
				const until = performance.now() + 30_000;
				while (performance.now() < until) {
					/* parent must retire this unresponsive main thread */
				}
			} else if (process.env.UINA_TEST_EXECUTOR_FAULT === "logs") {
				process.stdout.write("x".repeat(2 * 1024 * 1024));
			}
		}, 150);
	});
}
