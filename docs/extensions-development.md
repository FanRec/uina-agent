# 扩展开发指南

适用：2026-09-05 当前工作区实现。面向项目扩展作者和 Uina 内置能力开发者。本文记录已有 API，不把 Pi 的全部 API 或规划中的功能当作 Uina 已支持的能力。

## 1. 两种加载方式，一套注册生命周期

| 方式 | 入口 | 使用者 |
| --- | --- | --- |
| 项目扩展 | `<cwd>/.uina/extensions` 中的文件，启动时自动扫描 | 给当前项目增加工具、命令、观察来源和 UI |
| 内置扩展 | 组装层调用 `ExtensionRunner.activateBuiltin(id, activate)` | 随 Uina 提供的命令、后台任务和子 Agent 工具 |

两种方式最终都调用默认激活函数并交给 ActivationScope 管理注册。入口位置不同，不要求将所有内置能力搬到 `.uina/extensions`。共享生命周期也不意味着获得相同的服务实例：内置激活函数可以由组装层注入服务，普通扩展只能直接使用公开 API 或自己创建的资源。

`cwd` 是 Uina 进程的当前工作目录。按在 `E:\Uina\Uina` 中启动的方式，扩展目录为 `E:\Uina\Uina\.uina\extensions`。它不是沙箱，也不是全局配置目录。本地扩展在当前进程内运行，默认受信任。

当前扫描规则：只扫描该目录第一层，按文件名排序加载；识别 `.js`、`.mjs`、`.cjs`、`.ts`，不递归发现子目录入口，也不发现 `.mts`/`.cts`。识别后仍由运行环境加载模块，识别后缀不等于支持任意 TypeScript 语法或 CommonJS 导出形式。推荐 ESM `.mjs`；TS 开发可用 `pnpm start` 的 tsx 环境。

目前没有全局扩展自动发现、npm/git 插件安装器、manifest 扫描或 `-e` 指定扩展路径入口。不要把 Pi 的这些用法直接照搬到 Uina。

## 2. 最小可运行扩展

在 `<cwd>/.uina/extensions/hello.mjs` 写入以下完整文件：

```js
export default function activate(uina) {
  uina.registerCommand({
    name: "hello",
    description: "显示扩展通知",
    handler() {
      uina.ui.notify("hello 扩展已生效", "info");
    },
  });

  uina.registerTool({
    def: {
      type: "function",
      function: {
        name: "hello_echo",
        description: "返回传入的文本",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    async run(args) {
      return { result: args.text, status: "succeeded" };
    },
  });
}
```

在已有有效模型配置的环境运行 `pnpm start`，输入 `/hello` 验证命令；请模型调用 `hello_echo` 验证工具调用。命令名注册时不带 `/`。命令是用户主动调用的本地动作；工具则进入模型可调用的工具列表。

`uina` 只是参数名，现有示例中叫 `pi`，两者含义相同。默认导出必须是函数，允许异步函数，允许返回同步或异步清理函数。导出函数的名字不要求必须叫 activate。

类型入口为 [ExtensionAPI / ExtensionActivation](../src/extensions/runner.ts)。TS 文件可以使用 type import 获得类型提示；具体相对路径按文件位置计算。当前没有独立发布的扩展 SDK 包，不要凭空导入一个 Uina npm SDK。

## 3. 源码、构建结果和转接入口

- `src` 保存 Uina 源码；`examples` 保存示例源码。
- `pnpm build` 编译到 `dist` 并复制所需资源；不要直接修改构建产物。
- `pnpm start` 通过 tsx 运行源码；`pnpm start:dist` 运行构建后的入口。
- 项目的 `.uina/extensions` 不在当前构建 include 范围内，`pnpm build` 不会自动编译其中所有自定义 TS 插件。

文件事件示例通过 `<cwd>/.uina/extensions/file-events.mjs` 转接到构建结果：

```js
export { default } from "../../dist/examples/file-events.mjs";
```

从入口文件所在目录往上两层是项目根目录，因此本仓库中的绝对目标是 `E:\Uina\Uina\dist\examples\file-events.mjs`。转接文件的位置变了，相对路径也要调整。没有这个入口，示例不会自动启用。

