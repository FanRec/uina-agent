# Context Injection 重构实施记录

实施基线：`docs/refactor/Uina-LLM-Context-Injection-Refactor-Design.md` v1.0（2026-11-13 完成）。业务扩展（Voice/TTS/Minecraft/Live2D/MCP）未迁移，旧 Hook 全部保留——下一轮迁移入口已就绪。

## 落点与职责

| 能力 | 落点 | 说明 |
|---|---|---|
| Context Source 合同 | `src/core/types.ts` | `ContextSource/ContextRead/ContextValue/ContextContribution/ContextCollection/ContextSourceTraceEntry/RequestAssemblyTrace` |
| 只读端口 | `src/runtime/hooks.ts` | `RuntimeHooks.context.collect`（非 Hook 链，无 onHook 入口；noop/guard 同步更新） |
| Registry | `src/extensions/context-registry.ts` | 主键 `owner::id`；collect 入口固定注册快照；读取后二次核活性；失败/空/注销记入 omitted |
| 注册 API | `src/extensions/{host,runner}.ts` | `pi.provideContext(source)`；owner 强制取激活 scope id；`ResourceScope` 自动注销 |
| Request Composer | `src/agent/composer.ts` | 纯函数装配；无贡献时返回输入投影（同一引用） |
| 装配时序 | `src/agent/loop.ts` | `prepareProjection` 收敛点：旧 `transformContext` 之后插入 collect+compose；preview 与活动请求走同一套纯读装配 |
| Tool 模型视图 | `core/types.ts` + `agent/{context,loop}.ts` | `ToolAgentMessage.modelView`；`convertToLlm` 按 `modelView ?? canonical` 字段级回退；未改写不写冗余视图 |
| Wire 观察 | `src/ai/{gateway,providers}.ts` | `sendModelStreamRequest` 在最后一次 `transformPayload` 之后回调 `onWire`（before/after 摘要哈希、messages/contents 与 tools 条数）；三内置 Provider 均透传 `requestId` |
| 请求观察 | `src/agent/loop.ts` | `ActiveRequestObservation`（`subject.getRequestObservation()`）；preview 标 `basis:"preview"` + `preview-*` 身份 |

## 关键取舍（与设计文档的差异或细化）

1. **`collect` 返回 `{contributions, omitted}`**：设计示意只列 contributions；失败/注销原因必须进 Request Trace（A3），故端口返回补齐 omitted 事实条目。Composer 是唯一排序点（按 key 字节序），Registry 不承诺顺序。
2. **ContextContribution 不携带独立 `id` 字段**：身份即 `key = owner::id`，trace 条目里有展开的 `owner/id`；避免同一事实两处存储。
3. **composer 无贡献时零拷贝透传**：保证 A1（无 Source 时请求与基线完全一致）在结构上成立，而不只是测试成立。
4. **requestId 复用 `stream-{turnSeq}-{streamSeq}`（即 callId）**：usage、装配追踪、Wire 观察共用一个 id，避免第二套编号；preview 用 `preview-{uuid}` 明确区分。
5. **wire before 摘要仅在存在观察出口时计算**：序列化只为 fetch 做一次；before/after 差异以哈希比较（guard 已冻结 hook 输入，引用相等不可靠，故不做引用短路）。
6. **删除 `prepareProjection` 的死参数 `runTransforms`**：全部调用方都传 true（preview 也跑变换），参数已无语义。
7. **`ModelToolView.details` 跟随改写写入**：`details` 本就是内部投影元数据（不上 Wire），改写它的 hook 事实随 modelView 持久化；canonical 仍保留原始 details。
8. **外部观察正文 JSON 编码、内部原文缩进**：编码边界按 `source.origin` 划分（设计 §5.3 示意一致）；不宣称文本容器能消除 Prompt Injection。

## 明确不做（本轮边界）

- 不迁移业务扩展；`turn.prepare.messages/systemPrompt`、`turn.transformContext` 普通注入、Event Frame、Compaction 算法原样保留。
- 不做重要度评分、语义去重、token 分配器；预算门仍归 Subject 现有机制。
- `context.kind="runtime.perception"` 是现有 Compaction 兼容标记，下一轮迁移 Compaction 时再改名 `runtime.context`（设计 §5.3）。
- 活动请求观察暂未接入 presentation 检视面：`getRequestObservation()`/`inspectRequest().assembly` 已是稳定查询口，UI 消费随后续迁移接入（不另建第二套 Inspector）。

## 审查轮修复（2026-11-13 提交前复审）

1. **Registry 注册键分隔符保留**：`ContextSource.id` 与激活身份不得包含 `"::"`（key = `owner::id` 的还原边界），注册时拒绝并给出明确错误。
2. **Trace 片段定位**：`ContextSourceTraceEntry.charOffset` 记录贡献块/条目在目标消息中的片段偏移（设计 §8.2"哪条消息和哪个片段"），guidance 与运行时参考条目均覆盖，测试断言 `content.slice(charOffset)` 精确命中片段。
3. **取消即停装配**：`prepareProjection` 在 collect 前检查活动信号，已取消的请求不再读取 Source。
4. **删除未接线的 `Registry.list()`**（无效机制应删除），清理 guidance 分支的冗余二次活性检查。
5. **补 A6 验收测试**：preflight rebuild 后 pass 1 重新读取（读取计数 #2）、参考消息不叠加（恰好一条）。

## 验证

- 新增 5 个测试文件 33 项（含审查轮补充）：composer 装配规则、registry 快照/热重载/失败可见性、真实 decide() 请求链集成（A2/A3/A4/A5/A7）、工具模型视图（A8：真实第二次请求 + JSONL 重开）、Wire 观察（A10：真 HTTP + transformPayload 差异 + requestId 对账）。
- `pnpm test:dev` 全量：3727 passed；2 个失败均为既有/环境问题（`tts-bridge-protocol` fixture 进程退出，基线复现；`live2d-exclusive-tools` 负载下时序抖动，单独复跑 3/3 通过）——与本轮改动无关。
- `pnpm typecheck`（含 boundaries 与格式）通过。
