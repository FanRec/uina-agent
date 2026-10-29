/**
 * W4 Surface 能力：capabilities() 生效、hasUI() 派生、terminal optional、
 * 无头面 notify/setWorking 有回执不静默。
 */

import { describe, expect, it, vi } from "vitest";
import { createPrintUI } from "../src/extensions/runner.js";
import type { ExtensionUIContext } from "../src/extensions/ui-contract.js";
import { HEADLESS_CAPABILITIES, INTERACTIVE_TERMINAL_CAPABILITIES } from "../src/presentation/surface.js";
import { type UIHostContextPort } from "../src/ui/extension-ui-context.js";
import { UIHost } from "../src/ui/ui-host.js";
import { createSilentTerminal } from "./harness/index.js";

describe("print/stdio 面（无头）能力降级", () => {
	it("capabilities 全 false；hasUI 由其派生；terminal 不再伪造", () => {
		const ui = createPrintUI(() => {});
		expect(ui.capabilities()).toEqual(HEADLESS_CAPABILITIES);
		expect(ui.hasUI()).toBe(false);
		expect(ui.terminal).toBeUndefined();
	});

	it("notify 受理（写即表达）；setWorking 明确不受理，不静默成功", () => {
		const written: string[] = [];
		const ui = createPrintUI((message) => written.push(message));
		expect(ui.notify("hello", "info")).toEqual({ accepted: true });
		expect(written).toEqual(["hello"]);
		expect(ui.setWorking("k", "working")).toEqual({ accepted: false });
	});
});

describe("TUI 面能力", () => {
	it("capabilities 全开；hasUI 派生为 true；terminal 存在", () => {
		const { terminal } = createSilentTerminal(80, 24);
		const host = new UIHost({ terminal });
		const ui = host.ctxUI;
		expect(ui.capabilities()).toEqual(INTERACTIVE_TERMINAL_CAPABILITIES);
		expect(ui.hasUI()).toBe(true);
		expect(ui.terminal).toBeDefined();
		host.stop();
	});

	it("notify/setWorking 回执来自槽位注册表；setWorking 有读取端（帧内可见）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		try {
			const { terminal } = createSilentTerminal(80, 24);
			const host = new UIHost({ terminal });
			const notifyAck = host.notify("提示一", "info", 3000);
			expect(notifyAck.accepted).toBe(true);
			expect(host.getNotificationToast()).toEqual({ message: "提示一", type: "info" });

			// 同文去重（C2）
			expect(host.notify("提示一", "info", 3000)).toEqual({ accepted: false, reason: "shadowed" });

			// 队列：第二条不同文仍可见，getNotificationToast 返回最新
			host.notify("提示二", "warning", 3000);
			expect(host.getNotificationToast()).toEqual({ message: "提示二", type: "warning" });

			const workingAck = host.setWorking("probe", "后台任务进行中");
			expect(workingAck.accepted).toBe(true);
			expect(host.composition.snapshot("activity")).toHaveLength(1);
			host.setWorking("probe", undefined);
			expect(host.composition.snapshot("activity")).toHaveLength(0);
			host.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("fake surface：能力降级路径", () => {
	it("声明 interactive:false 的 fake surface 不暴露 terminal；扩展据 capabilities() 分支", () => {
		const fake: ExtensionUIContext = createPrintUI(() => {});
		// 扩展作者的正确分支写法：先看能力，再摸终端 facet
		const canUseTerminal = fake.capabilities().interactive && fake.terminal !== undefined;
		expect(canUseTerminal).toBe(false);
		// 越权访问 terminal 是 undefined（不是伪造的 no-op 面），扩展拿不到假能力
		expect(fake.terminal).toBeUndefined();
	});

	it("UIHostContextPort 实现方签名带回执：notify/setWorking 不再是 void", async () => {
		const { terminal } = createSilentTerminal(80, 24);
		const host = new UIHost({ terminal });
		const port: UIHostContextPort = host;
		const ack = port.notify("x", "info", 100);
		expect(ack.accepted).toBe(true);
		host.stop();
	});
});
