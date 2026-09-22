# 应用（App）开发指南

面向当前 Uina 实现。运行事实见 [current-runtime.md](current-runtime.md)，架构提案见 [agent-app-framework.md](proposals/agent-app-framework.md)。

---

## 1. 架构定位：App 与 Extension 的区别

Uina 明确划分了两种扩展能力形态：

| 维度 | 系统扩展 (Extension) | 大模型应用程序 (App) |
| :--- | :--- | :--- |
| **存放目录** | `.uina/extensions/` | `.uina/apps/` |
| **核心职责** | 系统级能力与底层钩子（如 Shell 执行、文件监听、模型过滤、自定义命令） | 面向大模型交互的有状态领域应用（如网易云点歌机、Live2D、OBS 导播、音效库） |
| **工具形态** | 平铺注册零散无状态 Tool | **单一门面工具（Facade Tool）**：一个 App 对模型只暴露一个工具名（如 `jukebox`） |
| **上下文机制** | 无专用视口（或仅通过原始 `transformContext` 注入） | **三档视口治理（hidden / ambient / expanded）**，精细控制 Token 消耗 |
| **代码依赖** | 直接接收 `ExtensionAPI` (`pi`) | **零 `pi` 纯净契约**：仅导出纯静态 `AppDef` 对象 |
| **管理方式** | 宿主启动全量激活 | 由系统内置应用商店 `app_store` 统一调度（可动态启用/停用） |

---

## 2. 目录规范与加载机制

### 2.1 扫描路径与忽略规则
Uina 启动时由内置的 `app-loader` 自动扫描以下目录：
1. **工作区目录**：`<cwd>/.uina/apps/`
2. **用户全局目录**：`~/.uina/apps/`

**目录扫描卫生防卫（自动忽略）**：
- **系统项**：以 `.` 开头的隐藏文件/目录（如 `.git`、`.cache`、`.DS_Store`）与 `node_modules` 依赖目录会自动跳过，绝不扫描。
- **辅助子目录**：只有包含入口文件（`index.ts/js/mts/mjs`）或有效 `package.json` 的目录才会被识别为应用包；纯资源或辅助代码目录（如 `assets/`、`fixtures/`）天然会被忽略，无需特殊标记。

### 2.2 两种组织形式
- **单文件应用**：适合轻量独立 App，如 `.uina/apps/weather.ts` 或 `weather.mjs`。
- **目录包应用**：适合含辅助模块、伴生服务或静态资产的复杂应用，如 `.uina/apps/netease-jukebox/`：
  ```text
  .uina/apps/my-app/
    ├── package.json    # 必须包含 "type": "module"
    ├── index.ts        # 默认入口
    ├── types.ts        # 私有类型
    └── service.ts      # 业务逻辑或伴生服务
  ```

### 2.3 `package.json` 规范
如果采用目录包形式，`package.json` **必须声明 `"type": "module"`**（否则 Node/TS 会按 CommonJS 解析导致语法报错），可声明入口：
```json
{
  "name": "my-app",
  "version": "1.0.0",
  "type": "module",
  "main": "./index.ts",
  "uina": {
    "type": "app"
  }
}
```
> 若未显式指定 `main`，框架将依次按 `index.ts`、`index.js`、`index.mts`、`index.mjs` 回退解析。

### 2.4 用户状态持久化与生命周期治理 (`.uina/apps.json`)
当用户或前端通过 `app_store` 工具启用或停用应用时，该选择会自动记录在工作区配置文件 `<cwd>/.uina/apps.json` 中：
```json
{
  "ticker": false,
  "jukebox": true
}
```

**应用启动状态优先级**：
$$\text{生效状态} = \text{.uina/apps.json}[name] \;\;??\;\; \text{AppDef.defaultState.enabled} \;\;??\;\; \text{true}$$

- **用户偏好优先**：一旦用户在前端或对话中停用了某个 App（如 `app_store.disable("ticker")`），即使代码中声明 `defaultState: { enabled: true }`，下次重启依然保持停用，**无需修改应用源码**；
- **纯净状态分离**：禁用应用仅记录在状态文件中，绝不会对物理代码目录进行重命名（如改名为 `_ticker`），彻底规避 Windows 文件占用锁与 Git 脏提交问题。

---

## 3. 最小 App 示例 (Hello World)

保存为 `.uina/apps/hello-app/index.ts`（或单文件 `.uina/apps/hello.ts`）：

