# 提案与工作材料索引

这里保留仍有当前参考价值的合同、部分实施设计和未决方案。文档位置不表示实现状态，也不授权施工；以当前源码和 `docs/current-runtime.md` 为准。已被取代的计划与历史报告见[归档提案导航](../archive/proposals/README.md)。

## 模块索引

- [QQ World](qq/README.md)：当前动作表面、通知设计记录与发现资源设计；旧合同已归档。
- [Live2D](live2d/README.md)：当前边界、曲线创作、尚存计划及视觉验收边界。
- [具身系统](embodiment/README.md)：直接链接 Voice 与 Live2D 当前合同；旧架构审查已归档。
- [Minecraft World](mc/README.md)：终态概要、跨模块行为与公开接口草案、参考项目证据与验证场景；尚未实现或经过游戏验收。

## 当前规范与实施记录

- [Subject Runtime 执行规格](subject-runtime-plan.md)：项目唯一的当前施工规格；已完成阶段在文内标记。
- [Subject Runtime 决策档案](subject-runtime-decisions.md)：非规范历史记录；`AGENTS.md` 保留此固定路径。
- [外部事件帧设计](runtime/external-event-frame-design.md)：已实施的投影合同；真实模型认知收益未验证。
- [MCP 扩展设计](integrations/mcp/mcp-extension-design.md)：P0 代码实现与未验证的远端/进程边界。
- [Screen MCP 设计](integrations/mcp/screen-mcp-design.md)：本地代码切片已存在；真实桌面和 Provider 门仍待验收。
- [上下文检视器设计](ui/context-inspector-design.md)：已实现的较窄提示词卡片与 `/prompt` 记录。
- [Voice 架构](voice/voice-architecture.md)：部分实现状态与真实声音验收边界。
- [实时字幕服务设计](voice/realtime-subtitle-service-design.md)：服务与伴生管理已实现；typewriter 的近似语义仍待裁决。
- [网易云点歌 World / HUD](worlds/netease-jukebox/netease-jukebox-hud-migration-design.md)：本地组合已存在，真实账号和直播链路未验收。
- [托管服务设计](runtime/managed-services-design.md)：共享 ServiceManager 尚未实施，须先过 M0 证据门。

## 待决策或未完成的设计

- [Live2D 程序化动画作者层重设计](live2d/live2d-animation-authoring-redesign.md)：Timeline 与已确认 A2 决策冲突，仍是未授权提案。
- [Live2D Cue 链路修复计划](live2d/live2d-cue-action-repair-plan.md)：parser 生命周期与结果语义边界见文首复核。

当前运行事实：[current-runtime.md](../current-runtime.md)。归档原因、当前依据和保留的历史证据：[归档提案导航](../archive/proposals/README.md)。
