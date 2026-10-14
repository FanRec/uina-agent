# QQ World 归档文档导航

以下 9 篇文档从 `docs/proposals/qq/` 移入归档，保留其历史内容与证据。它们包含旧通知模型、旧工具表面、阶段计划或一次性媒体验证，不再充当当前合同。归档时补充当前状态提示并修复移动后失效的相对链接，没有按当前行为重写历史主体。

当前实现和验收入口：

- [当前运行事实中的 QQ World](../../current-runtime.md#qq-world)
- [QQ World 验收记录](../../qq/qq-world-acceptance.md)
- [当前工具 schema](../../../.uina/worlds/qq/tool.json)
- [当前 QQ 提案索引](../../proposals/qq/README.md)

| 归档材料 | 归档原因 | 后续依据 |
| --- | --- | --- |
| [阅读与通知设计（2026-10-09）](qq-reader-notification-design-2026-10-09.md) | 旧双轨、digest/follow 和 focus/mode 合同已被 v3 单书签语义替代 | [当前运行事实](../../current-runtime.md#qq-world)、[v3 设计记录](../../proposals/qq/qq-push-single-rail-proposal-2026-10-11.md) |
| [阅读与通知开发计划（2026-10-11）](qq-reader-notification-devplan-2026-10-11.md) | 历史实施过程；内部任务状态互相矛盾，不再是执行清单 | [QQ 验收记录](../../qq/qq-world-acceptance.md) |
| [QQ World 开发指南](qq-world-development-guide.md) | 旧动作名称和旧 Attention/消费模型已不能指导当前实现 | [当前运行事实](../../current-runtime.md#qq-world)、[QQ 验收记录](../../qq/qq-world-acceptance.md) |
| [QQ World 实施计划](qq-world-implementation-plan.md) | P0–P9 与九动作阶段已被当前 14 动作实现取代；保留其中的当时验收记录 | [当前运行事实](../../current-runtime.md#qq-world)、[QQ 验收记录](../../qq/qq-world-acceptance.md)、[P7 历史媒体证据](qq-world-p7-media-evidence.md) |
| [QQ World 接口（旧版）](qq-world-interface.md) | `observe/speak/gesture/attention/follow_up/account` 表面已退役 | [当前工具 schema](../../../.uina/worlds/qq/tool.json)、[当前运行事实](../../current-runtime.md#qq-world) |
| [LLM 接口 v2（2026-10-08）](qq-world-llm-interface-v2-2026-10-08.md) | 六动作与旧参数规则已被当前 schema 取代 | [当前工具 schema](../../../.uina/worlds/qq/tool.json)、[QQ 验收记录](../../qq/qq-world-acceptance.md) |
| [LLM 呈现清点](qq-world-llm-rendering-inventory.md) | 旧六动作与 observe scope 的静态模板表已过时 | [当前 QQ 源码](../../../.uina/worlds/qq/src/render.ts)、[QQ 验收记录](../../qq/qq-world-acceptance.md) |
| [LLM 视图审查（2026-10-08）](qq-world-llm-view-review-2026-10-08.md) | 建议已部分被后续 renderer 实现吸收；其余模型理解质量未由真实模型验证 | [当前运行事实](../../current-runtime.md#qq-world)、[QQ 验收记录](../../qq/qq-world-acceptance.md) |
| [P7 媒体证据](qq-world-p7-media-evidence.md) | 保留一次真实媒体发送记录；只代表记录中的日期、目标和媒体类型，不代表当前可复测 | [QQ 验收记录](../../qq/qq-world-acceptance.md) |

归档记录不等于删除。历史实测可以说明当时发生过的行为，但不能外推到当前 QQ 连接、其他媒体类型、对端呈现或真实模型理解。
