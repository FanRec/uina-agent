# Uina 最小开发流程

这不是必须逐条执行的仪式，只是新会话的默认快路径。

## 开始

1. 读 dev/FACTS.md。
2. 执行 git status --short。
3. 运行 pnpm dev:baseline -- --quick。
4. 只沿当前任务的真实调用链读取源码；不做无关全仓探索。

## 判断

- 先确认当前代码和可运行行为，再参考文档。
- 文档与代码冲突时，以代码和验证结果为准。
- Pi 只在对应职责需要时对照实际源码。
- 只为真实不变量增加 Core 机制；优先复用现有 Extension 接缝。

## 收尾

按风险选择最小验证：

- 普通局部改动：typecheck + 相关测试。
- 共享运行时、Provider、Session、生命周期改动：typecheck + 全量 test + build。
- CLI/扩展/协议改动：再运行对应 verify 脚本。

最后运行 git diff --check，并报告源码事实、测试边界、未验证依赖和工作树归属。
