# 已替代提案与实施记录

以下文档从 `docs/proposals/` 移入归档，保留其设计理由、实施过程和历史证据。原有阶段清单或接口描述已被当前源码、运行合同或后续计划取代；归档材料不作为施工授权。归档时保留主体历史内容，补充状态/替代提示，并修复移动造成的相对链接。

## Runtime、扩展与历史审查

| 文档 | 归档依据 | 当前依据 |
| --- | --- | --- |
| [Subject Runtime 接缝清点](seams-inventory.md) | 2026-09-18 的阶段审计含已移除能力的旧状态，不再是现行接口清单 | [Subject Runtime 计划](../../proposals/subject-runtime-plan.md)、当前源码与 [current-runtime](../../current-runtime.md) |
| [会话回溯提取计划](rewind-extraction.md) | P5 提取工作已完成 | [会话主线与回溯](../../session-rewind.md) |
| [底座纠偏计划](foundation-correction-plan.md) | S1–S4 计划已落地，部分历史交付记录与审查报告重复 | [current-runtime](../../current-runtime.md)、[历史交付审查](../../history/reviews/2026-09-05-plan-delivery.md) |
| [生命周期资源范围计划](lifecycle-resource-scope-plan.md) | 停用与回滚顺序已由 WorldActivation/ResourceScope 实现 | [World 开发指南](../../app-development.md)及当前生命周期源码 |
| [外部事件帧实施计划](external-event-frame-plan.md) | 计划目标已由相邻设计与当前源码实现 | [外部事件帧设计](../../proposals/runtime/external-event-frame-design.md) |
| [Provider 与模型解耦计划](provider-model-decoupling-plan.md) | Provider/Model 分离与目录已实现；旧基线陈述过时 | [当前运行事实](../../current-runtime.md#模型事实) |
| [早期扩展设计](extensions-design.md) | 旧事件词表及把语音事实放入 Core 的方案与当前边界不符 | [扩展契约](../../extensions.md)、[扩展开发指南](../../extensions-development.md) |
| [能力组合路线图](capability-composition-roadmap.md) | 多个接缝已实现；Jobs/Subagents 路线的对象已从运行时移除 | [当前运行事实](../../current-runtime.md)、[扩展契约](../../extensions.md) |
| [后台任务与子代理设计](background-and-subagent-design.md) | 文档声称存在的 Job/Subagent 当前已移除，正文状态还互相矛盾 | [当前运行事实](../../current-runtime.md#活动与文件事件扩展) |
| [认知扩展设计](cognition-extension-design.md) | Cognition 扩展已从当前运行时移除；Profile 基础设施仍单独存在 | [当前运行事实](../../current-runtime.md#活动与文件事件扩展)、`src/host/profile.ts` |
| [认知扩展计划](cognition-extension-plan.md) | 记录的是已执行后撤回的旧阶段，不能从阶段 A 继续施工 | 同上 |
| [认知实施笔记](cognition-implementation-notes.md) | A–E 历史交付记录不表示记忆扩展仍在当前运行时 | Profile 当前实现与 [current-runtime](../../current-runtime.md) |
| [Screen MCP 开发指南](screen-mcp-development-guide.md) | 旧计划指向不存在的 `packages/screen-mcp`；实际包已位于 `.uina/mcp-servers/screen-mcp` | [Screen MCP 设计与实现状态](../../proposals/integrations/mcp/screen-mcp-design.md)、[状态文件](../../../.uina/mcp-servers/screen-mcp/IMPLEMENTATION_STATUS.md) |
| [TTS 扩展设计](tts-extension-design.md) | 工具面、语音过滤和断点规则已被当前 Voice/TTS 合同替代 | [Voice/TTS 当前合同](../../voice-tts/voice-tts-runtime.md)、[Voice 架构](../../proposals/voice/voice-architecture.md) |
| [旧 TUI 设计](tui-design.md) | 组件 topology、路径和验收数字与现行 UI 不符 | [当前运行事实](../../current-runtime.md#tui-消费者与扩展接缝) |

## Embodiment 与 Live2D

| 文档 | 归档依据 | 当前依据 |
| --- | --- | --- |
| [具身架构 v3.5](embodiment-architecture.md) | 旧 BodyEndpoint 合同缺少当前 resume/interrupt/cue 能力 | [World 开发指南](../../app-development.md)、[Live2D 合同](../../live2d/live2d-world-runtime.md)、[Voice/TTS 合同](../../voice-tts/voice-tts-runtime.md) |
| [Voice/Live2D 审查快照](embodiment-voice-live2d-audit.md) | 旧测试布局与行号过时；S1/S5/S6 已改变，ASR/VAD 仍未实现 | [Voice/TTS 合同](../../voice-tts/voice-tts-runtime.md)、[Live2D 合同](../../live2d/live2d-world-runtime.md) |
| [Voice/Live2D 后续步骤日志](embodiment-voice-live2d-next-steps.md) | 未执行标题与正文已完成记录矛盾，且重复完成报告 | 同上 |
| [Voice/Live2D 重构计划](embodiment-voice-live2d-refactor-plan.md) | 方案的主要接线已存在于当前源码 | 同上 |
| [Voice/Live2D 重构报告](embodiment-voice-live2d-refactor-report.md) | “未提交”及未完成清单是阶段状态快照，不能代表当前状态 | 同上 |
| [旧 Live2D 引擎重构计划](live2d-engine-refactor-plan.md) | 旧 sequence/parallel 动作树已被函数曲线与 MotionPlan 取代 | [曲线创作设计](../../proposals/live2d/live2d-curve-authoring-design.md)、[Live2D 合同](../../live2d/live2d-world-runtime.md) |

本轮未运行这些归档文件提及的旧测试命令。引用的现存测试路径只证明测试文件存在；真实 Provider、桌面、VTS、OBS、声卡和模型视觉效果仍按各自当前合同标为未验证。
