# 已归档记录

这里保存 Minecraft World 的历史实施记录与早期研究。它们只用于追溯**当时的做法、证据与裁决**，不维护现状。

**不要从这里读当前状态。** 当前合同在 [../modules/](../modules/) 与 [../public-api.md](../public-api.md)，当前施工顺序在 [../development-plan.md](../development-plan.md) §10，当前缺陷在 [../known-gaps.md](../known-gaps.md)，每轮改了什么在 [../changelog.md](../changelog.md)。

## 使用规则

- 文件里的数字（能力数、schema 版本、测试项数、请求用量）只代表当批，**不得引用为当前值**。
- 其中的"未实现/待验收"是当时的结论，可能已被后续批次关闭。
- 新批次的实施记录直接写入本目录，并在 `../changelog.md` 与本页登记；根目录只留当前有效规范与索引。

## 批次记录

| 文件 | 批次 | 记录内容 |
|---|---|---|
| [window-container-implementation.md](window-container-implementation.md) | 批 2 · 2026-10-24 | 窗口会话、真实服务端点击确认、`container@1`/`transfer@1`/`container.last@1`、窗口证据历史 |
| [driver-repair-implementation.md](driver-repair-implementation.md) | 修复 · 2026-10-25 | 1.21.11 协议窄口、Body 资格与操作资源、库存/采矿/牌面、取消与受控导航、容器历史 |
| [production-repair-implementation.md](production-repair-implementation.md) | 修复 · 2026-10-25 | 生产链八项问题：合成/熔炼拆分、实例匹配与跨槽搬运、熔炼等待释放身体 |
| [executor-platform-implementation.md](executor-platform-implementation.md) | 批 4 · 2026-10-25 | Windows x64 双 Job、受管 bootstrap/Companion、私有 IPC、身份与 launch 账本 |
| [spatial-implementation.md](spatial-implementation.md) | 批 13 · 2026-10-31 | region/tunnel/excavate、G4 ctx.verify 注册表与 verify/dig@1、上坡行走楔死（G21） |
| [host-delivery-implementation.md](host-delivery-implementation.md) | 批 5 · 2026-10-25 | Host 持久回执、journal v4、canonical 提交索引、inspect/retire |
| [native-host-implementation.md](native-host-implementation.md) | 批 6 · 2026-10-25 | 正式 WorldDef、原生模型工具、请求凭证、可靠通知、BodyEndpoint、首次真实模型校准 |
| [program-implementation.md](program-implementation.md) | 批 7 · 2026-10-25 | QuickJS 0.32.0、共享 worker/独立 guest、`mc` 表面、源码快照、容量与局部取消 |
| [library-implementation.md](library-implementation.md) | 批 8 · 2026-10-25 | program/blueprint/experience 三类文件、头解析、CRUD、`save from`、统一发现 |
| [wait-implementation.md](wait-implementation.md) | 批 9A · 2026-10-25 | 确切查询版本、事件提交 Watch、`waitUntil`、历史库 v2 |
| [decision-implementation.md](decision-implementation.md) | 批 9B · 2026-10-26 | `decide`/`continue`、显式续段、`replace_pending`/`preempt_current`、历史保留与清理、I2 |
| [feedback-implementation.md](feedback-implementation.md) | 批 10 · 2026-10-27 | `body.feedback`/`body.loop`、250ms 帧与过期撤销、默认自保、Runtime schema v6 |
| [control-gate-and-effect-intent.md](control-gate-and-effect-intent.md) | 2026-11-09 | 单一 ControlPermit、Effect 写前意图与持久屏障、C02–C05 崩溃矩阵、本轮验收台账与持久等待未完成的源码级施工路径 |
| [review-2026-11-09-quality.md](review-2026-11-09-quality.md) | 审查轮 · 2026-11-09 | 附件完成度判定、实现质量审查的缺陷清单、五处修复的红→绿证据、未修项的理由与全量门禁 |

## 早期研究

| 文件 | 日期 | 内容 |
|---|---|---|
| [research.md](research.md) | 2026-10-15 整理，2026-10-18 划定证据范围 | 五个参考项目对照、Uina 接缝与固定源码复核、成熟依赖复用边界、被否方案、验证场景与未验证判断 |

`research.md` 开头自己写明"不作为当前执行合同"。它仍被 `../modules/` 引用，因为 Driver 的若干窄接缝条款的源码依据只在那里。
