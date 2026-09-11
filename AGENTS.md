# AGENTS.md

## 项目定位

Uina 是运行在本机的最小 Agent Runtime，长期目标是开放式数字主体。当前实现优先由真实代码、可运行行为和可验证约束驱动，不把长期愿景当作当前需求。
Core 提供运行机制、生命周期、协议和最小能力端口；Extension 提供能力和策略；Host 拥有主体生命周期；UI 负责展示、输入和焦点。

## 开始前必须读取

1. `dev/FACTS.md`：稳定事实、入口、固定命令和 Pi 对照位置。
2. `dev/DECISIONS.md`：启动方式、配置、数据目录和预先确定的开发约定。
3. `dev/BASELINE.md`：边界和未验证项。
4. 任务涉及的 `docs/current-runtime.md` 相关章节。

文档与源码冲突时，以当前源码和可运行验证为准。不要因为历史文档声称已完成就跳过代码核实。

## 代码地图

```text
src/
  main.ts                         进程入口
  cli/app.ts                      组合根、消费者接入、信号和退出
  host/host.ts                    主体生命周期、依赖装配、输入和事件流
  host/events.ts                  Host 对外事件类型
  agent/loop.ts                   Subject、前台回合、队列、工具回注、取消
  agent/context.ts                模型上下文投影和 token 估算
  agent/compaction.ts             压缩决策和保留尾
  agent/queue.ts                  steer/followUp 输入队列
  agent/runtime.ts                AgentHandle 和 AgentFactory
  ai/config.ts                   Provider 配置、认证和事实校验
  ai/providers.ts                Anthropic/Gemini/模型目录等 Provider
  ai/gateway.ts                  OpenAI-compatible wire 和重试
  ai/sse.ts                      SSE 解析和协议错误
  core/types.ts                  跨层领域类型和 Provider 合同
  session/types.ts               会话记录、输入和存储合同
  session/jsonl-store.ts         JSONL 写入、flush、恢复入口
  session/recovery.ts            有序记录恢复和未完成工具结算
  tools/broker.ts                工具注册、schema 校验和执行
  extensions/runner.ts           Extension 加载、ActivationScope、teardown
  extensions/host.ts             Runtime hook/event 分发
  extensions/runtime-tools/      shell、时间、Job/Subagent 内置能力
  extensions/jobs/               后台 Job 生命周期和输出
  extensions/subagents/          子 Agent 生命周期和输出
  ui/                            TUI、渲染、输入和消费者适配
  runtime/                       RuntimeHooks 合同、guard 和 no-op
scripts/                         边界检查、构建资源、CLI/扩展验证
tests/                           单元、组合、协议、生命周期和 UI 测试
docs/current-runtime.md          当前运行事实
docs/proposals/                  尚未实现的设计规划
docs/history/                    历史审查和证据
dev/                             开发代理基线、决策、流程和自动化
```

## 稳定边界

- `host/` 不依赖任何 UI 模块。
- `session/` 不依赖 `agent/`。
- `agent/`、`core/`、`session/`、`tools/` 不依赖 `extensions/`。
- `extensions/` 不依赖 UI 实现，只能使用公开 UI contract 或 `ui/core`。
- UI 不拥有 Subject、SessionStore、Provider 或 Job/Subagent 的权威状态。
- Provider 能力、usage、context window 和 thinking levels 未知时保持未知。
- 工具结果必须区分 `succeeded`、`failed`、`cancelled`、`unknown`、`not_started`。
- 外部副作用未确认时不得推断成功。
- 本地扩展默认受信任，不凭空增加权限、轮次、并发或容量限制。

## 固定命令

```text
pnpm start                         源码开发运行
pnpm dev                           tsx watch 开发运行
pnpm typecheck                    类型检查和边界检查
pnpm test                         全量测试
pnpm build                        构建 dist 和 native asset
pnpm dev:baseline -- --quick      快速开发基线
pnpm dev:baseline                 完整开发基线
pnpm verify:cli                   编译 CLI 验证
pnpm verify:file-events           文件事件扩展验证
```

## 工作规则

- 修改前先检查 `git status --short`，保留用户已有修改。
- 先沿真实调用链定位根因，再决定 Core、Host、Extension 或 UI 归属。
- 优先复用现有扩展接缝；只有证明不足时才增加通用 Core 接口。
- 不把 mock、localhost、历史日志当作真实 Provider、TTY 或生产证据。
- 不为保持错误边界增加兼容层；无效或未接线机制应删除或明确失败。
- 收尾报告源码事实、测试边界、未验证项和工作树归属。

## Pi 对照

Pi 位于 `E:/Uina/ThirdParty/pi`。涉及 Pi 的结论必须检查实际源码，优先入口：
`packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts`、`packages/coding-agent/examples/extensions/`、`packages/ai/src/`。

## 修改范围

除非用户明确要求，不修改 `E:/Uina/ThirdParty/pi`，不修改真实 Provider 配置、真实会话或用户认证。