先 `pnpm build`，再按 [文件事件示例说明](../examples/README.md) 设置观察路径并启动。使用 `pnpm start` 也能加载这个转接入口，但其目标仍是 dist；修改示例源码后需要重新构建。

`/reload` 等待主体空闲，然后卸载并重新加载项目扩展；不重新激活内置扩展。当前 loader 只给入口模块增加缓存刷新参数，不保证它间接导入的依赖也被重新加载。修改共享模块或 dist 转接目标后，重启进程最明确。移除入口后执行 `/reload` 或重启即可停用扩展。

## 4. API 速查与消息区别

| API | 用途 |
| --- | --- |
| `id` / `path` | 当前激活来源；项目扩展 ID 带 project 前缀，内置带 builtin 前缀 |
| `registerCommand(command)` | 注册斜杠命令 |
| `registerTool(tool)` | 注册模型工具 |
| `registerProvider(name, provider)` | 交给宿主模型注册入口；不会自动选为当前模型。宿主未提供该入口时抛错，绝不静默丢弃 |
| `on(type, handler)` | 订阅事件或注册变换 hook；返回取消订阅函数 |
| `submitInput(input)` | 递交输入，按主体状态启动处理或排队 |
| `sendMessage(message)` | 追加 custom 消息，参与后续模型上下文；自身不触发新一轮 |
| `appendEntry(entry)` | 追加 custom 条目，用于持久化和展示，不进入模型上下文 |
| `registerMessageRenderer(type, renderer)` | 注册 custom message 的展示方式 |
| `registerEntryRenderer(type, renderer)` | 注册 custom entry 的展示方式 |
| `ui` | 通知、组件、输入与对话框等 UI 接口；`ui.hasUI()` 区分真实交互 UI 与 print 兜底实现 |
| `reportError(error)` | 报告带当前扩展来源的外部异步错误 |

工具名、命令名以及同类 renderer 的 customType 在各自注册表内必须唯一；重名会报错。建议使用能力前缀。Provider 重名处理以 [ModelRegistry](../src/ai/providers.ts) 实现为准，不依赖隐式覆盖来实现切换。

`sendMessage` 使用 `{ customType, content, display?, details? }`。`display:false` 只是隐藏展示，内容仍可进入模型上下文。`appendEntry` 使用 `{ customType, data? }`，不参与模型请求。这两者都不能替代 `submitInput` 的触发语义。宿主缺少对应入口时两者都会抛错，不会静默 no-op。

`ExtensionUIContext` 的成员全部必填：新增成员会同时要求 print 兜底实现、真实 UI 实现与转发层更新，因此不存在“声明了但转发不到”的成员。扩展对 `setStatus`/`setWidget`/`setHeader`/`setFooter` 的重复调用按 key 覆盖（不是追加），激活失效时统一释放。没有真实 UI 时 `hasUI()` 为 false，`select`/`input` 返回 undefined、`confirm` 返回 false——扩展应先用 `hasUI()` 分支，而不是把这些值当成用户选择。

## 5. 工具结果与取消

工具参数使用 OpenAI function 形状的 JSON Schema，注册时由 Ajv 编译，调用前验证。`run(args, signal?, context?)` 返回 `Promise<ToolExecutionResult>`：

```ts
{
  result: string;
  status: "succeeded" | "failed" | "cancelled" | "unknown" | "not_started";
  continuation?: "stop";
}
```

结果内容为字符串；需要结构化内容时显式 JSON.stringify。已执行且成功使用 succeeded，已执行失败使用 failed，确认取消使用 cancelled，无法确定外部结果使用 unknown，尚未执行使用 not_started。不要在 result 字符串写 failed，却在外层状态写 succeeded。旧版只返回字符串的工具需要迁移；tool_result hook 使用 status，不再使用 isError。

将 signal 传给支持取消的网络、进程或其他操作。收到取消请求不等于外部操作已经停止，返回状态必须基于实际结果。可选 `executionMode` 为 parallel/sequential，具体执行由主体调度；串行工具不等于整套扩展新增并发额度。

`continuation:"stop"` 表示记录工具结果后结束当前决策，不清空其他已排队输入，不撤回已生成文字，也不撤销同批已经执行的其他工具。它可以用于“无需对外表达”的明确决定，不能靠隐藏 UI 文字来伪装安静。

合同详见 [Tool / ToolExecutionResult](../src/tools/broker.ts)。