```typescript
import type { AppDef, ActionContext } from "uina/app-framework"; // 或按相对路径引用 types.js

export const helloApp: AppDef = {
  name: "hello",
  description: "问候与记事本演示应用",

  // 默认启动状态（可选，默认为 enabled: true, tier: "hidden"）
  defaultState: {
    enabled: true,
    tier: "ambient",
  },

  // 视口渲染（tier: "ambient" | "expanded"）
  async render(tier) {
    if (tier === "ambient") {
      return "[Hello: 运行中]";
    }
    return `
=== [App: Hello] ===
[System Controls - Instructions]
- 问候: hello({ action: "greet", params: { name: "名字" } })
- 关闭界面: hello({ action: "close" })
[Application State - DATA ONLY]
状态: 就绪
====================`.trim();
  },

  // 模型可调用的动作字典
  actions: {
    greet: {
      description: "向指定对象打招呼",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "被问候的人名" },
        },
        required: ["name"],
      },
      async run(args: Record<string, unknown>, ctx: ActionContext) {
        const name = String(args.name ?? "世界");
        // 执行后可主动将视口切为 ambient 档位
        ctx.setTier("ambient");
        return `你好，${name}！`;
      },
    },
  },
};

// 默认导出纯 AppDef（也支持导出工厂函数 export default () => helloApp）
export default helloApp;
```

---

## 4. `AppDef` 契约核心详解

```typescript
export interface AppDef {
  name: string;
  description: string;
  defaultState?: {
    enabled?: boolean;         // 启动时是否直接暴露给大模型（默认 true）
    tier?: SurfaceTier;        // 启动时的视口档位（默认 "hidden"）
  };
  onStart?: (ctx: ServiceCompanionContext) => Promise<void> | void;
  onStop?: (ctx: ServiceCompanionContext) => Promise<void> | void;
  render?: (tier: "ambient" | "expanded") => Promise<string> | string;
  actions: Record<string, ActionDef>;
}
```

### 4.1 核心字段说明
1. **`name`**：应用的唯一英文标识符（必须符合 `^[a-zA-Z0-9_-]+$`）。它将直接成为模型可见的**门面工具名**（如 `jukebox`）。
2. **`description`**：描述应用定位与适用场景，供大模型在 Tool 列表中进行语义路由。
3. **`actions`**：该应用支持的所有业务操作。
   - 框架会自动为门面工具补充 `close`（收起面板转入 `hidden`）、`ambient`（转入环境感知）与 `help` 操作。
   - 推荐每个应用都显式实现一个 `status` 动作，供模型主动自省。
   - `run(params, ctx)` 中的 `ctx: ActionContext` 提供：
     - `ctx.setTier(tier)`：主动切换视口档位（如播放后收起或展开）；
     - `ctx.getTier()`：读取当前视口档位（`"hidden" | "ambient" | "expanded"`），供 `status` 汇报；
     - `ctx.operationIdentity`：当前操作的全局权威标识符（如 `app:soundboard/play`）；
     - `ctx.signal`：本次工具调用的取消信号（**必选**）。长动作必须把它透传给内部可取消原语（如通道申请、分段等待），否则工具层回报 `cancelled` 时物理动作仍在继续，构成对外谎报。
4. **`render(tier)`**：根据档位动态渲染注入到模型上下文中的视口内容（详见第 5 节）。
5. **`onStart` / `onStop`**：应用生命周期钩子，主要用于伴生服务的拉起与释放（详见第 6 节）。

### 4.2 应用与系统扩展之间的两条通道（架构铁律）

**纯数据走 `callService`，活引用走 `share`。**

`callService` 对入参与返回值双向 `structuredClone`，因此只能承载纯数据：函数会被丢弃，带闭包或原型方法的对象会直接抛 `DataCloneError`。需要把**行为**（一个带方法的对象）交给系统扩展时，必须走同进程共享：

| 方向 | 应用侧能力 | 说明 |
| :--- | :--- | :--- |
| 应用 → 扩展（写） | `ctx.expose(name, value)` | 把活引用登记进宿主的同进程共享表，系统扩展用 `pi.shared(name)` 拉取。**应用只拿到写方**，读不到他人的共享值——因此不会因为需要交付行为而凭空获得伸手进宿主内部的能力。 |
| 宿主 → 应用（读事件） | `ctx.onHostEvent(listener)` | 订阅宿主事实事件流的一个子集（`turn_start` / `output_update` / `turn_end` / `turn_aborted`），保留 `type` 与 `channel`。仅需"有人在动"这一粗粒度信号时才用较旧的 `onActivity`（它只剩 `origin`）。 |

