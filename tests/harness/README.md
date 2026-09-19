# Uina Test Kit 速查手册 (Cheat Sheet)

Uina 测试夹具与门面指南。用于指导编写新测试，杜绝重复样板代码与全局环境污染。

---

## 一、常用测试模式与模板

### 1. UI 与交互式终端测试 (UI / Interactive TUI)
> **原则**：严禁使用 `Object.defineProperty(process, "stdout", ...)` 劫持全局环境！统一使用 `createTestTUI`。

```typescript
import { createTestTUI } from "./harness/index.js";

it("测试终端交互与输入", () => {
	const harness = createTestTUI({ columns: 80, rows: 24, modelName: "test-model" });
	try {
		// 模拟输入纯文本与按键
		harness.type("hello").press("enter");
		expect(harness.inputText).toBe("");

		// 模拟快捷键（支持 "pageup", "pagedown", "tab", "esc", "ctrl+c" 等）
		harness.press("pageup");

		// 模拟终端鼠标或原始转义序列
		harness.feedInput("\x1b[<64;20;10M");

		// 获取屏幕当前可见文字（消除 ANSI 颜色与历史重绘残影）
		expect(harness.visibleText).toContain("hello");
	} finally {
		harness.dispose();
	}
});
```

### 2. 工具定义与注册 (Tool Mocking)
> **原则**：避免手动展开 8~14 行 `ToolDef` 与 JSON Schema，统一使用 `mockTool`。

```typescript
import { mockTool } from "./harness/index.js";

// 1. 极简成功工具
const pingTool = mockTool("ping", async () => "pong");

// 2. 带参数结构与自定义状态的工具
const calcTool = mockTool(
	"calc",
	async (args) => ({ result: String(Number(args.a) + Number(args.b)), status: "succeeded" }),
	{
		description: "加法计算器",
		parameters: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
);
```

### 3. 扩展与运行时钩子测试 (Extensions & Hooks)
> **原则**：使用 `createExtensionHarness` 集成 Host 与 ToolBroker，自动收集异常。

```typescript
import { createExtensionHarness, SubjectHarness } from "./harness/index.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";

it("测试扩展钩子拦截", async () => {
	const ext = createExtensionHarness();

	// 1. 注册拦截钩子
	ext.onHook("tools.beforeCall", (input) => {
		if (input.name === "danger") return { block: true, reason: "安全拦截" };
	});

	// 2. 快速注册测试工具
	ext.registerTool("danger", async () => "executed");

	// 3. 注入 Subject 运行
	const harness = SubjectHarness.create({
		broker: ext.tools,
		runtimeHooks: createRuntimeHooks(ext.host),
	});

	await harness.run("运行 danger");
	expect(ext.errors).toHaveLength(0); // 自动捕获扩展内部未捕获异常
});
```

### 4. 会话与历史回溯测试 (Session & Rewind)
> **原则**：统一使用 `seedSession` 和 `rewindTo` 构造历史和分支，避免手写循环。

```typescript
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { seedSession, rewindTo } from "./harness/index.js";
import { listSessionNodes } from "../src/session/navigation.js";

it("测试会话回溯与分支可见性", async () => {
	const store = new MemorySessionStore();

	// 快速注入初始多轮对话（交替生成 user / assistant 角色）
	const records = await seedSession(store, ["原始任务", "糟糕的计划", "停止写文件"]);

	// 快速创建回溯记录（回退到首条消息）
	const rewindId = await rewindTo(store, records[0].id, {
		fromId: records[2].id,
		reason: "推导前提错误",
	});

	const main = listSessionNodes(store.state);
	expect(main.nodes.map((n) => n.id)).toEqual([records[0].id, rewindId]);
});
```

### 5. 隔离文件系统与临时环境 (Isolated Environment)
> **原则**：禁止在真实目录或临时目录裸写文件！统一使用 `IsolatedEnv`。

```typescript
import { IsolatedEnv } from "./harness/index.js";

it("测试文件读写", async () => {
	const env = await IsolatedEnv.create({ prefix: "test-env-" });
	try {
		await env.writeFile("hello.txt", "world");
		expect(await env.readFile("hello.txt")).toBe("world");
	} finally {
		await env.cleanup(); // 自动清理临时目录，杜绝残留
	}
});
```

---

## 二、防劣化军规（写测试时务必遵守）

1. **绝对禁止 Monkey-Patch 全局环境**：
   - 严禁 `Object.defineProperty(process, "stdout", ...)` 或 `process.stdin`；
   - 严禁修改全局 `console.log` / `process.cwd` 且不保证在 `finally` 中恢复。
2. **严禁在 `tests/harness/` 制造跨层破窗**：
   - `tests/harness/core/` 只能依赖 Core 概念，禁止反向 import `src/extensions/` 或 `src/ui/`；
   - 任何涉及多模块装配的高级特性（如 compaction / jobs），必须在宿主或具体测试文件中显式装配。
3. **不要把断言细节过度包装进框架**：
   - 业务断言（排版宽度、字号截断、高亮染色、具体错误信息）必须在测试用例中显式保留；
   - 框架只负责**消除环境搭建、资源释放和状态机装配的胶水代码**。
