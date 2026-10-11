import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P4-6：发布验收门（§7）。
 * contentDigest 只覆盖运行时内容；acceptance.json sidecar 是发布唯一事实源；
 * 内容任何改动即回到草稿；authorOnly 工具（preview）在草稿下可达；gate 顺序连接先于发布。
 */

const MODEL_ID = "fixture-model";

const makeRig = (): ModelRig => ({
	version: 3,
	modelID: MODEL_ID,
	controls: {
		"head.yaw": { min: -12, max: 12, neutral: 0 },
		"torso.breath": { min: 0, max: 1, neutral: 0.5 },
		"mouth.open": { min: 0, max: 1, neutral: 0 },
	},
	bindings: {
		"head.yaw": [
			{
				parameter: "ParamAngleX",
				input: "FaceAngleX",
				points: [
					[-12, -30],
					[0, 0],
					[12, 30],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
		"torso.breath": [
			{
				parameter: "ParamBreath",
				input: "FaceAngY",
				points: [
					[0, 0],
					[0.5, 0.5],
					[1, 1],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
		"mouth.open": [
			{
				parameter: "ParamMouthOpenY",
				input: "MouthOpen",
				points: [
					[0, 0],
					[1, 1],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
	},
	external: { blink: "uina", breath: "vts" },
});

const makeCatalog = (value: number) =>
	compileCatalog(
		MODEL_ID,
		{
			motions: {
				long: {
					description: "长动作",
					motion: motion(
						500,
						track("head.yaw", [
							[0, value],
							[500, value],
						]),
					),
				},
			},
		},
		makeRig(),
	);

const dirs: string[] = [];
const tmpDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "uina-acceptance-"));
	dirs.push(dir);
	return dir;
};
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const makeClient = (state: { connected: boolean }): VTSClient =>
	({
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: MODEL_ID }),
		injectParameters: () => {},
		setConnectionChangeListener: () => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
		getFault: () => undefined,
	}) as unknown as VTSClient;

const startApp = async (rt: Live2DRuntime, worldDataDir?: string) => {
	const app = createLive2DApp({ instance: rt });
	await app.onStart!({ expose: () => () => {}, worldDataDir } as unknown as ServiceCompanionContext);
	return app;
};

describe("发布验收门（P4-6，§7）", () => {
	it("无 sidecar → 启动即草稿：catalogView 空目录、express 拒绝 draft、preview（作者会话）仍可达", async () => {
		const state = { connected: true };
		const worldDataDir = await tmpDir();
		const rt = new Live2DRuntime({
			client: makeClient(state),
			rig: makeRig(),
			catalog: makeCatalog(6),
			packageDir: await tmpDir(),
		});
		const app = await startApp(rt, worldDataDir);
		try {
			await writeFile(join(worldDataDir, "author-session"), "", "utf8");
			expect(rt.catalogView.motions.size).toBe(0);
			const express = await rt.express({ motion: "long" }, {});
			expect(express.details).toMatchObject({ reason: "draft" });
			const preview = await rt.preview({}, {});
			expect(preview.status).toBe("not_started"); // 作者预览在草稿下可达（不再被 draft 拒绝）
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("accept：无作者会话 → author_session_required；有会话 + evidence → 写入 sidecar 并发布", async () => {
		const state = { connected: true };
		const packageDir = await tmpDir();
		const worldDataDir = await tmpDir();
		const rt = new Live2DRuntime({ client: makeClient(state), rig: makeRig(), catalog: makeCatalog(6), packageDir });
		const app = await startApp(rt, worldDataDir);
		try {
			const denied = await rt.accept({ evidence: "画面自然" }, {});
			expect(denied.details).toMatchObject({ reason: "author_session_required" });

			await writeFile(join(worldDataDir, "author-session"), "", "utf8");
			const missing = await rt.accept({}, {});
			expect(missing.details).toMatchObject({ reason: "invalid_preview" });

			const ok = await rt.accept({ evidence: "画面自然" }, {});
			expect(ok.status).toBe("succeeded");
			expect(ok.details).toMatchObject({ effectStatus: "applied" });

			const sidecar = JSON.parse(await readFile(join(packageDir, "acceptance.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(typeof sidecar.contentDigest).toBe("string");
			expect(sidecar.evidence).toBe("画面自然");
			expect(rt.catalogView.motions.size).toBe(1); // 发布后目录可见

			// sidecar 存续 + 相同内容 → 重启后仍发布（digest 一致驱动）。
			const rt2 = new Live2DRuntime({ client: makeClient(state), rig: makeRig(), catalog: makeCatalog(6), packageDir });
			const app2 = await startApp(rt2);
			try {
				expect(rt2.catalogView.motions.size).toBe(1);
			} finally {
				await app2.onStop?.({} as ServiceCompanionContext);
			}
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("内容任何改动即回到草稿：setCatalog 换内容 → draft；换回原内容 → 发布恢复", async () => {
		const state = { connected: true };
		const packageDir = await tmpDir();
		const worldDataDir = await tmpDir();
		const rt = new Live2DRuntime({ client: makeClient(state), rig: makeRig(), catalog: makeCatalog(6), packageDir });
		const app = await startApp(rt, worldDataDir);
		try {
			await writeFile(join(worldDataDir, "author-session"), "", "utf8");
			expect((await rt.accept({ evidence: "验收" }, {})).status).toBe("succeeded");
			expect(rt.catalogView.motions.size).toBe(1);

			rt.setCatalog(makeCatalog(8)); // 内容变更
			expect(rt.catalogView.motions.size).toBe(0); // 回到草稿
			const express = await rt.express({ motion: "long" }, {});
			expect(express.details).toMatchObject({ reason: "draft" });

			rt.setCatalog(makeCatalog(6)); // 摘要与 sidecar 一致 → 发布恢复
			expect(rt.catalogView.motions.size).toBe(1);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}
	});

	it("sidecar 损坏 → 诚实草稿；gate 顺序：未验收 + 断线 → model_not_ready（连接先于发布）", async () => {
		const packageDir = await tmpDir();
		await writeFile(join(packageDir, "acceptance.json"), "{ broken", "utf8");
		const state = { connected: true };
		const rt = new Live2DRuntime({ client: makeClient(state), rig: makeRig(), catalog: makeCatalog(6), packageDir });
		const app = await startApp(rt);
		try {
			expect(rt.catalogView.motions.size).toBe(0);
		} finally {
			await app.onStop?.({} as ServiceCompanionContext);
		}

		const offline = { connected: false };
		const rt2 = new Live2DRuntime({
			client: makeClient(offline),
			rig: makeRig(),
			catalog: makeCatalog(6),
			packageDir: await tmpDir(),
		});
		const app2 = await startApp(rt2);
		try {
			const express = await rt2.express({ motion: "long" }, {});
			expect(express.details).toMatchObject({ reason: "model_not_ready" }); // 不是 draft
		} finally {
			await app2.onStop?.({} as ServiceCompanionContext);
		}
	});
});
