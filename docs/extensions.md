# 扩展契约与组合设计

状态：已实现。基线 Uina 0244ab0；Pi 对照为本地 e266507b6。运行事实总览见 [current-runtime.md](current-runtime.md)。

## 职责与取舍

Extension 提供能力与策略；Core 保留执行事实、取消、协议与会话提交；Host 保留主体装配；UI 保留展示。接缝包括工具、程序服务、上下文贡献、压缩策略和展示注册；没有新增通用事件总线、依赖求解器、权限层或另一套权威状态。

## 加载与生命周期

自动发现 cwd 下 .uina/extensions/ 的顶层脚本、一级子目录 index.ts/js/mts/mjs，或 package.json 中 uina.extensions 声明的脚本入口数组。脚本支持 ts/mts/cts/js/mjs/cjs，不递归扫描实现文件。CLI 可重复使用 -e/--extension 指定文件或目录；嵌入 Host 使用 extensionPaths。真实路径去重，额外入口不改变配置与会话位置。

加载器采用 Pi 使用的 jiti，关闭模块缓存与原生导入旁路，重载覆盖本地子模块。重载先导入候选，再卸载旧项目扩展并激活新版本。导入执行模块顶层代码，**不是无副作用预检**；资源申请应放在 activate 中。导入失败保留旧 activation；激活失败回收该扩展的部分注册，不承诺整体事务回滚。

ActivationScope 拥有注册、取消信号和工具、服务、模型流、上下文贡献及压缩策略的在途调用。卸载使 API 失效、发出取消、执行 teardown、等待在途调用结算，再释放注册。直接创建的进程、监听器等须由扩展 teardown 或 api.signal 关闭。单项注销停止后续解析；完整卸载传播取消。工具已明确返回的结论保留；取消时抛错且副作用未确认则为 unknown。

## 注册与替换

工具、命令、Provider、Model、服务、压缩器、renderer 和 Markdown transformer 默认拒绝重名；显式 { replace: true } 才替换。注册返回注销函数，并归属 activation。注销只释放自己的注册，恢复前一个仍存活的实现。

工具执行前发现注册已替换或卸载时返回 not_started，不把旧 schema 校验过的参数交给新实现。widget/status 按扩展命名空间隔离；header/footer 是共享槽，最后设置者生效，清除或卸载恢复其他存活贡献。

## 公共操作

类型入口：src/extensions/index.ts。

| 操作 | 语义 |
| --- | --- |
| registerTool / callTool | 模型可用能力；程序调用同样经过 schema、hook、取消和结果管线 |
| registerService / callService / hasService | 扩展间请求/响应，每次按名称解析当前实现 |
| registerProvider / registerModel | 分别注册端点与模型事实 |
| models.current/list/groups/resolve/select/stream | 获取事实、分组目录、选择模型、使用现有传输，不暴露凭据 |
| models.thinkingLevel / setThinkingLevel | 思考档位事实与设置（与宿主同一应用纪律） |
| usage / isBusy / reload / shutdown | 主体用量与忙闲事实；扩展重载与消费者关闭流程 |
| history / emitEvent | 主线 hydrated entries 只读访问；capability 事实出口（session_compact 等广播） |
| registerToolRenderer / registerMarkdownTransformer | 变换显示，不改变执行与模型上下文 |

callTool 的 ownerId 是实际 Subject，callerId 是调用扩展；嵌套调用有独立 callId。程序调用写入带来源的 extension.tool 自定义条目，不伪造 assistant tool call，也不自动加入模型历史。调用者通过工具返回、sendMessage 或 submitInput 决定如何继续传递结果。

callService 使用可 structuredClone 的数据。实现收到 callerId 和合并后的 AbortSignal；服务作者负责输入合同。建议明确名称，如 search.query/v1；不兼容合同使用不同名称。依赖在实际调用时解析，避免依赖文件名决定激活时序。

工具供模型选择，服务供程序复用，已有事件供观察事实。确定性调用不需要绕道模型或用事件模拟 RPC。

## 上下文组合

干预与观察是两个词表（Hook ≠ Event）：`pi.on(type)` 只订阅**事实**（RuntimeEvent：已经发生的，无返回值）；`pi.onHook(hook)` 在**干预点**注册（如 `turn.prepare`、`turn.transformContext`、`tools.beforeCall`、`provider.transformHeaders`），返回值按该链的合并规则参与组合。合并规则：turn.prepare 后写覆盖/消息聚合；transformContext、tools.transformResult、provider.transformHeaders/transformPayload 链式传递；beforeCompact、shouldStop、beforeCall 短路；observeResponse 纯观察。

回合注入只有两条时机：`turn.prepare`（回合边界；贡献形状 messages 聚合追加）与 `turn.transformContext`（每请求）。registerContextContributor 第三条路径已退役（P2，inventory #2）：同一功能由 turn.prepare 的有状态 handler 承担。turn.prepare handler 不接收取消信号——回合中断后其结果会被丢弃；扩展自身的生命期取消用 api.signal。

贡献内容应标明来源。昂贵检索、索引或模型调用尽量异步准备，贡献阶段读取结果；没有引入隐式轮次、并发或容量上限。

