# Host 持久交付回执

日期：2026-10-18。状态：批 5 已实现（2026-10-25）；实现与验证见 [实施记录](../mc/host-delivery-implementation.md)。本文拥有通用工具结果/运行时输入的交付标记、状态查询与尝试退役；不拥有生产者的任务、通知内容或重试策略。Minecraft 的使用方式见 [Executor §8](../mc/modules/executor.md)。

## 1. 保证与所有权

生产者需要知道结果是否已持久进入会话。函数返回、工具流水线结束、事件入队和模型已阅读是不同事实。只有 canonical message/input 的 SessionStore.append 成功并完成该存储声明的持久边界，才能生成 committed 回执。

Host 从现有 Tool execution、Mailbox 与 Canonical history 提供此接缝。它不增加第二个邮箱、通知任务运行时或回执数据库；pending 来自活动执行/队列，committed 索引由现有带标记的会话记录增量派生并随日志恢复。回溯不抹掉已发生的交付事实，查询包含原会话的历史分支。

一个 key 表示生产者的一份固定材料，attempt 表示一次交付尝试。相同材料可呈现为全文、摘要或读取引用，不同材料不得复用 key。相同 key 可以经工具直返或运行时输入到达；重试不得重新执行产生材料的动作。协议允许相同 key 的重复呈现，保证止于持久进入会话，不认证模型已经阅读、理解或完成后续工作。

## 2. 接缝

```typescript
interface HostDeliveryTag { key: string; attempt: string }
interface HostCommitReceipt extends HostDeliveryTag {
  namespace: string; session: string; record: string; channel: "tool" | "input";
}
type HostDeliveryState =
  | {kind: "committed"; receipt: HostCommitReceipt}
  | ({kind: "pending"; attempt: string; since: string} & (
      | {channel: "tool"; activity: "processing"}
      | {channel: "input"; activity: "queued" | "processing"}))
  | {kind: "absent"}
  | {kind: "unavailable"; reason: string};
type HostRetireReply =
  | {kind: "retired"}
  | {kind: "committed"; receipt: HostCommitReceipt}
  | {kind: "changed"; state: HostDeliveryState}
  | {kind: "unavailable"; reason: string};
interface HostDeliveryPort {
  readonly namespace: string;
  readonly session: string;
  readonly durability: "durable" | "volatile";
  inspect(key: string): Promise<HostDeliveryState>;
  retire(key: string, expectedAttempt: string): Promise<HostRetireReply>;
}
```

World 的 ServiceCompanionContext.delivery 注入绑定好的 HostDeliveryPort。namespace 由 Host/注册来源固定，在同一 World 重启 activation 后保持一致；session 是当前会话身份。模型参数不设置 namespace 或回执。端口故障返回 unavailable，不把读失败当 absent；内存会话标 volatile，不能冒认持久交付。

ToolExecutionResult、WorldEvent 和内部 AgentInput 各增加可选 receipt:HostDeliveryTag。该标记是传输元数据，不进入模型提示或 Provider wire。工具消息和 input 记录保留原标记及可信 namespace；身份来自实际工具/World 注册，不能从正文中的相同 JSON 字段认领。标记随原始 canonical 结果穿过 broker/pipeline，结果投影 hook 不能替换它。

## 3. 工具直返

1. 工具生产者返回带 receipt 的结果。
2. broker 校验结果后，在任何异步 onDone/后置观察之前同步登记 pending 工具尝试；把它关联实际内部工具执行，不把 Provider callId 或审计 invocationId 当持久回执身份。
3. Subject 按现有工具交换协议追加原始 tool message，连同标记一起持久保存；append 成功后更新 committed 索引。现有 tool_result/tool_finished 都早于这一步，不能代替它。
4. append 失败仍保留 pending/明确的未知故障；Subject 的工具交换明确放弃结算或宿主退役时，释放其 pending 归属。不能把 Tool.run Promise 返回当作交换已结束，结果可能还在等同批其他工具。进程崩溃后从真实会话记录恢复：没有带标记的 canonical 工具结果，就不伪造 committed。恢复生成的 unknown 工具消息不继承生产者未交付材料的标记。

生产者通过 inspect 获取回执，不需要 Minecraft 专属 Core 事件或扫描 Host 日志。缺失回调由查询补齐；短窗口只需暂缓后台输入至本次工具交还后第一轮状态核对，不持久保存“已交出即可完成”的中间状态。

## 4. 运行时输入

