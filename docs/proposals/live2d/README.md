# Live2D 文档索引

当前行为以 [Live2D World 运行合同](../../live2d/live2d-world-runtime.md) 和源码为准。本目录唯一的目标重构设计是 [Live2D 身体与表演 SDK 设计](live2d-world-performance-redesign.md)（已按确认方案修订，SDK 重构尚未实施）；其他旧设计仅作历史资料，不作为施工规格。自动化测试不证明真实 VTS 画面自然度。

## 目标施工规格

- [身体与表演 SDK 设计](live2d-world-performance-redesign.md)：表现目标与原则、专用组件、姿态交还、注视与默认头身协调、固定轴响应、面部组合、协调限幅、作者工具与模型编排、工具/cue、生命周期、预览标定和验收。
- 本文档是目标设计，不代表已经实现；实施后的事实仍需更新运行合同。无需为旧工具保留兼容层。

## 当前边界与已实现机制

- [World 边界规格](live2d-world-boundary-spec.md)：现有 World 接缝和资源所有权参考；如与源码冲突，以源码为准。
- 当前动作作者层以 `ActionPlan`、Timeline 和 MO 源码为准；旧作者层文档不再定义施工目标。
- [运行期加固：已实施修复与后续提案](live2d-runtime-hardening.md)：2026-10-18 的结构修复记录（空间阶段机、环境令牌、躯干声明、时序档案、动作质量基线）与待办提案；已实施部分以源码与测试为准。


## 历史资料（不作为施工规格）

- [曲线创作设计](live2d-curve-authoring-design.md)
- [作者模型设计](live2d-authored-model-design.md)
- [Cue 链路修复计划](live2d-cue-action-repair-plan.md)
- [程序化动画作者层重设计](live2d-animation-authoring-redesign.md)
- [动作表现筛选与性能设计](live2d-performance-design.md)
- [直觉动画规格 v4.6](live2d-intuitive-animation-spec.md)
- [v4.7 修订登记](live2d-intuitive-animation-spec-amendments.md)
- [已归档的旧引擎计划](../../archive/proposals/README.md#embodiment-与-live2d)
