# 批 5：Host 持久交付回执实施记录

日期：2026-10-25。基线：`codex/phase0-baseline` / `6fbd9a4`，开工工作树干净；本批提交包含下述实现、接线、测试和文档。

## 边界与裁决

本批交付 journal v4、canonical 提交索引、工具尝试、Mailbox 去重/退役和 Host/Extension/World 接线。行为权威是 `../runtime/delivery-receipts.md`。不增加 MC 玩法、通知策略或 WorldDef，不修改真实会话、认证、Provider、Minecraft 数据或 Pi。

采用现有 checkout，保留当前分支归属，不另建 worktree。公共元数据属于 Tool execution、Mailbox 和 Canonical history，内核无 Minecraft 分支。

- namespace 固定为 `JSON.stringify([extensionRegistrationId, deliveryScope ?? ""])`；World scope 为 `world:<name>`。来源由注册链绑定，不读取模型参数。
- Session reducer 增量保留首份 namespace/key 提交事实，跨回溯保留；端口补入真实 SessionStore 会话身份。无额外日志 walker 或回执存储。
- bare Subject 没有 SessionStore 时端口明确 unavailable；Host 总有磁盘或内存 SessionStore，后者明确 volatile。
- `submitInput` 额外接受 World 生命周期 signal，以覆盖没有 deferred render 的排队输入；它不改变任务停止语义。
- 同 key 允许工具重复呈现，输入只复用活动占位。retire 只撤回交付资格，不停止生产者动作。

## 任务进度

1. Session/public contracts：已实现。v4、身份/持久等级、增量索引、v3 拒绝；新测试先失败，再通过。
2. 工具交换：已实现。Broker 校验后同步登记，canonical append 才确认，direct 工具不 ACK。
3. Mailbox：已实现，竞争验证已补齐。活动尝试覆盖排队/render/append，CAS 撤回与既有 claim 共用持久队列撤回。
4. Host/World：已接线，真实 Host 关闭重开与独立 Node 强杀场景已通过；源码与构建产物均使用同一正式 Host/Session 路径。

## 独立审查收口

两项 Important 均先新增失败回归，再修复：

- 入队失败后旧 admission Promise 不能永久阻塞显式 retire。SessionStore 暴露现有不可恢复 writeFailure；回滚成功时内存状态仍等于磁盘，可确认撤回，回滚失败则 unavailable、要求重开。
- 旧 render 退役后抛错，回滚只恢复仍拥有完整 namespace/key/attempt 的输入；旧回调不得把错误记到复用 input ID 的新尝试。

实际 JSONL 写入/回滚故障验证不会把 poisoned store 的 absent 当成持久事实。没有增加自动重试、数据库或通知调度器。

## 验证

- `pnpm typecheck`：PASS（592 文件格式检查、9 条边界、TypeScript）。
- `pnpm test`：最终默认池 **241 文件通过，2605 passed / 1 expected fail（共2606项）**。日志：`C:/Users/34150/AppData/Local/Temp/uina-delivery-full-verified.log`。
- 新增回执测试 **4 文件 / 26 项**，覆盖真实临时 JSONL、Host 关闭重开、跨会话/namespace、volatile、工具延迟与直返、输入去重、render/append/退役竞争、临时写入失败、回滚失败和旧尝试隔离。
- `pnpm build`：PASS（native asset、完整 TypeScript 产物与资源复制）。
- `UINA_DELIVERY_ARTIFACT=dist pnpm exec vitest run tests/delivery-process.test.ts`：最终产物 **2/2 PASS**。子进程直接以 Node 加载 `dist/src/host/host.js`（不加载 tsx），分别在 canonical append 前/后强杀，再以产物 Host 重开实际 JSONL 查询。日志：`C:/Users/34150/AppData/Local/Temp/uina-delivery-artifact-final.log`。
- 源码进程强杀测试同样在最终默认池全量中通过；没有用历史日志代替本轮恢复验证。
- `git diff --check`：PASS。

首次全量仅两处 v3 header 夹具失败，已更新对应会话夹具，不涉及其他 v3 领域格式。随后一次全量出现未修改 UI 模型选择器用例的偶发失败；单文件179项及最终全量均通过，未扩改 UI。独立审查两项 Important 已由失败回归复现、修复并随最终全量通过，没有未收口的本批缺陷。

证据边界：受控模型流用于驱动真实 Host/Subject/SessionStore，不证明真实模型体验或游戏动作。本批没有连接 Paper、真实模型、Microsoft 账号，不修改真实 Provider、认证、会话、MC 世界或 Pi。下一批仍为批6正式原生主脑入口与可靠通知。

工作树归属：全部改动归属 `codex/phase0-baseline` 的本批提交，未推送。`dev/FACTS.md`、`dev/DECISIONS.md`、`dev/MC-WORLD.md` 已在本机同步；这些文件原本被仓库忽略，未强制加入 Git。


## 提交前常规审查

快速复核发现一处额外竞态：输入撤回等待期间，同 key 工具可能已经提交，但 retire 返回等待前缓存的状态。新增失败回归后，将查询移到持久撤回与清理完成后，返回实际 committed 回执。未扩展本批边界。

提交前检查：类型/9条边界与构建 PASS，回执专项4文件26项 PASS。新增退役竞态回归先失败后通过。提交前全量为240文件通过、1文件失败，2605 passed / 1 expected fail / 1 failed；唯一失败为未改动的 `overlay-keys` 模型选择器 Enter 用例，该文件单独复跑10项全部通过。日志 `C:/Users/34150/AppData/Local/Temp/uina-delivery-precommit.log`，不将本次全量记录为全绿，未扩改UI。
