# 扩展开发指南

面向当前实现。完整设计、组合语义与限制见 [扩展契约](extensions.md)，运行事实见 [current-runtime.md](current-runtime.md)。

## 加载

- 自动入口：Host.cwd 下 .uina/extensions/ 的脚本或一级目录入口。
- 目录使用 index.ts/js/mts/mjs，或 package.json 的 uina.extensions 数组声明脚本入口。
- 显式入口：pnpm start -e examples/extensions/skills；-e/--extension 可重复。
- 内置能力：组合层调用 ExtensionRunner.activateBuiltin，与项目扩展共用注册生命周期。

脚本支持 ts/mts/cts/js/mjs/cjs。源码与构建后的 CLI 都通过 jiti 加载扩展；项目扩展无需先纳入 Uina 的构建。相对资源路径应基于 api.cwd 或 api.path，不假设进程工作目录与嵌入 Host 相同。

/reload 等待主体空闲后重载项目扩展及其本地导入模块，保留内置 activation。导入预检失败保留旧 activation；顶层代码仍会执行，资源申请应放在激活函数中。

## 最小扩展

保存为 .uina/extensions/hello.mjs：

~~~js
export default function activate(api) {
  api.registerCommand({
    name: "hello",
    description: "显示通知",
    handler: () => api.ui.notify("hello 扩展已生效"),
  });
  api.registerTool({
    def: {
      type: "function",
      function: {
        name: "hello_echo",
        description: "返回文本",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    run: async (args) => ({ result: args.text, status: "succeeded" }),
  });
}
~~~

使用已有模型配置运行 pnpm start，输入 /hello；请模型调用 hello_echo 验证工具。命令名不带斜杠。激活函数可异步，并可返回同步或异步 teardown。

类型入口是 [src/extensions/index.ts](../src/extensions/index.ts)。TS 扩展可以按实际文件位置 type import；没有独立发布的 Uina npm SDK 包。

## 工具与服务

run(args, signal?, context?) 返回 { result, status, images?, details?, continuation? }。status 必须区分 succeeded、failed、cancelled、unknown、not_started；取消请求不等于副作用已经停止。把 signal 传给支持取消的操作。context.ownerId 属于实际 Subject；程序调用另带 callerId。

用 api.callTool(name, args, { signal }) 复用其他工具，保留执行管线。不要直接调用另一个扩展的 tool.run 绕过校验和事实记录。details 可携带结构化数据；模型正文仍使用 result 字符串。images 携带真实字节，模型 imageInput 未知时允许尝试，明确 false 时拒绝，true 表示显式声明支持。

程序间的查询可用服务：

~~~js
// 提供者
api.registerService("index.query/v1", async (input, { signal }) => {
  signal.throwIfAborted();
  return { matches: [input.query] };
});
// 消费者：在实际操作时解析，而非依赖激活顺序
const result = await api.callService("index.query/v1", { query: "example" });
~~~

注册默认拒绝重名。显式 { replace: true } 替换，返回的注销函数只释放该次注册；卸载后恢复前一个存活实现。所有注册也自动归属 activation。

程序间的**行为**交付不能走服务：`callService` 对入参与返回值双向 `structuredClone`，函数会被丢弃、带闭包或原型方法的对象直接抛 `DataCloneError`。要把活引用交给其他扩展，用同进程共享：

~~~js
// 提供者：登记活引用（对象或函数），返回注销函数
const dispose = api.share("embodiment.endpoint:arm", endpoint);
// 消费者：在实际使用时解析，而非依赖激活顺序
const endpoint = api.shared("embodiment.endpoint:arm");
~~~

共享表零语义（宿主不解释名字与值的含义）、不序列化、**仅同进程有效**；重名即报错而非覆盖——覆盖会让已经取过值的消费者指向非预期对象；生命周期与 `registerService` 同权，提供方 activation 卸载时自动回收。

**铁律：纯数据走 `callService`，活引用走 `share`。** 判据是要交付的东西有没有行为：配置、状态、描述符走服务；带方法的对象、回调、订阅端走共享。两者不互相替代，也不要用其中之一去模拟另一个。

## 消息与主动输入

- sendMessage({ customType, content, images?, display?, details? })：持久化并参与模型上下文，自身不触发回合；display:false 只隐藏展示。
- appendEntry({ customType, data? })：capability 私有持久状态（auxiliary timeline）——持久化但既不进入模型上下文、也不进入主线与回溯目标；用 auxiliary() 读回自己的记录。会话级可见消息用 sendMessage。
- submitInput({ id, mode, source, text, images?, data? })：进入主体输入入口，空闲时启动，忙时排队。

外部观察使用 source.kind="runtime"，保留来源，不伪装成人类输入。id 与非空 text 必需；持久化数据应能无损 JSON 表达。不要在主体正在等待的 hook 中 await 一次重新进入同一主体的调用。

工具 continuation:"stop" 在记录结果后结束当前决策，不丢弃其他排队输入或撤销已执行副作用。

## 模型、压缩与 UI

registerProvider 与 registerModel 分别提供端点和能力事实；models.current/list/resolve/select/stream 使用公共模型入口，不接触凭据。能力未知时保持未知。

压缩由官方 compaction capability 端到端拥有：唯一入口是 turn.transformContext 每请求裁剪（journal 保留全量历史），/compact 为其命令。自定义裁剪策略在同一条 transformContext 链上注册（后激活者收到前者输出）；私有摘要状态用 appendEntry/auxiliary 落盘。完整示例见 [custom-compaction](../examples/extensions/custom-compaction/index.ts)。

registerToolRenderer 与 registerMarkdownTransformer 只控制显示。widget、header/footer、overlay、输入对话框和编辑器操作通过 api.ui 使用。先判断 ui.hasUI()，无 UI 时不能把 select/input 的 undefined 或 confirm 的 false 当成人类答复。

## Hook 与贡献

干预用 onHook(hookName, handler)，观察用 on(event, handler)——Hook 与 Event 各一词表、各一出口。现役干预点（8 条）：turn.prepare 的 { systemPrompt?, model?, thinkingLevel? }（后写覆盖先写）、turn.transformContext 的 { messages }（链式）、turn.shouldStop 的 { stop }、tools.beforeCall 的 { block?, reason? }、tools.transformResult 的 { result?, status?, images?, details? }、provider.transformHeaders/transformPayload/observeResponse。完整类型见 [hooks](../src/runtime/hooks.ts)。

只需追加上下文时在 turn.transformContext 链上返回 { messages: [...原消息, 追加项] }；需要整组替换时返回整组。后激活者收到前者的输出（链式传递），与压缩、Memory 注入等 capability 共存。注册时可传 { tail: true }（尾部相位）：tail 注册者无论注册先后恒排在非 tail 之后，用于瞬态尾部注入——可变世界状态（应用视口/具身状态快照）经 buildEventFrameGroup 包装为 external_event_frame 三消息组追加到完整上下文最末尾，不落 Session 历史、不进 systemPrompt（system 只放基本不变的内容；可变内容进系统提示会从 token 0 击穿前缀缓存并占据特权位）。完整示例见 [custom-compaction](../examples/extensions/custom-compaction/index.ts)。

## 清理与验证

扩展自己创建的监听器、进程、计时器须通过 teardown 或 api.signal 关闭。API 在卸载时失效；清理函数操作自己持有的资源，reportError 可报告清理失败。注册、公共工具/服务调用和模型流会随作用域清理；任意外部资源不会被运行时自动猜测回收。

嵌入 Host 缺少模型、Provider、消息或输入端口时，相应操作明确失败。标准 Host 已接入；不能把一次 API 调用当成未接线能力的成功证据。

[workspace-tools](../src/extensions/workspace-tools/index.ts) 与 [skills](../examples/extensions/skills/index.ts) 展示文件、图片、服务、工具、上下文和 renderer 的组合。检查入口、实际 cwd、default export、重名、失效 API，再检查依赖与外部错误。真实 Provider 验收使用临时数据，不属于普通离线测试。

## 默认文件与图片工具

`builtin:workspace-tools` 随 Host 启动；无需加载原 workspace-tools 示例。`read_file` 读 UTF-8 文本，可传 `offset`（从 1 开始）与 `limit` 选择行；输出上限 2000 行 / 50KB（先命中者生效），截断时在尾部附续读 offset 提示，单行超限则截前 2000 字符并给 exec_command 兕底；前 8KB 含 NUL 字节按二进制拒读。`write_file` 覆盖 UTF-8 文件，父目录须存在。`read_image` 按文件签名识别 PNG/JPEG/GIF/WebP，传递原始字节；签名识别不等于完整图片解码校验。路径相对 `api.cwd` 解析，绝对路径可用。

Host 可用 `workspaceTools: false` 关闭这组默认能力。项目扩展通过 `registerTool(..., { replace: true })` 与 `registerToolRenderer(..., { replace: true })` 分别替换行为和展示，释放注册后恢复前一个存活实现。

## 会话历史与回溯

`api.session.list({ scope: "main" | "all", after?, limit? })` 返回节点（含 id、parentId、active、canRewind、预览）、headId 和可选 next。after 使用上一页返回的节点 ID；默认每页 50 项，可显式调整。`api.session.read(id)` 返回完整节点，包含图片与元数据。返回值是快照，修改它不会改变会话。

`api.session.requestRewind({ targetId, reason, summary? }, { signal? })` 的来源绑定当前扩展。忙于回合时返回 scheduled，整批工具结算后提交；空闲时提交并继续运行，再返回 committed。成功记录含 requestId，错误含同一请求 ID；scheduled 只表示已排期，重启不自动补执行。扩展卸载会取消尚未提交的请求。已提交的回溯不会因后续取消撤销。

`session_rewind` 事件在提交后发送，含请求、回溯节点、原位置和目标 ID；它是观察事件，不可取消已经提交的事实。摘要、目标选择和自主纠错策略由扩展实现，可复用模型 API，无需新增专用 hook。业务状态应按其所有者恢复，不能把主线投影当作外部世界的历史快照。