两者都由框架按应用记账：应用被 `disable` 时框架强制回收其暴露项与订阅，**不依赖应用自觉退订**；应用自己提前退订同样安全（两条路径幂等）。

共享名由**契约拥有方**定义，宿主不解释其语义，也不做全局名称注册表。例如具身端点前缀 `body.endpoint:` 由 embodiment 扩展定义、声学电平接收端前缀 `voice.levelSink:` 由 voice 扩展定义，应用按前缀暴露、扩展按前缀发现。

> 反例（已被修复的真实缺陷）：Live2D 端点曾试图通过 `callService("embodiment:register_endpoint", endpoint)` 注册自己。`BodyEndpoint` 带原型方法与闭包，`structuredClone` 必然抛错，异常又被 `try/catch` 吞成一条 `console.warn`——于是端点从未进入路由表，而 `cue` 词汇注入、`cue` 派发与 `body` 工具全部静默失效。**用数据通道传行为，失败是必然的，而且往往不会被发现。**


---

## 5. Token 视口哲学与防注入规范

### 5.1 三档视口模型 (Context Surface Budget)
大模型的上下文（Context Window）是昂贵的物理资源，应用不能无节制地把全部状态常驻。

| 档位 | Token 预算 | 典型渲染内容 | 场景说明 |
| :--- | :--- | :--- | :--- |
| **`hidden`** | **0 token** | 不渲染任何文本。 | 软件在后台运行，或当前对话无需关注。 |
| **`ambient`** | **~10-20 tokens** | 仅输出单行结构化摘要：<br>`[Jukebox: 正在播放 "晴天" - 周杰伦 (01:23/04:29)]` | **极佳体验**：音乐在后台播放，用户聊哲学时突然问“现在放的是哪首歌？”，模型凭借环境感知能直接回答，无需开面板，且几乎不占 Token。 |
| **`expanded`** | **~100-200 tokens** | 包含完整的操作指南、当前状态与参数说明。 | 用户正在主动操作该应用（如搜索、切歌、配置）。 |

- 切换视口：在 action 的 `run(args, ctx)` 中，可通过 `ctx.setTier("ambient")` 或 `ctx.setTier("hidden")` 灵活调整。
- 自动保护：框架内置 LRU 挤出保护，当有新应用展开时，超出上限的应用会自动退回 `ambient`，防止多个应用撑爆 Context。

### 5.2 核心模式：瞬时动作 (Ephemeral) vs 持续状态 (Continuous) 的视口抉择

开发者必须根据自身应用的物理属性选择正确的视口策略，坚决避免无谓的信息冗余：

1. **瞬时事件型应用（如音效库 Soundboard、掷骰子、问候语）**：
   - 动作执行耗时极短（1~2 秒），执行完毕即告终结；
   - 动作执行的即时结果已完整记录在 `Tool Result` 中；
   - **黄金法则**：执行后视口**必须保持 `hidden`（0 Token）**，绝不挂载冗余的 `ambient` 投影。否则下一轮 Prompt 里既有历史消息中的 `Tool Result`，又有末尾视口里的“刚刚播放了...”，造成 100% 的信息重复与 Token 浪费；
   - 仅在用户或模型明确要求“查看面板/浏览列表”时，才按需展开为 `expanded`。

2. **持续状态型应用（如点歌机 Jukebox、后台下载器、长渲染任务）**：
   - 动作触发后，后台伴生服务持续运行数分钟乃至数小时；
   - 初始的 `Tool Result`（如“已开始播放《晴天》”）在多轮对话后会被滚动淹没或被 Context Compaction 压缩；
   - **黄金法则**：执行后应调用 `ctx.setTier("ambient")`，通过单行轻量感知（~10-20 Tokens）让大模型在任意时刻都能感知当前正在播放的曲目与实时进度。

### 5.3 架构分工：Tool 描述与视口面板的黄金边界（API 说明书 vs 动态液晶屏）

在大模型交互与 Token 经济学中，必须深刻理解两者的本质分工与缓存特性：

