# Uina 能力组合空间扩展规划

状态：规划稿，未代表已实现能力。

日期：2026-09-11

## 1. 目标

扩大 Extension 的可组合空间，同时保持 Core 小、稳定、可审计。Core 提供运行机制、状态转换、生命周期和最小能力端口；Extension 决定能力如何注册、继承、过滤、组合和替换。

本规划不以增加 API 数量为目标，也不把 Jobs、Subagents、记忆、感知、语音等具体玩法下沉到 Core。

## 2. 当前判断

Uina 已具备：

- Subject、Host、SessionStore、Provider、ToolBroker 的基本运行切片；
- builtin 与 project extension 共享 activation scope；
- Provider、tool、command、renderer、hook 等注册接缝；
- 子 Agent 的显式 owner 和默认能力继承；
- 取消、unknown、失败和异步清理的基本语义；
- Host 快照与事件流，UI 不再直接拥有主体生命周期。

仍存在的结构性差距：

- 能力继承主要通过工具复制实现，缺少统一 Capability View；
- registration 仍是多组专用函数，来源、状态和注销协议没有统一抽象；
- Provider name、model name、registry key 仍有混用风险；
- Job 与 Subagent 的运行句柄、取消、等待和关闭语义重复实现；
- reload 已有生命周期清理，但还不是完整的能力集合原子替换；
- 扩展没有稳定 SDK 边界，仍可能依赖源码内部路径；
- 能力状态缺少统一的 declared、active、failed、stopping、disposed 视图。

上述内容是当前代码结构判断，不是对未来能力的承诺。

## 3. 原则

### 3.1 Core 提供机制

Core 负责：

- 运行循环、输入顺序和生命周期；
- Tool/Provider 等最小执行端口；
- owner、取消、结果状态和恢复事实；
- 有序事件与可观察快照。

Core 不负责：

- Jobs、Subagents、记忆、感知、语音等业务模型；
- 扩展之间的具体组合策略；
- UI 专用状态和产品工作流。

### 3.2 能力默认开放，收缩必须显式

- Root 默认拥有当前可用能力；
- Child 默认继承父级能力；
- include/exclude 只作为调用者明确指定的策略；
- Core 不根据能力名称偷偷过滤；
- 能力不可用时必须返回明确错误，不静默降级为另一种能力。

### 3.3 观察、变换和执行分离

- observe：只读观察，不改变事实；
- transform：显式返回新值；
- execute：由 Core 或能力 owner 执行并结算；
- 每个扩展 handler 都带来源和 activation 生命周期。

## 4. 分阶段路线

### 阶段 1：Capability View

建立统一只读能力视图：

`tools()`、`providers()`、`commands()`、`canUse(kind, id)`。

要求：

- 每个 Agent、Job、Subagent、Activation 获取自己的 view；
- view 只描述可用能力，不复制第二套权威注册表；
- ToolBroker 不再负责能力继承策略；
- Core 负责执行和 owner 校验，Extension 负责组合策略。

验收：父子 Agent 能继承、收缩并报告能力来源；无隐式固定白名单。

### 阶段 2：统一 Registration

引入统一的内部 registration 记录：

`id`、`kind`、`owner`、`source`、`state`、`dispose()`。

现有便捷 API 可以保留，但必须落到同一套 registration 机制。

验收：重名、注销、来源、失败和 stale context 均可定位；builtin 与 project extension 使用同一生命周期路径。

### 阶段 3：Provider/Model 领域对象

分离：

- ProviderId；
- ModelId；
- ModelDescriptor；
- ModelRuntime。

ModelDescriptor 保存来源明确的 context window、thinking levels 和其他能力事实。ModelRuntime 只负责请求、流式响应、取消、usage 和协议错误。

保留原始 Provider 对象身份，避免用表面 wrapper 破坏额外字段或特殊方法；生命周期控制应由 registry/registration 负责。

