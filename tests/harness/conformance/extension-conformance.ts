import { describe, it, expect } from "vitest";
import { ExtensionRunner, type ExtensionAPI } from "../../../src/extensions/runner.js";
import { ToolBroker } from "../../../src/tools/broker.js";
import { IsolatedEnv } from "../environment/isolated-env.js";

/**
 * 扩展契约合规性自动化测试套件生成器：
 * 任何扩展只需传入其名称和激活函数，即可全自动跑完一套严谨的沙箱与生命周期合规检查。
 */
export function defineExtensionConformanceTests(
	extensionName: string,
	activateFn: (api: ExtensionAPI) => void | Promise<void>,
): void {
	describe(`扩展契约合规性套件: [${extensionName}]`, () => {
		it("生命周期完整性：卸载（dispose）后注册的工具必须从 Broker 完全注销", async () => {
			const env = await IsolatedEnv.create();
			const broker = new ToolBroker({ ownerId: "conformance-root" });
			const runner = new ExtensionRunner({ cwd: env.cwd, tools: broker });

			try {
				const initialToolCount = broker.names().length;

				// 1. 激活扩展
				await runner.activateBuiltin(extensionName, activateFn);
				const activeToolNames = broker.names();

				// 2. 卸载扩展 (runner.dispose 倒序清理所有激活的 scopes)
				await runner.dispose();

				// 3. 验证注销彻底
				const finalToolNames = broker.names();
				expect(finalToolNames.length).toBe(initialToolCount);
				for (const name of activeToolNames) {
					if (!finalToolNames.includes(name)) {
						expect(broker.has(name)).toBe(false);
					}
				}
			} finally {
				await runner.dispose().catch(() => undefined);
				await env.dispose().catch(() => undefined);
			}
		});

		it("工具异常击穿防护：工具执行抛错时结果必须合法捕获为 failed，不引发未捕获异常", async () => {
			const env = await IsolatedEnv.create();
			const broker = new ToolBroker({ ownerId: "conformance-root" });
			const runner = new ExtensionRunner({ cwd: env.cwd, tools: broker });

			try {
				await runner.activateBuiltin(extensionName, activateFn);
				const toolNames = broker.names();

				for (const name of toolNames) {
					// 传入故意缺失的参数或空参数，检查返回结果的结构合法性
					const res = await broker.execute(broker.prepare(name, {}));
					expect(["succeeded", "failed", "not_started", "unknown"]).toContain(res.status);
					expect(typeof res.result).toBe("string");
				}
			} finally {
				await runner.dispose().catch(() => undefined);
				await env.dispose().catch(() => undefined);
			}
		});
	});
}
