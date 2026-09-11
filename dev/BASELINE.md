# Uina 开发基线

更新时间：2026-09-11

## 稳定入口

- Node >=22，包管理器 pnpm
- 入口：src/main.ts；组合根：src/cli/app.ts
- 宿主：src/host/host.ts；Agent：src/agent/loop.ts
- Provider：src/ai/；Session：src/session/；Extension：src/extensions/；UI：src/ui/
- Pi 参考：E:/Uina/ThirdParty/pi

## 固定边界

- Host 拥有主体生命周期，不依赖 UI。
- Agent 不依赖 Extension、UI 或具体 Provider wire。
- Session 不依赖 Agent，只恢复有序事实。
- UI 展示和输入，不拥有主体状态转移。
- Extension 不依赖 UI 实现。
- Provider 能力、usage、context、thinking 未知时保持未知。
- 工具结果必须明确为 succeeded、failed、cancelled、unknown 或 not_started。

## 固定命令

pnpm typecheck
pnpm test
pnpm build
pnpm dev:baseline

## 仍需现场核实

真实 Provider、真实 TTY/IME、native helper、跨平台 shell、跨重启 Job/Subagent、长期负载和生产部署。

## 新会话最小探索

1. git status --short；git log -5 --oneline。
2. 读取本文件和 docs/current-runtime.md 相关章节。
3. 只沿任务调用链读取源码，不全仓扫描。
4. 需要 Pi 对照时只读对应 agent、extension 或 provider 入口。
5. 收尾报告代码事实、测试证据、未验证边界和工作树归属。
