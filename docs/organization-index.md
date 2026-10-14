# 文档目录整理清单

本文是本地工作台文档的导航与整理记录。此前经用户裁决，6 份文档已归档，1 份完全重复的文档已删除。本轮逐篇审阅的状态、证据和正文变更见[审阅台账](document-audit-register.md)。

## 目录分区

| 位置 | 用途 | 阅读提示 |
| --- | --- | --- |
| `docs/` 根目录 | 当前运行事实、全局指南、入口与审阅台账 | 从 [current-runtime.md](current-runtime.md) 开始；QQ、Live2D、Voice/TTS 专题正文分别见下方主题目录。 |
| `docs/qq/` | QQ 验收与发现动作审查 | [QQ World 文档索引](qq/README.md)；旧路径保留迁移提示以兼容历史引用。 |
| `docs/live2d/` | Live2D World 当前运行合同 | [Live2D 文档索引](live2d/README.md)；设计/计划见 `proposals/live2d/`。 |
| `docs/voice-tts/` | Voice/TTS 运行合同、文件生成与验证记录 | [Voice/TTS 文档索引](voice-tts/README.md)；设计见 `proposals/`。 |
| `docs/proposals/` | 当前合同、部分实施记录和待决策方案 | 导航见 [proposals/INDEX.md](proposals/INDEX.md)；已替代计划与历史材料见 `docs/archive/` 下的专题归档索引。 |
| `docs/history/` | 已完成审查、旧设计和历史证据 | 历史记录解释当时的判断，不自动代表当前实现。 |
| `docs/history/results/` | 历史测试和审查的 JSON 结果快照 | 仅收纳结果数据；执行脚本和测试配置仍留在原路径，以免相对导入或配置路径失效。 |
| `docs/archive/` | 已完成或被替代的工作计划、旧接口和历史证据 | 保留原文追溯设计与当时结果，不作为当前实施合同；各专题索引注明后续依据。 |
| `docs/references/` | 外部项目和资料参考 | 用于背景对照，不是 Uina 当前实现合同。 |
| `docs/superpowers/` | 按流程整理的计划与规格 | `plans/` 与 `specs/` 已分开，保持原样。 |

## 本轮裁决结果

以下文档已移至 [archive/](archive/README.md)，归档分类依据其自身的状态声明，没有重新核对源码、测试或外部验收：

- `core-austerity-plan.md`、`deep-module-refactor-plan.md`、`ui-crap-debt-plan.md`：文档头部声明计划已完成。
- `live2d-rebuild-plan.md`、`live2d-rebuild-checklist.md`：文档头部将其标为早期重写档案，并指向后续计划和运行合同。
- `tts-voice-natural-interaction-design.md`：声明旧方案已被当前 Voice/TTS 合同替代。

`tts-voice-llm-delivery-design.md` 已按用户指示删除。删除前与保留的 `tts-voice-natural-interaction-design.md` SHA-256 相同，确认两份文件逐字节相同。

本轮将 9 篇已被 QQ v3 运行事实取代的旧合同、实施计划和历史证据移入 [`archive/qq/`](archive/qq/README.md)。其中一次真实媒体验收仅作为其原日期/范围的历史证据保留；各篇后续依据见归档导航和[逐篇审阅台账](document-audit-register.md)。

同一轮还将 21 篇已完成、已撤回或被现行规格取代的 Runtime、Cognition、扩展、UI、Embodiment 与 Live2D 计划移入 [`archive/proposals/`](archive/proposals/README.md)。未完成且仍有明确问题的方案继续留在 `proposals/`，索引会标出未决状态。

本次继续把 7 篇根目录专题正文移入 `qq/`、`live2d/`、`voice-tts/`，将 8 篇跨模块提案归入 `proposals/runtime/`、`ui/`、`integrations/mcp/`、`voice/` 和 `worlds/netease-jukebox/`。`subject-runtime-plan.md` 与 `subject-runtime-decisions.md` 按项目约定保留原路径；旧根路径只留短跳转提示。

此前经用户裁决归档的 6 篇文档正文没有改动；本轮归档材料保留主体历史内容，补充状态/替代提示并修复移动造成的相对链接。归档导航分别见 [archive/README.md](archive/README.md)、[QQ 归档](archive/qq/README.md) 和[提案归档](archive/proposals/README.md)。

## 根目录与专题目录

- QQ、Live2D、Voice/TTS 专题内容分别收纳在 `docs/qq/`、`docs/live2d/`、`docs/voice-tts/`；各 README 是专题入口。
- 根目录旧文件名保留短迁移提示，供既有历史链接跳转；现行正文只维护在专题目录。
- 仍在活动提案目录中的文件按当前合同、部分实现记录和待决策方向分组；没有仅凭状态标题归档。结论与引用关系见[审阅台账](document-audit-register.md)和[提案索引](proposals/INDEX.md)。
- `current-runtime.md` 中 2026-10-10 的 Live2D 旧实施记录已移至[归档说明](archive/live2d-legacy-implementation-notes-2026-10-10.md)；当前合同单独位于 `docs/live2d/`。
- 旧 `TODO.md` 正文已迁入 `archive/TODO-2026-09-11.md`，根目录只保留链接兼容提示。
- `docs/history/` 中的探针脚本和 Vitest 配置依赖原目录位置，因此没有移动；JSON 结果已单独归入 `history/results/`。

## 后续整理边界

逐篇审阅台账用于跟踪剩余复核、正文修订和归档候选。历史目录中的材料只作为背景证据，不因本轮活动文档审阅而改写。
