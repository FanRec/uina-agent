# 文档索引

本文档区分当前事实、待决策提案、外部参考和历史记录。状态以源码、测试和可复现实验为准；提案不会自动授权实现。

## 当前入口

- [会话主线与回溯](session-rewind.md)：单主线、只读历史、安全点与阶段验收。
- [当前运行时](current-runtime.md)：唯一的当前实现与验证边界说明。
- [扩展开发指南](extensions-development.md)：现有扩展加载、注册、生命周期和示例。
- [World 开发指南](app-development.md)：World 契约、生命周期、工具动作、查询和主动事件。
- [待办与待决策（2026-09-11 历史快照）](archive/TODO-2026-09-11.md)：当时的修复线索、设计问题与验证风险；不是当前确认过的待办。
- [扩展契约与组合设计](extensions.md)：已实现接口、所有权、取舍与可运行示例。
- [目录整理记录](organization-index.md)：目录分区、此前归档决定与本轮审阅入口。
- [逐篇审阅台账](document-audit-register.md)：活动文档的当前状态、证据和处置记录。

## 专题目录

- [QQ World](qq/README.md)：验收记录与发现动作审查。
- [Live2D](live2d/README.md)：当前运行合同与视觉验收边界。
- [Voice / TTS](voice-tts/README.md)：运行合同、文件生成和验证记录。

## 提案

- [按主题浏览提案与工作材料](proposals/INDEX.md)：QQ、Live2D、具身系统及其他主题索引。
- [Subject Runtime 当前施工规格](proposals/subject-runtime-plan.md)：唯一当前重构规格。

提案区包含设计、计划、实施过程和历史审查材料，状态并不统一；部分文档记录已实现内容或混合状态。按主题导航见提案索引，具体事实以当前运行文档和源码为准，不按文件夹位置推断实现状态。

根目录的 `TODO.md` 是兼容旧引用的迁移提示；当前待办不能直接从这份 2026-09-11 历史快照推断。

## 外部参考

- [Pi UI/扩展参考](references/pi-ui-extension-reference.md)
- [DeepSeek Harness 后台工作参考](references/deepseek-harness-background-work-reference.md)
- [Nott 参考](references/nott-reference.md)

## 历史

历史审查、交付证据和已归档设计位于 [history/](history/)。其中内容解释过去的判断，不代表当前实现。

仓库根目录的 [README.md](../README.md) 是运行与配置入口。
