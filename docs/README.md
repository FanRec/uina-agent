# 文档索引

本文档区分当前事实、待决策提案、外部参考和历史记录。状态以源码、测试和可复现实验为准；提案不会自动授权实现。

## 当前入口

- [当前运行时](current-runtime.md)：唯一的当前实现与验证边界说明。
- [扩展开发指南](extensions-development.md)：现有扩展加载、注册、生命周期和示例。
- [待办与待决策](TODO.md)：未完成修复、需要产品判断的设计问题和待验证风险。

## 提案

- [底座纠偏与下一阶段规划](proposals/foundation-correction-plan.md)
- [Provider 与模型解耦计划](proposals/provider-model-decoupling-plan.md)
- [扩展系统设计](proposals/extensions-design.md)
- [后台任务与子代理设计](proposals/background-and-subagent-design.md)
- [能力组合路线图](proposals/capability-composition-roadmap.md)
- [TUI 设计](proposals/tui-design.md)

提案只记录尚未定案或尚未完成的方向；已经实施的设计稿移入历史审查目录。

## 外部参考

- [Pi UI/扩展参考](references/pi-ui-extension-reference.md)
- [DeepSeek Harness 后台工作参考](references/deepseek-harness-background-work-reference.md)
- [Nott 参考](references/nott-reference.md)

## 历史

历史审查、交付证据和已归档设计位于 [history/](history/)。其中内容解释过去的判断，不代表当前实现。

仓库根目录的 [README.md](../README.md) 是运行与配置入口。
