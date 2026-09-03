# Pi UI 与扩展边界参考

本文基于 `E:\Uina\ThirdParty\pi` 当前源码整理，作为 Uina 的实现参考，不代表 Uina 已经拥有这些能力。

## 1. TUI 的最小核心

pi-tui 的核心契约是一个很小的组件接口：

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}
```

`Container` 只负责维护子组件并按顺序拼接行。TUI 负责终端 I/O、焦点、覆盖层、渲染调度和差量更新；组件不拥有终端生命周期，也不直接操作 Agent 或 Session。

这形成了清晰的依赖方向：

```text
Agent/Extension -> UI context -> TUI host -> Component
       \\---- session/event data ----/          |
                                               v
                                         string[] frame
```

组件可组合，宿主可替换，扩展不需要知道主屏幕如何绘制。`showOverlay()` 返回的是一个小型 handle，扩展只控制显示、隐藏、聚焦和释放，不接触 overlay 栈内部状态。

## 2. `ctx.ui` 的职责

pi 的 `ExtensionUIContext` 是宿主能力接口，不是 UI 状态容器。主要能力分为几类：

- 用户交互：`select`、`confirm`、`input`、`editor`；
- 非侵入展示：`notify`、`setStatus`、`setWorkingMessage`、`setWidget`、`setHeader`、`setFooter`；
- 可聚焦临时界面：`custom(factory, options)`；
- 输入编辑：`setEditorText`、`getEditorText`、`pasteToEditor`；
- 扩展挂接：终端输入监听、autocomplete 包装、编辑器工厂。

这些方法由不同运行模式分别实现。TUI 模式可以真正显示组件，RPC/print 模式可以返回协议结果或采用无 UI 行为；扩展依赖接口，不依赖具体模式。

## 3. 自定义消息与自定义条目

pi 把两类持久化内容分开：

- `CustomMessage` 有 `customType`、`content`、`display`、`details`，进入 Agent 上下文，也进入会话；
- `CustomEntry` 只用于会话状态和 UI 展示，不进入 LLM 上下文。

扩展通过 `registerMessageRenderer(customType, renderer)` 和 `registerEntryRenderer(customType, renderer)` 注册渲染器。渲染器返回普通 TUI `Component`，因此自定义内容不会反向污染 TUI 核心。

默认渲染器仍存在，但它是显示层的缺省策略，不是扩展协议的隐藏修复路径。渲染器异常应在 UI 中可见，不能伪造扩展成功。

## 4. 扩展生命周期

扩展注册阶段只声明 command、tool、renderer、widget 等能力；宿主在绑定核心动作后再提供 `sendMessage`、`sendUserMessage`、`appendEntry` 等运行时操作。扩展上下文带有 active/invalidate 语义，reload 后旧扩展实例不能继续修改新运行时。

这保持了三个边界：

1. 核心拥有会话、队列、模型调用、持久化和副作用事实；
2. 扩展拥有能力实现和自己的数据；
3. TUI 拥有渲染、焦点和交互呈现。

## 5. 对 Uina 的结论

当前 Uina 已有可复用的工具注册和 Job 生命周期，但没有通用 ExtensionHost、`ctx.ui` 或自定义消息协议。`src/ui_new` 的组件接口可作为实验材料，但它目前未接入真实 CLI，而且 `UinaTUI` 仍是一个较大的控制器门面。

下一步若实现 UI 扩展，应先只落一个可验证切片：`Component`、`Container`、两个 widget 槽位、一个 `customType` 消息及其 renderer，并从真实 CLI 入口走通。不要先复制 pi 的完整 session tree、主题系统、图片协议或全部组件。