| 载体 | 核心定位 | 应该放什么？ | 严禁放什么？ | Prompt Caching 影响 |
| :--- | :--- | :--- | :--- | :--- |
| **Tool 描述<br>(Tool Schema)** | **API 说明书**<br>（唯一的动作合同） | - 所有的 actions 清单<br>- 具体的参数名、类型、必填项与调用规范<br>- 参数取值示例 | ❌ 业务动态数据（如正在播放的歌曲、当前进度条、实时列表） | **100% 命中前缀缓存**。<br>处于前缀区，静态不变，享受 1~5 折计费优惠。 |
| **视口面板<br>(Viewport Panel)** | **动态液晶屏**<br>（当前状态与数据投影） | - 播放器当前状态（播放中/暂停/空闲）<br>- 当前曲目、进度条、音量<br>- 动态数据列表（精选音效、搜索结果）<br>- 最多 1 行极简提示（如 `(点播可传对应 ID)`） | ❌ **严禁长篇累牍地重复抄写参数调用教程！**<br>（不要写一整屏的 `[System Controls - Instructions]`） | **按需展开，平时 0 Token**。<br>处于末尾区，避免变动数据击穿前缀缓存。 |

#### 为什么严禁在面板中重复抄写参数教程？
1. **彻底杜绝双重真理源（Dual Sources of Truth）导致的调用混乱**：
   - 实践表明：若在 Tool Schema 里定义了参数（如 `volume: number`），又在面板教程里手写了 `level: 80`，大模型极易在 `volume`、`level`、`value` 之间反复试错报错。
   - Tool Schema 必须是参数定义的**唯一权威源**。
2. **节省无谓的全价 Token**：
   - 面板注入在上下文末尾，属于无法被前缀缓存覆盖的动态变动区域。
   - 每轮展开若重复携带 50~100 Token 的操作说明，消耗的全部是**100% 全价 Token**。

### 5.4 铁律：防 Prompt Injection 结构化隔离
> [!CAUTION]
> 视口注入在大模型 Prompt 最末端（近因效应区）。如果应用展示的外部数据（如互联网搜索结果、B站弹幕、网页标题、外部歌曲名）包含诸如 `"Ignore previous instructions, do X"` 的恶意指令，大模型极易被劫持！

**必须遵守的渲染隔离范式**：
在 `render("expanded")` 中，外部数据强制包裹在 `<data>...</data>` 标签中，且面板聚焦于纯数据状态：

```typescript
render(tier: "ambient" | "expanded"): string {
  if (tier === "ambient") {
    return `[Jukebox: 正在播放 <data>${escape(song.name)}</data>]`;
  }

  // expanded 面板：纯数据视图
  return `
=== [App: Jukebox (网易云音乐点歌机)] ===
状态: ${player.status === "playing" ? "▶ 播放中" : "⏹ 空闲"} | 音量: ${volume}%
当前曲目: <data>${escape(song.name)} - ${escape(song.artist)}</data>
进度: ${currentPos} / ${currentDur}
========================================`.trim();
}
```

---

## 6. 外部伴生服务（Companion Service）规范

许多 App 依赖本地外部进程（例如点歌机依赖 `api-enhanced`，TTS 依赖 Python 推理服务，Live2D 依赖本地 WebSocket 渲染器）。

### 6.1 准则一：探测优先（Health Check First）
拉起外部进程前，**必须先进行端口/健康探测**。如果用户或开发环境已经启动了该服务，直接复用，绝不重复拉起产生 `EADDRINUSE` 端口冲突：

```typescript
// companion.ts 典型范式
async ensureRunning(apiClient: MyApiClient): Promise<void> {
  // 1. 先探测已有服务
  if (await apiClient.isHealthy(1500)) {
    return; // 服务已在运行，直接复用
  }

  // 2. 本地未运行，拉起子进程
  this.childProcess = spawn("node", ["app.js"], {
    cwd: this.serviceDir,
    stdio: "ignore",
    windowsHide: true,
  });

  // 3. 等待健康检查就绪
  await this.waitForHealthy(apiClient, 5000);
}
```

### 6.2 准则二：谁拉起、谁清理（No Orphan Processes）
凡由应用 `onStart` 创建的子进程，必须在应用 `onStop` 或宿主退出信号（`ctx.signal`）触发时被彻底终止，绝不残留孤儿进程：

```typescript
async onStop(): Promise<void> {
  if (this.childProcess) {
    this.childProcess.kill();
    this.childProcess = null;
  }
}
```

---

## 7. 大模型人机工效学（LLM Ergonomics）设计

为了避免大模型在调用动作时反复“猜参数”、“试错”：

### 7.1 宽容的参数别名支持
模型常常使用同义词传参（如 `query` 传成 `keyword` 或 `song`；`volume` 传成 `level` 或 `percent`）。Action 的 `run` 处理函数应当做别名容错：

```typescript
async run(args: Record<string, unknown>) {
  // 兼顾 query, keyword, song, name, q
  const query = String(args.query ?? args.keyword ?? args.song ?? args.name ?? args.q ?? "").trim();
  if (!query) {
    return "参数错误：缺少搜索关键词。请传入 { query: '歌名' }。";
  }
  // ...
}
```

