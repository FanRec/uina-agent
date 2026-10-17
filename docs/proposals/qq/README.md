# QQ World 文档索引

按当前工作区核对后，活动材料按其实际用途分组。实现事实以当前运行文档、源码和测试为准；历史方案与证据见[归档导航](../../archive/qq/README.md)。

## 当前事实与验收

- [当前 QQ World 运行事实](../../current-runtime.md#qq-world)
- [QQ World 验收与离线复核](../../qq/qq-world-acceptance.md)
- [当前工具 schema](../../../.uina/worlds/qq/tool.json)：动作参数的实际真源。

## 仍有参考价值的设计记录

- [QQ World 首版设计](qq-world-design.md)：保留目标、所有权和安全边界；旧九动作及通知合同是历史设计，不作现行接口。
- [单轨推送 v3 设计记录](qq-push-single-rail-proposal-2026-10-11.md)：核心通知语义已实现；源码仍每次 `inbox` 请求在线好友/群目录，未满足“廉价瞥一眼”的本地优先目标。设计审批状态无法从源码证明。
- [发现与资源设计](qq-world-discovery-resource-design-2026-10-11.md)：五项发现/读取能力已接线；真实 QQ 平台读取仍未验证。

## 支持材料

- [部署 Grant Schema fixture](qq-world-deployment-grants.schema.json)
- [交互示例 fixture](qq-world-interaction-examples.json)
- `qq-world-tool.json` 是历史设计材料；当前实际工具 schema 见上方 `.uina/worlds/qq/tool.json`。

旧接口、过期实施计划和一次性媒体证据已归档，逐篇原因及后续依据见[QQ 归档材料导航](../../archive/qq/README.md)。
