import { expect, test } from "vitest";

import { createPendingClient } from "../../.uina/worlds/minecraft/driver/mineflayer/pending-client.js";

const opts = { host: "127.0.0.1", port: 25565, username: "UinaPending", version: "1.21.11" };

/**
 * 这里只验证上游接缝本身：不 resume，因此没有任何网络活动。
 * 真服首包探针（dev/probe-first-packet.mjs）另行证明放行后的时序。
 */
test("createPendingClient 构造真实上游 Client，返回时没有 socket", () => {
	const pending = createPendingClient(opts);
	try {
		expect(pending.client.state).toBe("handshaking");
		// 上游在未 setSocket 前是 undefined（不是 null）；判据是"根本没有 socket"。
		expect(pending.client.socket == null).toBe(true);
	} finally {
		pending.abort();
	}
});

test("abort 幂等；释放后不能再放行连接", () => {
	const pending = createPendingClient(opts);
	pending.abort();
	expect(() => pending.abort()).not.toThrow();
	let error: unknown;
	try {
		pending.resume();
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "ADDON_PROTOCOL_ALREADY_RELEASED" });
});

test("缺少显式协议版本时拒绝装配，不让 autoVersion 抢先发 status ping", () => {
	let error: unknown;
	try {
		createPendingClient({ ...opts, version: "" });
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "ADDON_PROTOCOL_VERSION_REQUIRED" });
});