Host 把 receipt 与 inputId/真实来源一同登记到现有 Mailbox。相同 namespace/key 已 committed 时不再新入队；已有活动 input 尝试时复用该占位，inspect 返回真实 attempt。不同 attempt 不是增加一份相同通知的理由。这个接收去重只约束带 receipt 的输入，不承诺所有旧版 submitInput 都已具备幂等。

render 后、canonical append 前重新核验该 input 的活动归属和 key 状态。过时/空 render/失效来源按现有退役路径释放占位；失败保留可查询状态。append 成功后才形成 committed 回执。input_accepted/input_settled 继续作为低延迟提示，最终状态以 inspect 为准。

retire 是对“当前 key 的这一次尝试”的 CAS，不是 stop 生产者任务：

- key 已 committed，返回真实回执。
- key 已 absent，幂等返回 retired；这只证明当前会话没有该交付占位。
- 当前 attempt 已变，返回 changed，不撤销新尝试。
- queued input，持久撤回既有 Mailbox 项并使 render 失效后返回 retired。
- 正在处理且尚未开始 append 的 input，先封闭其提交资格，再退役；已开始的 append 必须等其结论，不能凭超时声称撤回成功，无法确定返回 unavailable。
- 工具尝试可以释放交付占位，但不能删除协议所需的 tool message、取消其他工具或游戏任务。迟到工具结果仍可能形成同 key 的 committed 回执；通知重复是允许的，不能据此重复动作。

生产者正常等待 pending；明确恢复或旧 activation 的 render 已失效时，先 retire 旧 attempt，再以新 attempt 提交。同一 key 不按固定时间不断新增物理队列项。

## 5. 会话、失败与活性

inspect 查询端口绑定的当前 session。旧会话的 ACK 丢失而新会话不能核验时，生产者可以在新会话重新呈现同 key，允许重复；不得把新会话的 absent 当作旧动作未执行。回执携带 session/record，所有者据真实绑定核验，不能采纳模型/guest 自填的“已提交”。

正常 pending 表示 Host 仍持有输入或工具结果。Host.isBusy 只用于显示，不能用它证明某条输入已交付或丢失。端口响应故障、持久写入故障和不明确状态都保持 unavailable。显式恢复只处理交付尝试；宿主本身不恢复服务时，不宣称有无条件的最终交付保证。

对要求最终交付的生产者，前提是持久记录可用、生产者重新启用、Host/存储最终恢复且执行/邮箱得到调度；在这些条件下，未确认且仍适用的材料至少持久进入会话一次。允许 ACK 丢失导致重复，禁止依交付重试重跑外部动作。

## 6. 当前事实与实施验证

当前 [Subject](../../../src/agent/loop.ts) 在 executeOne.onDone 发 tool_result，之后才在 settleToolExchange 追加 canonical tool message；[SessionStore](../../../src/session/jsonl-store.ts) 的磁盘 append 会 sync 后更新恢复状态。[World 上下文](../../../src/extensions/world-framework/types.ts) 已注入 delivery 端口；工具、submitInput 与 emitEvent 使用同一注册来源 namespace。

实施须同步 ToolExecutionResult/AgentMessage/AgentInput、记录 schema/reducer、Subject、Host 与 Extension/World 适配；新增信息属于 Tool execution、Mailbox、Canonical history 的元数据和查询，不添加内核业务概念。当前日志已为 v4，v3 及更早格式明确拒绝，不在本任务自动改写真实日志，不保留一条“旧接缝也能保证”的旁路。

必须验证：工具结束但尚未 append；同批其他工具长时间执行；append 前后强杀；恢复生成 unknown 不误 ACK；回执回调丢失；同 key 并发入队；retire 与 append 竞争；主脑长期忙但队列不增长；跨会话重复；回溯后 committed 事实仍可查；内存存储不返回 durable。静态类型或 mock 只证明其边界，不等于磁盘/重启/真实生产者验收。


### 批 5 接线约定

`ExtensionAPI.delivery(scope?: string)` 返回当前会话端口；`registerTool` / `submitInput` 接受 `deliveryScope?: string`。namespace 为 `JSON.stringify([extensionRegistrationId, scope ?? ""])`，World 使用 `world:<name>`。submitInput 可带 World 生命周期 signal，实际提交资格同时受扩展与 World activation 约束。模型参数不能设置这些身份。

SessionStore 显式提供 session / durability。提交索引保留首份 namespace/key 记录，内存提交可查询但端口明确 volatile。恢复队列保留原占位，不恢复旧 activation 的提交资格；正常消费或显式 retire 只撤回旧交付，生产者决定是否重新呈现。无 SessionStore 的裸 Subject 返回 unavailable。
