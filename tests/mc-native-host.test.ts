/** T01/T02 单元级：World 长驻常驻层无会话即可 describe/library，游戏动作 NOT_CONNECTED，连接失败如实报告。 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createMinecraftWorld } from "../.uina/worlds/minecraft/worlddef/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { IsolatedEnv, Scenario, UinaTestHarness } from "./harness/index.js";

function act(world: ReturnType<typeof createMinecraftWorld>, action: string) {
	return async (params: Record<string, unknown>) =>
		await world.actions[action]!.run(params, {
			operationIdentity: `world:minecraft/${action}`,
			signal: new AbortController().signal,
		});
}

async function activate(world: ReturnType<typeof createMinecraftWorld>, pi: ExtensionAPI): Promise<WorldActivation> {
	const activation = new WorldActivation(world, {
		pi,
		runtime: { definition: world, enabled: true },
		worldName: world.name,
		notifyExposed() {},
	});
	await activation.start();
	return activation;
}

test("resident Minecraft world serves describe/library without a session; game actions refuse; connect failure stays honest", async () => {
	const env = await IsolatedEnv.create();
	const configPath = env.resolve("mc-config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			connection: { host: "127.0.0.1", port: 1, username: "HostReceiptTest", authMode: "offline", version: "1.21.11" },
			binding: null,
		}),
	);
	const h = await UinaTestHarness.create({
		env,
		scenario: new Scenario().reply("done"),
	});
	let pi!: ExtensionAPI;
	let activation: WorldActivation | undefined;
	try {
		await h.host["extensionHost"].activateBuiltin("mc-host-test", (api) => {
			pi = api;
		});
		const world = createMinecraftWorld({
			legacyConfigPath: configPath,
			executorPolicy: { autoRecover: false, closeGraceMs: 3000 },
			deliveryPolicy: { pollMs: 20 },
		});
		activation = await activate(world, pi);
		// World enabled 且未 connect：没有任何 Body 端点、没有 Bot/伴生进程。
		expect(activation.exposed.size).toBe(0);
		const session = act(world, "session");
		const status = await session({ op: "status" });
		expect(status).toMatchObject({ status: "succeeded" });
		const parsed = JSON.parse(status.result as string) as { state: string; active: unknown; settingsPath: string };
		expect(parsed.state).toBe("disconnected");
		expect(parsed.active).toBeNull();
		// 旧 config.json → settings 种子（defaultUsername + 具名服务器）；用户手编文件不被覆盖。
		expect(existsSync(parsed.settingsPath)).toBe(true);
		expect(JSON.parse(await readFile(parsed.settingsPath, "utf8"))).toMatchObject({
			defaultUsername: "HostReceiptTest",
			servers: { default: { host: "127.0.0.1", port: 1 } },
		});
		// 离线 describe 与 library：无执行域即可发现与读写。
		const described = await act(world, "describe")({ query: "chat" });
		expect(described.status).toBe("succeeded");
		expect(JSON.stringify(described.details)).toContain("chat@1");
		const saved = await act(
			world,
			"library",
		)({
			op: "save",
			name: "echo",
			summary: "reuse echo",
			source: "async function main(mc,input){return input;}",
		});
		expect(saved.status).toBe("succeeded");
		const listed = await act(world, "library")({ op: "list" });
		expect((listed.details as { name: string }[]).some((item) => item.name === "echo")).toBe(true);
		// 无会话的游戏动作 NOT_CONNECTED（not_started：什么都没开始）。
		const chat = await act(world, "chat")({ text: "no session" });
		expect(chat).toMatchObject({ status: "not_started" });
		expect(chat.details).toMatchObject({ code: "NOT_CONNECTED" });
		// 连接失败：候选域退役、所有权释放、状态与 lastError 如实；不产生 Body 端点。
		const failed = await session({
			op: "connect",
			target: { host: "127.0.0.1", port: 1, username: "HostReceiptTest" },
		});
		expect(failed).toMatchObject({ status: "failed" });
		expect(failed.details).toMatchObject({ code: "CONNECT_FAILED" });
		const afterFail = JSON.parse((await session({ op: "status" })).result as string);
		expect(afterFail.state).toBe("disconnected");
		expect(afterFail.lastError).toMatchObject({ code: "CONNECT_FAILED" });
		expect(afterFail.active).toBeNull();
		expect(activation.exposed.size).toBe(0);
		const profiles = JSON.parse((await session({ op: "list" })).result as string);
		expect(profiles).toHaveLength(1);
		expect(profiles[0]).toMatchObject({
			identity: { endpoint: { host: "127.0.0.1", port: 1 }, principal: { username: "HostReceiptTest" } },
			lastSeen: null,
		});
		// 并发第二个 connect 被管理槽拒绝（SESSION_BUSY），不排队持有陈旧目标。
		const first = session({ op: "connect", target: { host: "127.0.0.1", port: 1, username: "HostReceiptTest" } });
		const second = session({ op: "connect", target: { host: "127.0.0.1", port: 1, username: "HostReceiptTest" } });
		const replies = await Promise.all([first, second]);
		const codes = replies.map((r) => (r.details as { code?: string }).code);
		expect(codes.filter((code) => code === "SESSION_BUSY")).toHaveLength(1);
		await activation.stop();
		activation = undefined;
		// 重启后 library 资产仍在（共享根），状态层依旧可用。
		await h.dispose();
		const reopened = await UinaTestHarness.create({ env, scenario: new Scenario().reply("done") });
		let reopenedActivation: WorldActivation | undefined;
		try {
			let nextPi!: ExtensionAPI;
			await reopened.host["extensionHost"].activateBuiltin("mc-host-test", (api) => {
				nextPi = api;
			});
			const next = createMinecraftWorld({ legacyConfigPath: configPath });
			reopenedActivation = await activate(next, nextPi);
			const listed2 = await act(next, "library")({ op: "list" });
			expect((listed2.details as { name: string }[]).some((item) => item.name === "echo")).toBe(true);
			expect(JSON.parse((await act(next, "session")({ op: "status" })).result as string)).toMatchObject({
				state: "disconnected",
			});
		} finally {
			await reopenedActivation?.stop();
			await reopened.dispose();
		}
	} finally {
		await activation?.stop();
		await h.dispose();
		await env.dispose();
	}
}, 60000);
