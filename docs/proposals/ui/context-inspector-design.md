# 上下文检视器（自定义信息展示）设计方案

状态：已实现较窄版本，未完整实现原方案。当前有 `context_prepare`、提示词快照/转录卡片和 `/prompt` 面板；没有原提案中的四段独立 context-inspector overlay，也没有全量 custom_entry 清单浏览器。实际实现与 2026-10-14 定向测试见[提示词卡片实施计划](../../superpowers/plans/2026-10-04-inline-prompt-injection-cards.md)；真实 TTY/IME 未验证。
日期：2026-10-02
范围：展示层 + extensions 聚合层 + 内核最小事件增量；不改任何聚合/注入语义

## 1. 问题

"谁在影响模型上下文"当前完全不可见：系统提示词怎么构成、哪些扩展在回合边界注入了消息、哪些扩展在每请求改写投影——TUI 里一个字都看不到。排障只能靠读扩展源码。

## 2. 现状盘点（代码事实）

| # | 信息 | 产生点 | 持久性 | 模型可见 | 当前 UI 可见性 |
|---|---|---|---|---|---|
| 1 | 系统提示词（基座） | `host.ts:237` resolvedSystemPrompt → Subject 构造 | 内存 | 是 | **不可见** |
| 2 | 系统提示词（每回合改写） | `turn.prepare` 链，后写覆盖先写（`extensions/host.ts:328-383` 聚合） | 内存 | 是 | **不可见，per-extension provenance 聚合时丢弃** |
| 3 | 回合注入消息 | `turn.prepare` 贡献 `messages`，聚合追加进下一请求投影 | 内存（仅投影，**不落盘**） | 是 | **不可见，provenance 同上丢弃** |
| 4 | 每请求投影改写 | `turn.transformContext` 链（如 world-framework 的 `[World environment]` 段） | 内存 | 是 | **不可见** |
| 5 | custom_message | `Subject.appendCustomMessage`（`loop.ts:1386`）→ journal custom_message record | 落盘（Canonical） | 是 | transcript 显示（`display:false` 跳过）；branch-inspector 可见 |
| 6 | custom_entry | `pi.appendEntry` → journal custom_entry record | 落盘（Auxiliary） | 否 | 除压缩装饰外不可见 |

关键事实：#2/#3 的 provenance 在 `ExtensionRunner.runTurnPrepare` 的聚合循环里**天然存在**（每个 handler 的返回值已知来自哪个扩展），只是被聚合成最终结果后丢弃——补的是登记，不是新机制。

## 3. 设计原则

1. **展示 = 只读投影**。不改 turn.prepare/transformContext 的合并规则、不改注入语义、不给扩展新增写入 API。
2. **采集点在聚合层**（`src/extensions/host.ts`），内核五目录零采集逻辑。
3. **事实走 Subject 单流**（1:1 透传纪律不破：Host 只缓存转发事实，不造事实）；大文本详情走只读拉取。
4. **UI 无状态 View 规范**：branch-inspector 同款——按需拉取、只管理视图光标。
5. **内核增量最小**：一个新事件类型 + 三处既有 prepare 点各一次 dispatch。概念归属"Events/Model invocation"（允许清单内），不改协议语义。
6. **注入信息不落盘**。回合注入是每次重新计算的派生物，不是对话事实；落盘会与数据模型裁定冲突（有意模型可见→custom_message，由扩展显式走 durable 路径）。

## 4. 方案

### P1 provenance 登记（extensions/host.ts）

- 新类型 `InjectionProvenance`：
  ```ts
  interface InjectionProvenance {
    readonly extension: string;        // 贡献来源扩展名
    readonly hook: "turn.prepare" | "turn.transformContext";
    readonly kind: "messages" | "systemPrompt" | "model" | "thinkingLevel" | "projection";
    readonly messageCount?: number;    // kind=messages
    readonly bytes: number;            // 贡献体积（粗粒度）
    readonly preview: string;          // 首行截断预览（~80 字符）
  }
  ```
- `runTurnPrepare` 循环内逐 handler 登记；`runTransformContext` 链式各步登记（记录 messages 数增减、prompt 是否变更、bytes delta）。
- Runner 持有环形缓冲（容量 16）：`lastPrepareProvenance` / `lastTransformProvenance`（只读暴露）。
- transformContext **不发事件**：每模型请求执行一次，工具密集回合会事件刷屏——只留拉取口。

### P2 事实事件（内核最小增量）

- 新事件 `ContextPrepareEvent`（`runtime/events.ts`）：
  ```ts
  interface ContextPrepareEvent {
    readonly type: "context_prepare";
    readonly turnNumber: number;
    readonly systemPrompt: string;              // 本回合最终生效全文（进程内事件，KB 级无传输成本）
    readonly injections: readonly InjectionProvenance[];
  }
  ```
