# 活动文档逐篇审阅台账

范围：原 `docs/` 根目录、`proposals/`、`superpowers/` 的 74 篇 Markdown。既有 `archive/`、`history/`、`references/` 只读；本轮移入归档的文件仍计入原始基线，归档时仅修复必要的相对链接。

状态：`未审`、`阅读中`、`待核源`、`完成`、`已修订`、`已归档`、`归档候选`、`待裁决`。完成表示已读全文、已核查适用的仓库内实现/测试证据，并作出处置；外部行为仍按未验证标记。

覆盖基线：复核实际目录后为 74 篇 Markdown（计划预估 73，初次建表漏列 `live2d-animation-authoring-redesign.md`，已补入）。归档移动不减少本次审阅基线；此台账、本轮新增的专题 README、旧路径迁移提示和归档导航不计入基线。

| 文档 | 状态 | 当前用途 | 当前结论 | 源码或测试证据 | 处置 |
| --- | --- | --- | --- | --- | --- |
| `docs/README.md` | 已修订 | 文档导航 | 原提案分类规则不符合当前提案区包含实施记录、混合状态文档的事实 | 文档路径与现有目录核对 | 改为按主题索引与当前源码核实；标记 TODO 是 2026-09-11 快照并链接本台账 |
| `docs/archive/TODO-2026-09-11.md` | 已归档 | 2026-09-11 代码审查/规划快照，不作为当前 backlog | 条目包含当时决策理由、验证边界和实现线索；清单未整体按当前 checkout 重验，不能把旧勾选状态当现状 | 与 current-runtime 的当前事实和删除的 Job/Subagent/Cognition 状态交叉核对；逐项未重建当前待办 | 从根目录移入归档；`docs/TODO.md` 只保留旧链接迁移提示 |
| `docs/app-development.md` | 已修订 | World 加载、事件和持久化指南 | world-store 路径已区分 subject.stateRoot 与 cwd fallback | world-registry.ts、World lifecycle/seam/loader 27 项通过 | 已更正路径事实 |
| `docs/current-runtime.md` | 已修订 | 当前运行事实总览，含 Live2D/QQ 状态、屏幕观察与历史边界 | 已更正 sway 短句合同、read 与响铃窗口区别；旧 Live2D 段移出；当前记录标明测试快照边界，补充 Screen MCP/字幕的真实验收限制 | Live2D 源码/typecheck/MO 目录测试；QQ 24 文件/420 项；本轮 typecheck 通过；Screen MCP/字幕为静态源码核查 | 保留当前合同，历史记录按日期理解 |
| `docs/extensions-development.md` | 已修订 | 当前扩展开发指南 | 扩展 API、注册替换、服务/share、消息、hook、加载与文件工具边界符合当前公开类型和实现；更正了截断读取说明 | `runner.ts`、`host.ts`、`runtime/hooks.ts`、workspace-tools；extension composition 定向测试通过 | 保留；配合 current-runtime 阅读 |
| `docs/extensions.md` | 已修订 | 扩展契约与组合设计，含历史验证记录 | ResourceScope、服务/share 分工、上下文链、compaction、图片与展示合同与源码一致；旧测试/build/CLI 数字没有当前源码基线 | `runner.ts`、`host.ts`、`runtime/hooks.ts`、`lifecycle-scope.ts`、extension composition/image-content tests | 保留；补充历史验证快照边界 |
| `docs/live2d/live2d-world-runtime.md` | 已修订 | Live2D 当前运行合同与曲线创作状态 | 更正 sway 是有限振荡短句而非闭合周期；准确区分 idle/thinking 闭合周期、sway 四段短句；设备自然度未验证 | runtime.ts、authoring/motion.ts、MO catalog；pnpm typecheck 通过；live2d-mo-catalog 6 项通过 | 移入 Live2D 专题目录；根旧路径保留迁移提示 |
| `docs/organization-index.md` | 已修订 | 本地工作台目录、此前裁决和归档导航 | 原“正文未改写/本轮不改正文/Live2D 旧资料待核”描述已随本轮更正 | 当前链接与新增归档说明 | 增加审阅台账入口并更新实际处置 |
| `docs/proposals/INDEX.md` | 已修订 | 活动提案状态索引 | 移除已替代计划，按当前规范、实现记录、未决方案和归档导航分组 | 活动目录、模块 README、归档索引逐链核对 | 保留并作为提案唯一导航入口 |
| `docs/archive/proposals/background-and-subagent-design.md` | 已归档 | Jobs/Subagent 旧设计 | 相关目录已于 2026-10-06 从当前运行时移除；原文状态互相矛盾 | `docs/current-runtime.md`；对应源码目录不存在 | 移入归档并说明已移除；重启需重做设计 |
| `docs/archive/proposals/capability-composition-roadmap.md` | 已归档 | 旧能力组合路线图 | 部分接缝已实现；Capability View 未实现；Jobs/Subagents 路线对象已移除 | `src/extensions/runner.ts`、`extensions.md`、current-runtime | 保留历史，作为未来规划不授权 |
| `docs/archive/proposals/cognition-extension-design.md` | 已归档 | Cognition/记忆扩展旧设计 | 扩展运行时已移除；Profile 仍存在但不代表记忆能力装配 | `src/host/profile.ts`、current-runtime；`src/extensions/cognition` 不存在 | 历史文档归档，避免误读为当前能力 |
| `docs/archive/proposals/cognition-extension-plan.md` | 已归档 | 已执行后撤回的 Cognition 计划 | 旧文记录阶段曾接线；当前没有 Cognition runtime | current-runtime、现有 profile tests | 归档并标明不可从旧阶段继续 |
| `docs/archive/proposals/cognition-implementation-notes.md` | 已归档 | Cognition 历史交付笔记 | 记忆扩展代码已移除；Profile 相关部分仍存在 | `src/host/profile.ts`、CLI、`tests/subject-profile.test.ts` | 保留历史并在归档导航区分 Profile 与 Cognition |
| `docs/proposals/ui/context-inspector-design.md` | 已修订 | 上下文检视设计与窄实现记录 | 当前实现是 `context_prepare`、提示词快照/转录卡片与 `/prompt`；未实现原提案的四段 inspector 和全量 auxiliary 清单 | `context-intel`、prompt snapshot/card/replay 源码与测试；定向 7 文件/50 项通过 | 移入 UI 提案目录；明确部分实施与真实 TTY/IME 未验证 |
| `docs/proposals/embodiment/README.md` | 已修订 | 具身文档导航 | 原列出的五篇旧架构/计划/报告均已归档；当前合同是 Voice/TTS 与 Live2D runtime | 当前合同链接与归档 README | 改为当前合同及历史归档入口 |
| `docs/archive/proposals/embodiment-architecture.md` | 已归档 | Embodiment v3.5 架构提案 | BodyEndpoint 旧必选字段漏掉当前 resume/cue/interrupt 接缝 | `.uina/extensions/embodiment/seams.ts`、当前 Voice/Live2D 合同 | 归档旧规范 |
| `docs/archive/proposals/embodiment-voice-live2d-audit.md` | 已归档 | 9 月 Voice/Live2D 断点审计 | S1/S5/S6 已改变；ASR/VAD 仍未实现；旧路径和测试布局过时 | 当前 embodiment/voice source；测试未在此轮运行 | 作为当时审计记录保留 |
| `docs/archive/proposals/embodiment-voice-live2d-next-steps.md` | 已归档 | 多轮实施后续日志 | 标题“未执行”与正文 R1-R4 已完成矛盾，内容与报告重复 | Voice/Live2D 当前合同 | 归档日志，不再作任务清单 |
| `docs/archive/proposals/embodiment-voice-live2d-refactor-plan.md` | 已归档 | Voice/Live2D 重构计划 | 主要接线已在当前代码中，旧计划状态失实 | `.uina/extensions/embodiment`、Voice/Live2D 当前合同 | 保留历史实施顺序 |
| `docs/archive/proposals/embodiment-voice-live2d-refactor-report.md` | 已归档 | 重构点时报告 | “未提交”及未完成清单与后续记录冲突；测试数为历史快照 | Voice/Live2D 当前合同；本轮未重跑其全部测试 | 归档历史结果，不表示当前工作树状态 |
| `docs/archive/proposals/extensions-design.md` | 已归档 | 早期扩展设计 | 旧事件词汇及把 TTS SpeechRecord 放入 Core 的设想与当前实现不符 | `docs/extensions.md`、`extensions-development.md`、current-runtime | 当前合同从根目录文档读取 |
| `docs/proposals/runtime/external-event-frame-design.md` | 已修订 | 已实现的事件帧投影合同 | 源码/本地测试存在；`verify:cli` smoke 不证明真实 Provider 或认知收益；本轮未跑相关测试 | `src/extensions/event-frames/`、Host、现有 event-frame tests | 移入 Runtime 提案目录；归档实施计划并区分本地协议与模型质量证据 |
| `docs/archive/proposals/external-event-frame-plan.md` | 已归档 | 已执行的外部事件帧实施计划 | 目标已被设计规格和源码覆盖 | 当前设计规格、current-runtime | 归档并修复链接 |
| `docs/archive/proposals/foundation-correction-plan.md` | 已归档 | S1–S4 已完成计划与交付记录 | 与历史 delivery review 重复；测试/DeepSeek 结果只对应当时 | `docs/history/reviews/2026-09-05-plan-delivery.md`、current-runtime | 历史路径修复；不作为当前验证 |
| `docs/archive/proposals/lifecycle-resource-scope-plan.md` | 已归档 | ResourceScope/World 停用次序计划 | `WorldActivation.stop()` 当前先 close scope 再 onStop；本轮未执行其 tests | `src/extensions/world-framework/world-activation.ts`；tests 存在未复跑 | 归档已实现计划，范围以源码为准 |
| `docs/proposals/live2d/README.md` | 已修订 | Live2D 状态导航 | 区分当前合同、已实现曲线、仍有缺口计划与历史规格 | 模块内各文档及当前 Live2D 源码 | 保留为专题索引 |
| `docs/proposals/live2d/live2d-authored-model-design.md` | 已修订 | 模型 rig/作者流程部分实施设计 | rig v3/12 controls、bodyMapping 与准备输入存在；作者草稿发布/跨模型复用/视觉验收未实现或未验证 | `.uina/worlds/live2d` 源码；真实设备未验 | 标记部分实现和剩余目标 |
| `docs/proposals/live2d/live2d-animation-authoring-redesign.md` | 已修订 | 命名 Timeline/ActionPlan 作者层目标；Timeline 已获最新决定批准 | 当前曲线函数 MotionPlan 已实现；Timeline 仍未实现。v4.7 A2 是历史延后决定，已被后续明确要求 Timeline 的决定覆盖 | `motion.ts`、v4.7 修订登记、[当前合同](live2d/live2d-world-runtime.md)；真实 MO/VTS 视觉验收未做 | 按设计稿阶段 A/B/C 落地；不得将提案写成当前运行事实 |
| `docs/proposals/live2d/live2d-cue-action-repair-plan.md` | 已修订 | Cue output 生命周期与结果语义修复计划 | parser 跨 stream、未处理 output_start/interrupted、dispatch boolean/emit void 仍是差距；能力路由与 TTS cue playback 已实现 | Embodiment/Live2D/TTS source；`speech-cue-playback.test.ts` 存在未复跑 | 旧事实改为实施前基线，更新当前缺口和测试边界 |
| `docs/proposals/live2d/live2d-curve-authoring-design.md` | 已修订 | MotionPlan/曲线作者实现记录 | 编译、域探测、冻结和逐播 bake 已实现；本轮 MO 内容重写只有 6 项目录测试，未证明节奏/画面自然度 | `authoring/motion.ts`、MO catalog、`live2d-mo-catalog.test.ts`；无 VTS 验收 | 区分作者机制测试与视觉验收 |
| `docs/archive/proposals/live2d-engine-refactor-plan.md` | 已归档 | sequence/parallel 动作树引擎重构计划 | 前提被当前曲线函数 MotionPlan 取代 | `live2d-curve-authoring-design.md`、current runtime | 移入归档；新问题从当前代码另立窄计划 |
| `docs/proposals/live2d/live2d-intuitive-animation-spec-amendments.md` | 已修订 | v4.7 用户决策档案 | A2 记录最初推迟 Timeline；后续决定已重新批准 Timeline。A6 weighted 已在 rig 实现，primary 仍拒绝 | `adapter/rig.ts`、`tests/live2d-rig.test.ts` 存在，本轮未复跑 | 保留 A2 历史决定并注明后续批准；不替代当前合同 |
| `docs/proposals/live2d/live2d-intuitive-animation-spec.md` | 已修订 | v4.6 设计决策历史 | 不是当前运行合同；Timeline 延后，weighted 实际已实现 | v4.7 amendment、rig source 与当前合同 | 顶部添加源码优先和状态提醒 |
| `docs/proposals/live2d/live2d-performance-design.md` | 已修订 | MO 动作筛选与表现提案 | 当前 17 动作/四 sway 句；候选名有差异；真实 MO/VTS 表现未验 | MO catalog、current-runtime；本轮 6 项目录测试通过但不足以证明自然度 | 标记部分实现和视觉限制 |
| `docs/proposals/live2d/live2d-world-boundary-spec.md` | 已修订 | 当前 World 边界规范 | 接缝、Worker 与故障停车可核源；当前 MO 曲线重写未做真实视觉验收 | `.uina/worlds/live2d`、假设备/Worker tests 存在未全跑 | 保留为实施边界规格 |
| `docs/proposals/runtime/managed-services-design.md` | 待裁决 | 共享进程服务管理器设计 | 当前没有共享 ServiceManager；文内 M0 要求证据门，但旧结论越过 M0 直接决定 M1 | 点歌/字幕各有局部管理器；现有测试不能证明共享并发租约有需求 | 移入 Runtime 提案目录；已更正为先过 M0，不作为实施授权 |
| `docs/proposals/integrations/mcp/mcp-extension-design.md` | 已修订 | MCP Extension P0 实现合同与边界 | `.uina/extensions/mcp` 当前实现存在；远端/SSE/进程收尾仍按部署验证，测试存在但本轮未跑 | MCP source、现有 tests/mcp-*；无真实远端服务验收 | 移入 integrations/MCP 目录并标明未验证边界 |
| `docs/proposals/worlds/netease-jukebox/netease-jukebox-hud-migration-design.md` | 已修订 | 点歌 World/HUD 当前设计与实施记录 | 本地 World、播放协调、queue、library、HUD client 与两个局部 manager 存在；真实账号/mpv/OBS 未验；频谱只有 audio/silent | `.uina/worlds/netease-jukebox`、tests/netease-* 存在但本轮未跑 | 移入 World 专题目录；修正 synthetic 来源及旧施工步骤的现行性 |
| `docs/archive/proposals/provider-model-decoupling-plan.md` | 已归档 | Provider 与 Model 解耦计划 | 当前已分离纯数据 Model 与 Provider registry；原“只有 ModelProvider”基线失效 | `src/ai/providers.ts`、`tests/provider-model-decoupling.test.ts` 存在未复跑 | 归档已实现计划，真实多端点行为仍未由本轮证明 |
| `docs/proposals/qq/README.md` | 已修订 | QQ World 活动材料导航 | 原索引把新旧接口、计划、审查和证据平铺，容易把旧合同当现行规范 | 当前运行文档、验收记录、`.uina/worlds/qq/tool.json` 和 3 份保留设计 | 分出当前事实、保留的设计记录、JSON fixture 与归档入口 |
| `docs/proposals/qq/qq-push-single-rail-proposal-2026-10-11.md` | 已修订 | QQ v3 通知设计记录，核心语义已实现 | scheduler/reader/attention/control-store 与 v3 核心匹配；源码仍每次 inbox 查询在线好友/群目录；手动 read 默认 20、最多 100，不等同响铃窗口 30/14,000 | QQ 代码、scheduler/reader 测试；本轮 QQ 24 文件/420 项通过；真实 QQ 未验证 | 分离当时审批记录、已实现状态与未满足的低成本 inbox 目标 |
| `docs/archive/qq/qq-reader-notification-design-2026-10-09.md` | 已归档 | QQ 旧阅读与双轨通知合同 | §10 双轨、digest/follow/focus+mode 与 v3 单书签合同冲突；历史设计过程仍有参考价值 | 当前 `qq-push-single-rail`、current-runtime QQ 章节、QQ 验收/测试 | 移入 `docs/archive/qq/`；旧合同不再指导实施 |
| `docs/archive/qq/qq-reader-notification-devplan-2026-10-11.md` | 已归档 | 阅读/通知重构执行日志 | 历史任务状态与总结互相矛盾，不再是可执行计划 | QQ 验收记录及当前源码 | 原文保留，归档导航说明替代关系 |
| `docs/proposals/qq/qq-world-design.md` | 已修订 | 首版目标、所有权和安全边界背景 | 旧 9 动作与通知章节被 14 动作/v3 当前实现取代；高层边界仍有参考价值 | current-runtime QQ 章节、QQ 源码/验收、实际 `tool.json` | 留作首版设计理由，不当当前接口合同 |
| `docs/archive/qq/qq-world-development-guide.md` | 已归档 | NapCat 世代旧实施指导 | 阶段/动作与当前实现不符；旧 ownership/unknown 原则可追溯 | current-runtime、qq-world-acceptance | 原文保留，改正过时入口声明和链接 |
| `docs/proposals/qq/qq-world-discovery-resource-design-2026-10-11.md` | 已修订 | 五个发现/资源动作的实现设计记录 | 五动作在 app/discovery/resource-fetch/schema 中接线；本轮 QQ/schema 24 个文件、420 项通过；真实平台读取未验证 | 当前 QQ 源码、discovery tests、current-runtime/acceptance | 标明阶段计划已结束；将旧通知设计标为归档前序依据 |
| `docs/archive/qq/qq-world-implementation-plan.md` | 已归档 | QQ 初版 P0–P9 实施台账及当时证据 | 九动作旧阶段被当前 14 动作实现取代；P7 媒体记录保留为历史范围证据 | current-runtime、QQ 验收、P7 evidence | 移入归档并修复源码/schema/同组链接 |
| `docs/archive/qq/qq-world-interface.md` | 已归档 | QQ 旧 LLM 接口合同 | 旧 `observe/speak/gesture/attention/follow_up/account` 表面已退役 | 当前 `tool.json`、current-runtime QQ 章节和 schema tests | 原文保留，标出当前 schema 入口 |
| `docs/archive/qq/qq-world-llm-interface-v2-2026-10-08.md` | 已归档 | 六动作接口迭代稿 | 动作数量与字段同当前 schema 不符，文内状态互有冲突 | 当前 `tool.json` 与 QQ 验收 | 作为迭代历史保留 |
| `docs/archive/qq/qq-world-llm-rendering-inventory.md` | 已归档 | 旧模型表面静态模板清单 | 当前 14 动作已不由该旧六动作清单描述；不应维护第二份参数总表 | `.uina/worlds/qq/src/render.ts`、tool schema 与测试 | 作为历史检查记录保留 |
| `docs/archive/qq/qq-world-llm-view-review-2026-10-08.md` | 已归档 | 旧接口时代的模型视图审查 | 部分建议已被 renderer 吸收；真实模型认知质量未验证，旧 v2 依据也已退役 | 当前 renderer、current-runtime、QQ 验收 | 作为部分吸收的历史审查保留 |
| `docs/archive/qq/qq-world-p7-media-evidence.md` | 已归档 | 2026-10-07 的真实媒体发送证据 | 仅证明当时记录的目标/类型，不表示当前平台可用，也不能外推到其他媒体 | QQ 验收记录中的历史边界 | 归档保留一次性证据；链接到现行验收摘要 |
| `docs/proposals/voice/realtime-subtitle-service-design.md` | 待裁决 | 实时字幕服务设计与当前实现对照 | ThirdParty 服务及 companion 代码、测试均存在；无 cue 的 typewriter 估时与设计中的禁止估时相冲突，真实 OBS/声卡未验收 | ThirdParty 源码、`.uina/extensions/tts/subtitle-companion.ts`、本地测试路径；本轮未跑 | 移入 Voice 专题目录；标注近似语义并保留待裁决项 |
| `docs/archive/proposals/rewind-extraction.md` | 已归档 | 已完成的 P5 Rewind 提取报告 | 当前 recovery 仍有安全目标与因果校验；专题合同和当前 plan 已覆盖 | `src/session/recovery.ts`、`tests/session-rewind.test.ts` 存在未复跑 | 归档为实施报告，指向 session-rewind/subject-runtime-plan |
| `docs/proposals/integrations/mcp/screen-mcp-design.md` | 已修订 | Screen MCP 设计与当前本地代码状态 | `.uina/mcp-servers/screen-mcp` 代码切片和状态文件存在；真实桌面、Provider、默认尺寸和延迟门未验证 | Server/worker/UIA/browser source、`IMPLEMENTATION_STATUS.md`；合成 roundtrip test 存在未复跑 | 移入 integrations/MCP 目录；更新真实路径与门禁，current-runtime 增加摘要 |
| `docs/archive/proposals/screen-mcp-development-guide.md` | 已归档 | 指向 packages/screen-mcp 的旧施工指南 | 实际包目录为 `.uina/mcp-servers/screen-mcp`，多项代码切片已完成 | 新路径状态文件和当前 Screen MCP design | 归档旧计划，不再作为“未开始”指南 |
| `docs/archive/proposals/seams-inventory.md` | 已归档 | P4–P8 阶段接缝盘点与审计 | 部分通用机制仍有价值，但 Jobs/Subagents/Cognition 状态过时 | `subject-runtime-plan.md`、current-runtime | 历史记录归档，唯一当前施工规格留在固定路径 |
| `docs/proposals/subject-runtime-decisions.md` | 已修订 | Subject Runtime v1–v6 非规范决策历史 | 文中 Jobs/Subagents 是历史实现陈述；当前运行时已于 2026-10-06 移除 | current-runtime、固定 Subject Runtime plan；已移除扩展目录不存在 | 按 AGENTS.md 保留固定路径并标明非当前事实 |
| `docs/proposals/subject-runtime-plan.md` | 已修订 | 唯一有效的 Subject Runtime 施工规格 | P5–P8 已完成；阶段表是历史计划，当前公共接缝以 current-runtime/source 复核 | `src/session/recovery.ts`、`agent/runtime.ts`、边界检查路径；测试存在未复跑 | 标完成阶段，保留唯一规格路径，更新接缝审计链接 |
| `docs/archive/proposals/tts-extension-design.md` | 已归档 | 早期 TTS 扩展设计 | 工具表面、播放断点和过滤规则已被 Voice/TTS 当前合同替代 | current voice docs/source/tests | 归档避免旧行为成为规范 |
| `docs/archive/proposals/tui-design.md` | 已归档 | 早期 TUI 设计 | `UinaTUI/SimpleTUI`、旧路径与当前结构不符；fake terminal 不证明 IME/视觉 | `src/ui` 当前结构、current-runtime；测试存在未复跑 | 归档为历史设计，当前事实归 current-runtime |
| `docs/proposals/voice/voice-architecture.md` | 已修订 | Voice/TTS 部分实施架构提案 | 当前动作 `speak/interrupt/status/manage`；ASR/VAD 未实现，测试不证明用户听见声音 | `.uina/extensions/voice`、`.uina/extensions/tts`；相关测试存在，本轮未运行该模块 | 移入 Voice 提案目录；更新工具面和验证边界，链接 Voice/TTS 当前合同 |
| `docs/qq/qq-world-acceptance.md` | 已修订 | QQ 重构、发现能力验收记录与当前离线复核结果 | 历史门禁与本轮测试已分开；本轮 24 个 QQ/schema 测试文件、420 项通过；真实 QQ 与外部资源行为未验证 | `.uina/worlds/qq/src`、24 个 QQ 测试文件与 schema 测试 | 移入 QQ 专题目录；根旧路径保留迁移提示 |
| `docs/qq/qq-world-discovery-review-2026-10-11.md` | 已修订 | 2026-10-11 发现动作修复审查记录 | 缺陷复现、修复顺序和历史不通过边界仍是有用证据；测试数字只属于当时工作树 | `discovery/resource-fetch` 当前代码及 QQ 验收本轮测试结果 | 移入 QQ 专题目录；保留历史快照说明 |
| `docs/session-rewind.md` | 完成 | Session 主线回溯合同 | 核心接口、提交/安全点、恢复与导航实现一致；边界说明清楚 | recovery/jsonl-store/agent loop；3 份定向测试 62 项通过 | 保留历史验收日期和外部未验证边界 |
| `docs/superpowers/plans/2026-09-27-tts-delivery-hardening.md` | 已修订 | TTS parser/PCM/lease/Voice 结果改进的实施记录 | 本轮 `tts-hardening.test.ts` 包含在 7 文件/50 项定向集；Bridge `test_service_cancel.py` 与 `test_review_races.py` 另有 49 项通过 | `stream-parser.ts`、`delivery.ts`、`playback_coordinator.py`、`service.py`；未连真实服务 | 标明执行清单是历史记录；保留实现约束和验收边界 |
| `docs/superpowers/plans/2026-10-04-inline-prompt-injection-cards.md` | 已修订 | 提示词快照、外部输入卡片和 `/prompt` 的实施计划 | 当前源码存在 prompt snapshot/external_input/card/replay/overlay；专门定向集 7 文件、50 项通过；宽 `ui.test.ts` 有一项文件联想依赖错误 | `prompt-snapshots.ts`、TUI、ContextCard/PromptOverlay；`context-card`/snapshot/provenance/replay 等测试 | 实现已落地；保留未勾选原清单并注明非当前待办及测试边界 |
| `docs/superpowers/plans/2026-10-13-live2d-world-refactor.md` | 已修订 | 2026-10-13 Live2D World 已执行重构计划 | 文内任务 1–6 有实施记录；当时完整 Live2D/整仓结果均为历史快照；本轮 typecheck 通过、MO catalog 6 项通过，真实画面未验 | 当前 Live2D 源码、运行合同与 6 项目录测试；未重跑完整 Live2D 套件 | 标明原未勾选框是历史清单；更新审计边界 |
| `docs/superpowers/specs/2026-10-04-inline-prompt-injection-cards-design.md` | 已修订 | 提示词注入卡片功能规格 | 当前源码覆盖快照、外部输入卡片、顺序回放、`/prompt`；7 个定向文件 50 项通过 | session prompt snapshots、UI card/overlay、provenance/replay tests；真实 TTY/IME 未验 | 保留设计约束并标明已实现状态 |
| `docs/voice-tts/tts-file-generation-review.md` | 已修订 | 文件生成缺陷审查快照 | 列出的缺陷与当前实现对应；旧测试计数和门禁只属原工作树 | `generate.ts`、Bridge `service.py`；本轮相关离线测试通过 | 移入 Voice/TTS 专题目录；审查边界保留 |
| `docs/voice-tts/tts-file-generation.md` | 完成 | tts_generate 文件与失败合同 | 本地 PCM WAV 字节校验、独占发布、取消/期限边界与代码一致；外部 Vendor/QQ 仍未验证 | generate.ts、bridge/service.py；5 个 TS 文件 61 项、Bridge 两文件 64 项通过 | 移入 Voice/TTS 专题目录；根旧路径保留迁移提示 |
| `docs/voice-tts/voice-tts-runtime.md` | 完成 | Voice/TTS 当前合同 | 工具分离、mute/recovery、epoch、source 对账、上下文消费和外部验收边界与当前合同相符 | Voice/TTS TypeScript、Bridge Python 源码；本轮 61 个 TS 与 64 个 Python 定向测试通过 | 移入 Voice/TTS 专题目录；根旧路径保留迁移提示 |
| `docs/voice-tts/voice-tts-verification.md` | 已修订 | Voice/TTS 自动化与设备证据快照 | 新增原始运行未注明日期/基线说明及本轮 repository-only 测试；未重做外部验收 | 本轮 pnpm typecheck、TS 61 项、Python 64 项；无真实设备/Vendor | 移入 Voice/TTS 专题目录；根旧路径保留迁移提示 |