宿主通过第三个参数 `context.ownerId` 提供实际调用主体的身份，内置工具和项目工具共用这个接缝。子代理继承工具实现时使用自己的调用上下文；需要创建或读取主体私有任务的工具应使用该身份，而不是在注册时绑定根主体。已有仅接收 `args` / `signal` 的工具无需改动；直接调用 `tool.run()` 时可显式传入上下文。

## 6. 外部事件如何唤醒主体

以下片段放在激活函数内，创建一个用户可手动触发的事件来源；文件/设备回调可采用相同递交方式：

```js
uina.registerCommand({
  name: "demo-event",
  description: "递交一条外部观察",
  async handler() {
    const { randomUUID } = await import("node:crypto");
    await uina.submitInput({
      id: randomUUID(),
      mode: "followUp",
      source: { kind: "runtime", type: "demo-observation", ref: "manual-demo" },
      text: "观察：本地测试状态发生变化。请用一句话回应。",
      data: { observedAt: Date.now() },
    });
  },
});
```

外部事件使用 `source.kind:"runtime"`，由隐藏的 custom 领域消息保留来源，不伪装成人类发言。`id` 和非空 `text` 当前均为必需；虽然类型中的 text 是可选，运行时会校验。data 使用可序列化数据，持久化数据还应能无损地用 JSON 表达。不要把函数、设备句柄或进程对象放进去。

`steer` 在当前运行的下一次模型请求前处理，`followUp` 排在当前运行之后；它们都不等于立即中断外部工具。空闲时输入可启动处理。submitInput 的 Promise 在忙时可能只等待入队，空闲时可能覆盖本次处理，不能统一解读为“整项活动已完成”或“始终立即返回”。不要在 activation 或正在被主体等待的 hook 中 await 一次会重新进入同一主体的调用。

文件 watcher 等采集回调不应等待完整模型处理；递交后处理 Promise rejection，防止未处理异常。提交失败在现有宿主中会带来源上报；其他自主异步工作的错误使用 reportError。避免在高频采集回调中同步执行长模型请求。

当前 API 没有通用“读取根 JobRegistry”的入口。文件示例创建扩展自己拥有的 JobRegistry 实例，复用现有实现，通过完成通知提交输入，卸载时关闭。这不等于与内置工具共用同一个注册表。具体实现见 [file-events.mts](../examples/file-events.mts)。

## 7. Hook：观察与返回变换

hook 参数是只读快照。需要修改时返回新值，不直接修改 event。不同 hook 的返回形状不同：

| Hook | 可用返回 |
| --- | --- |
| `before_agent_start` | `{ message?, systemPrompt? }`；message 为一条模型消息 |
| `context` | `{ messages }`，替换本次请求上下文 |
| `tool_call` | `{ block:true, reason? }` 阻止本次工具；不返回则继续 |
| `tool_result` | `{ result?, status? }`，显式变换结果 |
| `session_before_compact` | `{ cancel:true }` 取消此次压缩 |
| `before_provider_headers` | `{ headers }`，返回新的请求头 |
| `before_provider_request` | 直接返回新的 payload，不包成 `{ payload }` |

其他事件主要用于观察，如 agent_start/agent_end/agent_settled、turn_start/turn_end、model_select、thinking_level_select、session_compact/session_compact_failed、after_provider_response，以及 output_start/update/end/interrupted。完整字段见 [ExtensionEvent](../src/extensions/host.ts) 和 [RuntimeEvent](../src/runtime/events.ts)。事件名称存在不代表每种输入来源都触发同一个 hook；例如 input 的覆盖范围取决于宿主发出位置，不宜当成统一输入日志替代物。

handler 抛错会报告扩展来源，通常被宿主捕获并继续派发；不能靠 throw 表达阻止工具，应明确返回 block。变换按注册顺序传递，拦截在首个 block/cancel 处短路。监听器会被 await，输出观察事件也按序排队，轮次结算会 flush，因此长任务、整段 TTS 播放不能直接塞进这些等待链。

## 8. Provider 与 UI

