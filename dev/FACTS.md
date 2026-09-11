# Uina 稳定事实索引

更新时间：2026-09-11

这里记录低漂移、但新会话通常需要重新探索才能确认的事实。代码变更后如果这些事实变化，应同步修改本文件；它不是权威实现，源码和可执行检查优先。

## 入口与装配

- 进程入口：src/main.ts
- CLI 组合根：src/cli/app.ts
- 主体生命周期所有者：src/host/host.ts
- 前台执行循环：src/agent/loop.ts
- Provider 配置和协议：src/ai/
- 会话恢复和 JSONL：src/session/
- 工具执行端口：src/tools/broker.ts
- 扩展加载和 scope：src/extensions/runner.ts
- UI 消费者：src/ui/

## 可执行门

- 类型和边界：pnpm typecheck
- 测试：pnpm test
- 构建和 native asset：pnpm build
- CLI 本地协议验证：pnpm verify:cli
- 文件事件扩展验证：pnpm verify:file-events
- 快速基线：pnpm dev:baseline -- --quick
- 完整基线：pnpm dev:baseline

## 结构性不变量

- host 不导入 UI；boundary script 会检查。
- session 不导入 agent；boundary script 会检查。
- agent/core/session/tools 不依赖 extensions。
- UI 不拥有 Subject 的生命周期和权威状态。
- 扩展能力通过 ActivationScope 注册并释放。
- Provider 能力和 usage 未知时不能由 UI 或配置猜测填充。
- 外部副作用没有确认结果时只能是 unknown。

## Pi 对照入口

- 低层 Agent：E:/Uina/ThirdParty/pi/packages/agent/src/agent.ts
- Agent loop：E:/Uina/ThirdParty/pi/packages/agent/src/agent-loop.ts
- 扩展示例：E:/Uina/ThirdParty/pi/packages/coding-agent/examples/extensions/
- Provider/Model：E:/Uina/ThirdParty/pi/packages/ai/src/

只在任务涉及对应职责时读取对应入口，不做全 Pi 扫描。

## 当前未证明

真实第三方 Provider、真实 TTY/IME、ARM native helper、跨平台 shell、跨重启后台工作、长期负载、生产部署。
