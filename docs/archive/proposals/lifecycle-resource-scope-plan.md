# 生命周期资源作用域重构规格与实施计划

状态：2026-09-28，针对第三阶段未推送提交的审查与执行稿。

## 一、审查结论

生命周期的不可逃避事实只有两类：

1. 接受中的工作必须可取消，并在所有者关闭前结算。
2. 注册、订阅、活引用和 UI 状态必须随同一次激活一起失效。

`ResourceScope` 已经能表达这两个事实，因此它应当是 Extension 和 App activation 的唯一资源所有者。`WorldRegistry` 不应再保存与 scope 重复的 disposer 容器或订阅集合。

本次审查确认一个真实时序错误：App 停用时先启动 `scope.close()`，却没有等待它完成就调用 `onStop`。这会让 `onStop` 与在途 action 并行运行，破坏停止钩子的生命周期契约，也可能让外部服务在动作仍未结算时提前被关闭。

## 二、目标不变量

- 一次 App activation 只有一个 `ResourceScope`。
- 工具注册、宿主订阅、应用暴露项清理都登记到该 scope；不保留平行的 App 级 disposer 状态。
- 停用顺序固定为：标记不可用 -> scope 发出取消 -> 等待已接受工作结算并执行资源清理 -> 执行 `onStop` -> 丢弃 activation。
- `onStop` 失败不伪装成停用成功；scope 清理失败与 `onStop` 失败都被汇总上报。
- 启动失败按同一顺序回滚，不残留工具、订阅或暴露项。
- ExtensionRunner 与 WorldRegistry 共享生命周期原语，但不互相拥有对方状态。

## 三、实施步骤

1. 删除 World activation 中重复的工具 disposer，工具注销直接由 `ResourceScope.onDispose()` 接管。
2. 删除无业务读取价值的 `subscriptions` 集合，订阅 disposer 直接登记到 scope。
3. 修正 App 停用与启动回滚的等待顺序，使 `onStop` 发生在 scope 完成之后。
4. 增加并发回归测试，证明正在执行的 action 先收到取消并结算，`onStop` 才运行。
5. 执行类型检查、测试、构建和开发基线；只报告当前 checkout 的新鲜证据。

## 四、明确删除项

- 不增加第二个 App 生命周期状态机。
- 不保留旧 disposer 字段作为兼容入口。
- 不把 `onStop` 改成后台 fire-and-forget。
- 不新增 Core 概念；这是 Extension 内部生命周期所有权修正。

## 五、本轮进一步收敛

审查发现三个 App 仍在 `ctx.signal` 上重复挂载停止回调，同时又在 `onStop` 中执行同一资源清理。该模式把同一资源的生命周期拆成两条隐含路径：取消时 fire-and-forget，正式停用时 awaited。即使当前资源的 `stop` 大多幂等，也无法保证停用时序和错误可见性。

本轮删除这些 App 侧 abort listener：`ResourceScope.close()` 是唯一取消入口，`WorldRegistry` 等待 scope 结算后才调用 `onStop`，资源自身的关闭协议只保留在 `onStop` 或其内部 teardown。这样取消只表达“停止在途工作”，清理只表达“释放业务资源”，两者不再重复执行。

同时确认不删除 Live2D 的通道租约/动作仲裁：当前动作层确实存在基础姿态、主动动作、反射和声学驱动的独立控制需求，现有租约不是仅由命名推断出的冗余。没有确定性帧回放证据前删除它会降低组合能力，违背本阶段的收敛原则。

## 六、尚未实现的目标

以下内容仍是后续工作，不作为本轮已完成事实：

- 独立打包后脱离仓库运行四个 App；
- 指定 App 的模块重载；
- 真实 Provider 的 Token/cache 成本与模型行动效果对照；
- 真实 VTS、伴生服务和跨重启部署验收。

本轮只处理已被当前调用链和回归测试证明的生命周期重复机制，并没有新增 App API、Loader 隔离或安全沙箱。

## 七、验收

- 静态：World activation 只保留 scope、暴露表；无重复 disposer 容器。
- 行为：动作执行期间停用时，动作先收到 abort/结算，之后才进入 `onStop`。
- 工程：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm dev:baseline -- --quick` 均以当前 checkout 的新鲜输出为准。