验收：同名模型不会误合并；未知能力保持未知；扩展 Provider 可注册、调用、卸载和重新加载。

### 阶段 4：统一 Runtime Handle

不合并 Job 与 Subagent 的业务类型，只抽取共同运行句柄：

`id`、`ownerId`、`signal`、`status()`、`interrupt()`、`wait()`、`dispose()`。

各自保留自己的输出、transcript、result 和业务状态。

验收：取消、关闭、终态、失败和通知路径行为一致，且没有并列生命周期实现漂移。

### 阶段 5：能力集合原子替换

reload 流程应明确为：

1. 停止接收新调用；
2. 等待、取消或结算旧调用；
3. 卸载旧 activation；
4. 激活新 capability set；
5. 新集合可调用后再恢复入口。

失败时保留旧集合或明确进入 failed 状态，不发布“重载成功”。

### 阶段 6：稳定 SDK

暂不拆 npm 包，先提供稳定 SDK 入口，避免项目扩展依赖内部源码路径。SDK 只暴露：

- Extension API；
- Capability 类型；
- Provider/Model 契约；
- Runtime event；
- UI contract。

不暴露 Subject 内部字段、SessionStore 具体实现、registry 内部 Map 或 UIHost。

### 阶段 7：能力诊断

提供统一查询：

`declared -> loadable -> active -> healthy -> callable -> failed/stopping/disposed`。

先服务测试和诊断，不急于制作复杂 UI 页面。

## 5. 真实组合验收场景

构造一个完整组合场景：

- 扩展 A 注册工具和后台 Job；
- 扩展 B 观察 Job 完成；
- 扩展 C 将 Job 结果投递回 Root；
- 扩展 D 提供结果 renderer；
- 扩展 E reload 时替换工具实现。

必须证明：

- 每项能力都有来源；
- Root/Child 能显式继承或收缩；
- Job 结果通过统一 mailbox 返回；
- reload 不残留旧注册；
- 旧引用调用明确失败；
- 失败不会伪造成成功；
- UI 只消费 projection；
- Host 不依赖 UI。

## 6. 与 Pi 的借鉴边界

应学习 Pi 的实际实践：

- 低层 Agent 与产品扩展层分离；
- Model 是带 metadata 的领域对象；
- handler 绑定扩展来源；
- registration 与生命周期绑定；
- stale context 明确失效；
- listener settlement 属于运行生命周期；
- 内置能力与扩展能力尽量使用共同接缝。

不机械复制：

- coding-agent 专属工具和 prompt；
- session tree、fork、lane；
- project trust；
- 完整 TUI 产品层；
- Pi 的默认产品假设。

Pi 的启示不是“少做校验”，而是把必要约束封装在成熟的低层运行时里，降低扩展作者的额外摩擦。

## 7. 实施顺序与停止条件

实施顺序：

1. Capability View；
2. Registration/Status；
3. Provider/Model 拆分；
4. Runtime Handle；
5. reload 原子替换；
6. SDK 边界；
7. 真实组合验收。

停止或收缩条件：

- 新设计需要第二套并列 registry；
- 为支持一种具体扩展而修改 Core 专用分支；
- 扩展接入成本明显高于当前 API 且没有可靠性收益；
- reload 需要复制状态或隐藏同步；
- 组合场景无法通过当前真实入口验证；
- Provider/Model 抽象不能减少身份混用和协议维护成本。

## 8. 当前不做

- 不增加权限系统、沙箱或任意并发上限；
- 不预先实现记忆、感知、语音或自治机制；
- 不为了形式统一强行合并 Job 与 Subagent；
- 不把设计文档当作已实现证据；
- 不在没有真实需求和验收场景时拆分 npm 包。

## 9. 下一步

下一次实施从阶段 1 开始：先建立 Capability View，并用 Root/Child 工具继承与显式收缩场景验证它确实减少了现有分支，而不是增加一层包装。
