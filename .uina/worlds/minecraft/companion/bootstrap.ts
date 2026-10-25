/** No game/runtime/storage imports until the parent assigns both Jobs and sends init. */
import type { CompanionInit } from "../contracts/executor.js";
import type { JsonValue } from "../contracts/values.js";
import { RpcPeer, RpcError, type WireEndpoint } from "../executor/ipc.js";
import { selfProcessIdentity } from "../executor/platform/index.js";
import type { ExecutionSide } from "./side.js";

const launch = process.argv[2];
if (!launch || !process.send) throw new Error("managed bootstrap requires a private IPC channel and launch identity");
let side: ExecutionSide | null = null;
let initializing = false;
let disconnected = false;
const initTimeout = setTimeout(() => {
	peer.close();
	process.exit(1);
}, 10_000);
const endpoint: WireEndpoint = {
	send(value, done) {
		if (!process.send || !process.connected) {
			done(new Error("parent disconnected"));
			return;
		}
		process.send(value, (error: Error | null) => done(error));
	},
	onMessage(listener) {
		process.on("message", listener);
		return () => {
			process.off("message", listener);
		};
	},
	onDisconnect(listener) {
		process.on("disconnect", listener);
		return () => {
			process.off("disconnect", listener);
		};
	},
};
const peer = new RpcPeer({
	launch,
	endpoint,
	onFault: () => {
		disconnected = true;
		clearTimeout(initTimeout);
		void side?.close().finally(() => process.exit(1));
		if (!side) process.exit(1);
	},
	handleRequest: async (method, payload, signal) => {
		if (method === "init") {
			if (initializing || side) throw new RpcError("PROTOCOL_ERROR", "init must occur exactly once");
			initializing = true;
			const init = payload as unknown as CompanionInit;
			if (init.launch !== launch) throw new RpcError("PROTOCOL_ERROR", "init launch mismatch");
			const { openExecutionSide } = await import("./side.js");
			side = await openExecutionSide(init, {
				onRetirement: (request) => peer.notify({ v: 1, launch, kind: "retire_required", request }),
				onChanged: () => peer.notify({ v: 1, launch, kind: "changed", runs: [], statusChanged: true }),
				onGameEvent: (event) =>
					peer.notify({ v: 1, launch, kind: "changed", runs: [], statusChanged: false, events: [event] }),
			});
			if (disconnected) {
				await side.close();
				throw new RpcError("EXECUTOR_UNAVAILABLE", "parent lost during initialization");
			}
			clearTimeout(initTimeout);
			return side.inspect() as unknown as JsonValue;
		}
		if (!side) throw new RpcError("EXECUTOR_UNAVAILABLE", "bootstrap has not initialized");
		const result = await side.dispatch(method, payload, signal);
		if (method === "shutdown") {
			// Reply uses the same send queue. Disconnect only after it has drained.
			setImmediate(() => {
				void peer.drain().then(() => {
					peer.close();
					process.disconnect?.();
					process.exitCode = 0;
				});
			});
		}
		return result;
	},
});
process.send({ v: 1, launch, kind: "hello", ...selfProcessIdentity() });