## 压缩策略与提交（P6c）

压缩（上下文窗口管理）由 official compaction capability 端到端拥有，唯一入口是 `turn.transformContext` 每请求裁剪（Interceptor 链）。journal 保留全量历史，任何压缩路径都不再截断它；滚动摘要以 `uina.compaction.summary` custom entry（Auxiliary）持久化，重启后从 `pi.history()` 重载。

- 自动压缩：估算超窗口预算（reserve 随窗口缩放）时按 keepRecent 语义裁剪当前请求上下文，摘要覆盖与裁剪边界同点对齐（无未摘要间隙）；摘要锚定生成时主线头 entry id，回溯切断锚即失效重生成。
- 手动压缩：`/compact [instruction]` 命令（capability 注册）只设强制标志，下一次请求的 transformContext 强制裁剪并携带 instruction；没有下一个请求就没有压缩对象。失败经 `session_compact_failed` 事实事件可见。
- 扩展自定义裁剪策略：在同一条 `turn.transformContext` Interceptor 链上注册（后激活者收到前者的输出，链式传递）；与 Memory/RAG 等注入扩展共存。
- 事实出口：`session_compact` / `session_compact_failed` 经 `pi.emitEvent` 进扩展事件总线（Hook ≠ Event：transformContext 是干预注册点，session_compact 是事实广播）。

旧 canonical 压缩记录（独立 compaction record 与 rewind record 内嵌 compaction 载荷）按数据模型原则 legacy 化：旧 journal 由投影照常解释，新链路零产生。`SessionStore` 接口已无 `appendCompaction`。

## 图片与展示

正文继续用 content/result 字符串；images 是 { type: "image", mimeType, data, alt? } 数组，data 为 base64 字节，支持 PNG/JPEG/GIF/WebP。工具 details 供程序和 UI 使用，不发送给模型。

输入、custom message、工具结果、hook、JSONL、上下文投影和 Host 事件保留图片。imageInput 必须来自配置、模型注册或目录事实；false 时内置 Provider 明确报错；未知允许尝试，不删除附件或将尝试结果自动登记为模型能力。

OpenAI-compatible 将工具图片放在全部相邻 tool result 之后的 user 图片消息，标明 callId；Anthropic 放入 tool_result 内容；Gemini 编码为对应 user 内容的 inlineData。没有新增图片生成、音视频或远程资产管理。

TUI/stdio 默认显示图片元数据，不输出 base64。立即处理会继续消费原队列，保留来源和附件；文本编辑器不能承载的图片/扩展事件会留在队列，不回填为普通文本。实际终端位图协议未实现，扩展可提供自己的显示。

工具 renderer 收到调用身份、参数、结果、状态、images/details 及宽度/展开信息；不存在或返回 undefined 时用通用卡片。渲染错误可见，不改变工具结论。注册变化使转录缓存失效，恢复后的工具走同一 resolver。

Markdown transformer 只处理 user/assistant 显示文本，带角色、流式状态与宽度，不写回历史。回调同步，不能在每帧执行网络工作。

## 资源与示例

没有照搬 resources_discover hook。Pi 该事件服务于已有 skill/prompt/theme loader；Uina 先用程序服务证明资源发现与消费，再决定是否需要公共资源层。

- [workspace-tools](../src/extensions/workspace-tools/index.ts)：默认内置文件读写、图片读取、文件 renderer；Host `workspaceTools: false` 可禁用，公开 replace 注册可替换。
- [skills](../examples/extensions/skills/index.ts)：skills.discover/v1、上下文目录与 read_skill；后者调用 workspace-tools 的 read_file。
- [custom-compaction](../examples/extensions/custom-compaction/index.ts)：在 turn.transformContext 链上提供自定义裁剪策略。

技能示例展示组合合同，不声称实现完整 Pi skill 元数据规范。目录来源、技能选择和提示词属于扩展；文件工具没有下沉到 Core。

## 验证边界

extension-composition.test.ts 覆盖服务调用/失效、替换恢复、工具校验竞争、子模块重载、共享 UI 槽、上下文贡献、压缩触发/失败/取消/恢复，以及真实示例组合。

image-content.test.ts 使用实际 PNG 和临时 JSONL，覆盖工具 → 本地 OpenAI-compatible HTTP → 重开 → UI 元数据，并检查 Anthropic/Gemini 编码、未知能力拒绝和排队图片恢复。

最终离线验证：pnpm typecheck 与 27 文件/375 项测试通过。最新源码在隔离目录执行相同 build 脚本及编译 CLI 检查通过；原 dist 的 native 文件被已有 Uina 进程占用，因此没有中断进程强行清理。

本轮另运行真实 DeepSeek 文件事件验收：用户在后台工作期间得到答复、后台结果、安静决定、失败、取消和卸载通过。它不证明视觉能力。

以上图片检查是本地协议与组件证据。真实视觉 Provider 的服务端接受与识图质量、真实 TTY 位图、扩展崩溃隔离、跨重启后台活动对账仍未验证或未实现。编译 CLI 验证另覆盖通过 -e 加载 TypeScript 目录扩展并回注实际 PNG。历史通过记录不保证未来 checkout。