### 7.2 显式的错误提示附带调用样例
当参数缺失或校验失败时，返回的错误提示应当直接包含正确格式的 JSON 示例：
```typescript
return "参数错误：音量必须是 0 到 100 之间的数字。例如 { level: 80 }。";
```

### 7.3 诚实反馈原则（Honest Feedback）与防御脑补幻觉
大模型具有极强的“因果倒推”倾向。如果工具的返回值给出了模糊或不严谨的反馈，极易诱发大模型产生逻辑脑补幻觉：

1. **禁止无条件返回盲目的“已执行/已成功”**：
   - **典型教训**：当一个 App 此前原本就处于 `hidden` 状态时，如果模型调用了 `close`，工具若无条件返回 `《xxx》界面已关闭。`，大模型会基于该文本推断 *“既然关闭成功了，那刚才肯定就是开着的！”*，进而信誓旦旦地向用户撒谎汇报 *“刚才面板是开着的，我帮你关掉了”*。
   - **最佳实践**：必须做到真实状态反馈：
     ```typescript
     // 框架内置 close 的诚实实现
     const wasHidden = runtime.surfaceTier === "hidden";
     options.setTier("hidden");
     return wasHidden
       ? `《${def.name}》界面此前已处于关闭状态 (hidden)，无需重复关闭。`
       : `《${def.name}》界面已关闭。`;
     ```

2. **自省动作（`status`）必须包含视口状态**：
   - 模型在不确定时常常会调用 `status` 自省，或者被用户询问“面板现在开着吗？”。
   - 应用自定义的 `status` 动作**绝不能只汇报底层硬件/业务状态**，必须通过 `ctx.getTier()` 明确包含视口档位：
     ```typescript
     status: {
       description: "查看应用状态与视口档位",
       async run(_args, ctx: ActionContext) {
         const tier = ctx.getTier();
         const tierText =
           tier === "hidden"
             ? "hidden (关闭/未展开，0 Token)"
             : tier === "ambient"
             ? "ambient (环境感知)"
             : "expanded (面板已展开)";
         return [
           `状态: 就绪`,
           `视口档位: ${tierText}`,
           // ... 其他业务指标
         ].join("\n");
       }
     }
     ```

### 7.4 门面工具直达（Direct Invocation）：意图明确时无需开面板
开发者经常会有一个疑问：“用户说‘播放钢管落地’时，大模型为什么直接调用了 `play` 而没有先去打开面板？”

- **机制揭秘**：门面工具（Facade Tool）生成时，会将 App 所有的 actions 说明（包含参数和示例）注入到模型的 Tool Schema 中。
- **人机工效收益**：
  - 打开面板（`expanded`）类似于**打开软件的主窗口**（适合用户想要选歌、浏览音效列表等探索性场景）；
  - 直接调用动作（`play`）类似于**键盘上的多媒体快捷键**。
- 当用户发出意图明确的指令且工具说明足够清晰时，大模型会直接一步到位触发动作，**免去一次“先开面板、再调动作”的多余大模型思考往返（减少 2~3 秒等待延迟）**。

---

## 8. 调试与测试方法

### 8.1 在 Uina 运行时中交互验证
1. 将应用放置在 `.uina/apps/<your-app>/`。
2. 启动 Uina：`pnpm start`。
3. 在对话中查看与调用：
   - 查看所有已安装应用：让初奈调用 `app_store({ action: "list" })`。
   - 启用/停用应用：`app_store({ action: "enable", params: { name: "my-app" } })`。
   - 直接调用应用动作：`my-app({ action: "greet", params: { name: "初奈" } })`。

### 8.2 编写 Vitest 单元测试
可以直接通过 `AppRegistry` 进行完整的单元测试，无需启动真实模型：

```typescript
import { describe, it, expect, vi } from "vitest";
import { AppRegistry } from "../src/extensions/app-framework/app-registry.js";
import myApp from "../.uina/apps/my-app/index.js";

describe("MyApp", () => {
  it("should register and execute action", async () => {
    const mockPi = {
      registerTool: vi.fn(() => () => {}),
      onHook: vi.fn(() => () => {}),
      signal: new AbortController().signal,
      reportError: vi.fn(),
    } as any;

    const registry = new AppRegistry(mockPi);
    await registry.register(myApp);

    expect(registry.has("my-app")).toBe(true);
    // 验证 Facade Tool 已被注册，并可直接执行 action
  });
});
```
