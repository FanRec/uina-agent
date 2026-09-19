import { test, expect, defineExtensionConformanceTests } from "./index.js";
import activateWorkspaceTools from "../../src/extensions/workspace-tools/index.js";

// 1. 验证扩展契约合规套件
defineExtensionConformanceTests("workspace-tools", activateWorkspaceTools);

// 2. 验证剧本仿真与核心交互
test("Uina Test Kit: 声明式剧本多轮交互与 DAG 守卫", async ({ uina, scenario }) => {
	// 链式声明两轮对话
	scenario
		.reply("你好！我是 Uina 数字主体。")
		.reply("这是第二轮回显。");

	// 第 1 轮
	await uina.send("你好");
	await uina.waitForIdle();

	expect(uina).toHaveTurnCompleted(1);
	expect(uina.history).toHaveLength(2); // user + assistant
	expect(uina).toConformToDAG(); // 验证 DAG 因果无环

	// 第 2 轮
	await uina.send("第二句话");
	await uina.waitForIdle();

	expect(uina).toHaveTurnCompleted(2);
	expect(uina.history).toHaveLength(4);
	expect(uina).toConformToDAG();
	expect(uina).toHaveNoLeakedResources();
});

// 3. 验证崩溃重启与历史持久化恢复
test("Uina Test Kit: 会话崩溃恢复 (restart)", async ({ uina, scenario }) => {
	scenario.reply("持久化事实记录");

	await uina.send("开始任务");
	await uina.waitForIdle();

	expect(uina.history).toHaveLength(2);

	// 模拟进程崩溃并基于同一 session.jsonl 重新唤醒
	const restored = await uina.restart();
	try {
		expect(restored.history).toHaveLength(2);
		expect(restored).toConformToDAG();
		expect(restored).toHaveNoLeakedResources();
	} finally {
		await restored.dispose();
	}
});

// 4. 验证确定性虚拟时钟
test("Uina Test Kit: 确定性虚拟时钟 (VirtualClock)", async ({ clock }) => {
	clock.start(1_000_000);
	expect(clock.now()).toBe(1_000_000);

	let triggered = false;
	setTimeout(() => {
		triggered = true;
	}, 5000);

	expect(triggered).toBe(false);

	// 瞬间快进 5000ms，无需真实物理等待
	clock.advanceTime(5000);
	expect(triggered).toBe(true);
});
