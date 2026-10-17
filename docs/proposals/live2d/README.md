# Live2D 文档索引

当前行为以 [Live2D World 运行合同](../../live2d/live2d-world-runtime.md) 和源码为准。本目录区分已实现机制、未完成计划与历史决策；自动化测试不证明真实 VTS 画面自然度。

## 当前边界与已实现机制

- [World 边界规格](live2d-world-boundary-spec.md)：当前 World 接缝和资源所有权。
- [曲线创作设计](live2d-curve-authoring-design.md)：`MotionPlan`、编译校验与逐播 bake 已实现；MO 内容重写尚无真实画面验收。
- [作者模型设计](live2d-authored-model-design.md)：rig 与参数准备路径部分实现；作者预览、跨模型复用和视觉验收仍是目标。
- [v4.7 修订登记](live2d-intuitive-animation-spec-amendments.md)：历史决策；与当前源码不一致处见文首复核。

## 未完成或待实施

- [Cue 链路修复计划](live2d-cue-action-repair-plan.md)：Embodiment 的输出流 parser 生命周期与派发结果仍有缺口。
- [程序化动画作者层重设计](live2d-animation-authoring-redesign.md)：Timeline 已由后续用户决定重新批准，尚未实现；v4.7 A2 作为历史决策保留，按设计稿分阶段实施。
- [动作表现筛选与性能设计](live2d-performance-design.md)：候选与发布目录有差异，真实 VTS/MO 表现未验收。

## 历史决策

- [直觉动画规格 v4.6](live2d-intuitive-animation-spec.md)：设计决策档案，不替代当前运行合同；Timeline 延后，weighted 已由当前 rig 实现。
- [已归档的旧引擎计划](../../archive/proposals/README.md#embodiment-与-live2d)