Provider 实现 [Provider](../src/core/types.ts)，提供 id、stream(model, req, onDelta, signal)，以及可选的 refreshModels。Model 则是纯数据规格（包含 id、name、providerId、contextWindow、thinkingLevels 等）。stream 发出规范化增量，遵守终止、取消与错误合同；请求带有 providerHooks，网络适配器需按现有 adapter 使用这些接口。未知能力与 usage 字段保持未知，不按名字猜测；若声明某档 thinking，适配器必须真正能表达该控制。需要回放的厂商数据保留 providerReplay，由对应 adapter 解释。

注册 Provider 不等于服务已健康、已完成真实联调或已选为当前模型。类型、返回字段和具体适配过程参考 [providers](../src/ai/providers.ts) 与 [gateway](../src/ai/gateway.ts)，无需为了注册一个 Provider 改 Subject 的厂商分支。

UI 接口包括通知 notify、状态 setStatus、工作提示 setWorkingMessage/setWorkingVisible、widget/header/footer、overlay、编辑器读写、终端输入订阅及 select/confirm/input。组件实现 `render(width): string[]`，每行应遵守字符宽度；renderer 返回组件或 undefined。详见 [ExtensionUIContext](../src/ui/extensions/types.ts) 和 [Component](../src/ui/core/types.ts)。当前公开注册入口是 custom message/entry renderer，没有通用 registerToolRenderer。

无交互 TUI 时使用 print UI：notify 输出文字；select/input 返回 undefined，confirm 返回 false；组件、编辑器和状态栏操作大多不生效。不要将这个 false 误写成“用户明确拒绝”。类型中可选的 gutter 方法当前未由扩展包装接口转发，不作为可依赖 API。

## 9. 清理、错误与内置接入

激活函数返回清理函数，例如 `return async () => { watcher.close(); await jobs.close(); }`。计时器、watcher、订阅外部服务与启动的后台资源由创建它们的扩展释放；自动注销注册项不等于自动杀掉任意扩展资源。

卸载顺序为：标记激活上下文失效 → 调用扩展返回的清理函数 → 逆序清理注册。清理函数应操作自己持有的资源，不再调用 register/send/ui 等需要有效上下文的 API。reportError 仍可报告清理阶段错误。若 activation 尚未返回清理函数就失败，宿主只能清理已登记的注册；扩展要自行在 catch/finally 关闭已创建的外部资源。

宿主自动清理工具、命令、hook、renderer、带归属的状态/widget、header/footer、overlay 与终端输入监听。并非所有 UI 调用都是独立资源：工作提示、编辑器内容等没有通用的自动恢复承诺。旧 activation API 在 reload 后失效，不能保存下来供新实例继续使用。

内置开发者通过 `activateBuiltin("能力名", activateFunction)` 接入；需要服务时，先在组装层构造，再通过闭包传入 activateFunction。示例为 [activateRuntimeTools](../src/extensions/runtime-tools/index.ts)，实际组装见 [CLI](../src/cli/app.ts)。运行内核继续依赖 RuntimeHooks 等窄接口，不导入具体 ExtensionRunner。

自定义嵌入宿主时注意：ExtensionRunnerOptions 的 onProvider、onCustomMessage、onCustomEntry 是可选回调，当前缺少它们时相应 API 可能不执行任何动作；标准 CLI 已接入。submitInput 在缺少 onInput 时则明确抛错。Provider 注销取决于 onProvider 返回的 teardown。不要因为接口调用返回，就宣称嵌入宿主已经接入某项能力。

## 10. 调试与验证

先验证命令注册和工具执行，再验证目标外部行为。文件示例已有 [使用说明](../examples/README.md)；测试入口为 tests/extension-runner.test.ts、tests/file-events.test.ts。真实 Provider 验收脚本是显式调用，不在普通测试中自动访问 API。

文档核对基于当前源码。2026-09-05 已从本文提取完整 hello 示例，通过真实 ExtensionRunner 在临时项目目录验证加载、命令、工具、reload 与 dispose；38 个本地文档链接检查通过，未调用外部 API。这只证明示例与扩展机制的本地组合，不代表任意 Provider、设备或打包依赖已验证。

常见定位顺序：入口是否位于实际 cwd 下 → 文件后缀和 default export 是否正确 → dist 目标是否已构建 → 是否重名 → 是否拿着已失效 API → 是否遗漏异步异常或资源清理。修改共享模块后仍看到旧行为时先重启，不要继续叠加动态加载绕路。