- `loop.ts` 三个回合边界 prepare 点（约 :411/:724/:933）在算出 `prepared.systemPrompt ?? this.systemPrompt` 后各 dispatch 一次。
- 事件携带全文而非 hash：详情拉取反而要新增 Subject 读 accessor（同等内核增量且丢时序）；事件保序于 turn_start，时间线自洽。

### P3 Host 门面（遵守 B3.3 收敛裁定，UI 不摸 host 内部）

- Host 缓存最近一次 `context_prepare`（纯展示态缓存）。
- `UIHost` 新增只读门面 `getContextIntel()`，聚合三个数据源：
  1. 缓存的 context_prepare（系统提示词全文 + 本回合注入）
  2. Runner 的 lastTransformProvenance（每请求改写，拉取时实时读）
  3. SessionAccess（custom_message / custom_entry 清单，branch-inspector 同源）

### P4 UI：上下文检视器 overlay

新文件 `src/ui/features/overlays/context-inspector.ts`，branch-inspector 同款模式。四段滚动视图：

```
┌ 上下文检视器 ──────────────────────────────┐
│ ▍系统提示词  4,218 字符 · 3 个贡献者        │
│   base(defaultSystemPrompt)                │
│   + event-frame（EVENT_FRAME_PROMPT 追加）  │
│   + world-framework（环境段追加）           │
│   [全文滚动区]                              │
│ ▍本回合注入（turn.prepare）2 条             │
│   world-framework · 2 messages · 1.2KB     │
│     preview: [World environment] ...       │
│ ▍每请求改写（transformContext）最近一次     │
│   world-framework · messages +2            │
│ ▍持久自定义信息                             │
│   custom_message ×5（1 条 display:false）   │
│   custom_entry ×12（compaction/summary…）  │
└────────────────────────────────────────────┘
```

- 入口键位：实施时查现有键位冲突后定（候选 ctrl+g / ctrl+y），help-menu 同步登记。
- 空态：无扩展激活时显示基座提示词，注入/改写段显式标"无"（不隐藏段落——"零注入"本身是要看到的事实）。

### P5（可选后置，默认不做）

回合注入非空时 transcript 顶一条细横幅（`┈ world-framework 注入 2 条 · ctrl+g 查看`）。第一版不做：刷屏风险，且 overlay 已覆盖需求。

## 5. 明确不做

- 不改 turn.prepare/transformContext 合并语义、不改任何扩展行为
- 注入信息不落盘（§3.6）
- 不展示 provider.transformPayload 级 wire 内容（传输层观测另立主题）
- 不给 Core 增加压缩词汇/读 accessor（事件方案下无此需要）

## 6. 验收

1. 零扩展激活：overlay 显示基座 systemPrompt，注入/改写段 = "无"
2. world-framework 激活：环境注入条目与 systemPrompt 追加段可见，provenance 扩展名正确
3. 回溯/压缩后 overlay 数据随之刷新（context_prepare 每回合重发）
4. 减法测试不破；typecheck + boundaries + vitest + CRAP 全绿

## 7. 待用户裁定

1. 键位选择（ctrl+g / ctrl+y / 其他）——已裁定：alt+g（与 tasks/subagents/trajectory/history 的 alt+X 家族一致）
2. 系统提示词展示粒度：全文滚动（推荐）vs 摘要+展开——已裁定：全文硬折行滚动
3. P5 内联横幅是否需要（推荐缓做）——缓做

## 8. 实施偏差记录（对抗式审查修订，2026-10-02）

实施与本文正文冲突时以本节为准：

1. **无环形缓冲**：prepare 侧 provenance 随 `runTurnPrepare` 结果/事件单一事实源返回，不落地字段；
   transform 侧为"最近一次运行"数组（上限 64，链长受扩展数约束）。"环形缓冲 16"未实施。
2. **无 `UIHost.getContextIntel()` 聚合门面**：数据组装落在 features.ts 装配点
   （UIHost 缓存的 context_prepare + ContextIntelPort + SessionAccess），UIHost 只承担
   事件缓存（`setContextPrepare`/`getContextPrepare`）——组合归组合根，缓存归缓存者。
3. **Host 不缓存事件**：§P3 的"Host 缓存"改为 UIHost 缓存（事件直达消费者，Host 不持有展示态）。
4. **`InjectionProvenance` 无 `hook` 字段**：来源通道由读取位置决定，记录不重复携带；
   `bytes` 命名改为 `chars`（UTF-16 code unit，诚实命名）。
5. **`ExtensionHost.injectionLedger()` 收窄为 `lastTransformInjections()`**：prepare 视图
   零消费，删——单一事实源，不留双通道。
6. **tools 变更可见**：transformContext 步骤的 tools 数变化进入 preview（原文盲区）。
7. **auxiliary 计数按真实 kind 分组**（`custom_entry X ×N` / `event Y ×N`），
   不把 event 记录混标为 custom_entry。
8. **`context_prepare` 的 emit 必须 await**：与 agent_start 的 emit 保持单流时序承诺。
