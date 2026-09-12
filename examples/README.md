# 文件事件扩展

扩展入口与 API 的通用说明见 [扩展开发指南](../docs/extensions-development.md)。

`file-events.mts` 是普通项目扩展：观察文件、提交带来源的输入、注册后台命令与即时输出读取，并允许模型明确选择安静。它使用现有 JobRegistry，不引入独立宿主或事件总线。

先执行 `pnpm build`。在项目 `.uina/extensions/file-events.mjs` 中写入：

```js
export { default } from "../../dist/examples/file-events.mjs";
```

创建一份用于观察的文本文件，在启动 Uina 的 PowerShell 中设置其绝对路径：

```powershell
$env:UINA_WATCH_FILE = 'E:\Uina\Uina\observation.txt'
pnpm start:dist
```

修改该文件后，Uina 收到 `file-changed` 事件。事件作为隐藏的 custom 会话消息保留来源，不显示成人类发言。是否执行命令、读取结果或对外表达由模型决定；文件内容不是固定命令脚本。

`watch_exec` 的长命令使用后台模式，`watch_job_output` 只读即时快照，完成事件再触发后续读取。`watch_silence` 返回 `continuation: "stop"`，记录工具结果后结束当前决策；它不会撤回已经输出的文字。无需表达时，应直接选择该工具。

`/watch-stop` 停止观察并请求取消本扩展的工作，等待 Job producer 的实际结论。重新加载扩展可恢复观察；正常卸载使用同一清理路径。不合作的 producer 不会因等待时间长而被伪记为已停止。

离线验收使用真实文件、PowerShell 子进程、临时 JSONL 和确定性 Provider：

```powershell
pnpm exec vitest run tests/file-events.test.ts
```

真实模型验收会读取现有默认 Provider 配置并产生少量 API 用量，所有文件和进程工作都位于独立临时目录：

```powershell
pnpm exec tsx scripts/verify-file-events.mts
```

脚本当前按已验证的 DeepSeek v4 Flash、`off` 档和 Windows shell 场景编写，不代表任意模型都能可靠执行这一行为。真实结果与延迟见 [交付记录](../docs/history/reviews/2026-09-05-plan-delivery.md)。示例不会由安装或构建自动启用。

## 可组合扩展示例

- `pnpm start -e examples/extensions/workspace-tools`：文件读写、图片读取、工具自定义展示。
- 再加 `-e examples/extensions/skills`：发现 `.uina/skills/*.md` 或子目录 `SKILL.md`，通过服务与文件工具组合。
- `-e examples/extensions/custom-compaction`：以公共模型接口替换压缩生成。

示例均为可选本地扩展；图片请求需要模型明确声明 `imageInput: true`。契约、取舍和验证边界见 [扩展设计](../docs/extensions.md)。
