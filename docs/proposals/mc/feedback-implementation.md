# 批 10：反馈与默认自保实施记录

日期：2026-10-27。基线 da4353a，工作树 codex/phase0-baseline。

## 已确认范围

按会话中批准的计划：A 生命周期/身体事实；B Driver feedback 与 Program loop；C 默认自保、可撤销身体作用域；D 持久记录/状态/通知与正式真服验收。能力仍为25/51。不修改已有 context.ts/.workbuddy-ai、真实Provider配置/认证/会话或Pi；不重置世界。

沿用当前工作树和已通过的46文件357项基线。验证先使用确定性真实引擎/协议场景，模型仅校准发现、loop及中断恢复。

## 施工与裁决

- A→B：同一 ClientFacts 来源提供 self/sensors；物理步适配只由 Driver 持有。
- B→C：普通程序与自保共用 BodyOps/关闭屏障；Runtime 仍唯一授予身体。
- C→D：safety 独立 owner，既有 writer/records 保存事实；不制造 Run。
- 裁决：保留当前已授权 checkout，局部重构；不创建另一个工作树或改动无关文件。

## 进度

- 已核对实际装配25项；本轮实施前MC46文件357项通过。
- A–D代码、正式接线与最终验收已完成；保留历史轮次和中间失败各自的证据边界。

## 实现

- ClientHost监听寿命跟随连接；死亡立即退役旧化身，重生/跨维度发新身份，断线不保留ready。self按实际oxygenLevel、属性value/modifiers与收到的效果寿命读取；缺失仍unknown。
- Driver复用现有simulatePlayer/apply循环，只识别真实客户端control对象的消费步；Pathfinder的候选预测不改、不计步。反馈单在算帧/latest-only待交付，250ms有效期；消费后的apply回执保留采样步、应用步与完整输入。额外传感仅self/inventory/block/entities/world。
- Program接body.feedback/loop；step同步，返回Promise报STEP_ASYNC。身体作用域独立退役、句柄/流/窗口与宿主等待统一关闭，父程序可捕获INTERRUPTED重读现场。
- 默认反射只处理既定三类危险，最多10秒；受控只读Pathfinder搜索（16格、2ms分片、250ms搜索预算）加反馈走/游，不挖放、消耗或攻击。等价网格出口按实际站位打破平局；站姿/流体判据核实后才safe。
- Runtime同一FIFO暂停普通授予、退役旧控制后授予safety，不制造Run；效果、触发证据、阈值、终态均入既有有序writer。状态给active/last，重要结果沿现有事件入口提示重读。恢复按持久owner与效果行结算，不重放动作。
- Runtime schema v6为唯一格式；旧v5拒绝自动迁移。history v3、ledger v3、Host journal v4不变；所有验收用独立Temp数据根。

## 审查与真实场景修正

独立只读审查的三项Important均用失败回归复现后修复：预测模拟被改写；混合输入在攻击后漏记效果；未结束safety恢复漏掉持久效果。普通取消仍等待子清理；只有明确身体退役可以不等guest合作。失败/未知输入的清理单独记效果，不洗白原派发。

真服另暴露路点容差与收油阈值不一致、整数节点已满足但碰撞箱仍接触岩浆、等距出口忽略实际亚格站位的问题，均补具体坐标回归。协议事实与本地预测保留来源区别。开发场景物理灭火、复位专用区域并按确切intervention读取终态；不把后续新危险的last状态当原介入结果。

提交前常规独立审查另确认1项Important：反馈视角与离散lookAt/自动瞄准操作会互相覆盖，并可能错误记录met。已用双向失败回归复现，按实际待应用/已安装视角及离散操作寿命做局部冲突检查；同时覆盖自动瞄准dig、方块interact、writeSign和openContainer。仅按键反馈、独立攻击与dig(preserve)保留兼容，显式无视角的新帧解除占用。另修正2处过时实现注释；没有新增锁、队列或配置。

中间失败的Temp库和服务端日志保留；如 `uina-mc-native-eqQXLg`、`uina-mc-native-KxY5nB` 保存实际多次介入与后续死亡，不计作最终通过。早期源码13项通过（`uina-mc-native-hKA5o3`）属于审查前状态，最终证据另列。

## 最终证据与边界

| 验证 | 本轮结果 |
|---|---|
| `pnpm typecheck`（含9条边界）与 `pnpm build` | 通过；`dev/mc-feedback-typecheck-final.log`、`dev/mc-feedback-build-final.log` |
| MC显式文件列表 + vmThreads | **51文件 / 376项通过**，`dev/mc-feedback-regression-final.log` |
| delivery-host/session/process/subject、world-tool-schema，默认池 | **5文件 / 28项通过**，`dev/mc-feedback-host-final.log` |
| 正式源码 Host/WorldTool/受管Executor/Paper | **13/13通过**，`dev/mc-feedback-source-final.log`；Temp `uina-mc-native-oBk2aS`，采样→guest→应用p50=56.2ms、p95=63.1ms |
| 正式构建产物同场景 | **13/13通过**，`dev/mc-feedback-dist-final.log`；Temp `uina-mc-native-RAPg62`，p50=59.6ms、p95=62.1ms |
| 真实 `deepseek/deepseek-flash` 定向校准 | **4/4检查点通过**；模型自行编写loop→真实受伤介入→捕获INTERRUPTED→新身体loop移动；`dev/mc-feedback-model-final.log`，Temp `uina-mc-model-FwVKy9` |

以上Temp父目录均为 `C:/Users/34150/AppData/Local/Temp/`。模型程序返回真实异常码、初始x=16010.5、结束x=16012.615、第二段11帧；持久safety记录的interruptedRun精确指向该Run并最终safe/succeeded。没有伪造异常、预置模型源码或更换真实Provider配置。

源码/产物13场景覆盖真实引擎与物理回执、过期输入、异步step拒绝、三类自保、持有身体/采矿/独占导航中的介入、效果归属、托管关闭重开及全局急停/显式恢复。导航中用真实受伤触发并保持路径几何不变，避免把Pathfinder对新障碍的独立终止误归给Runtime抢占。域外机制复用既有平台，不升级为全部OS故障或长期负载验证。

最终构建包含指南/校准脚本改进；产物13场景验证的控制/协议实现与最终构建相同，之后只补指南和无模型场景准备，没有为更新文档重复整组物理实验。

提交前复核及上述视角修复后，重新通过typecheck/9条边界、build、MC **51文件378项**；相关Host仍为5文件28项通过。正式场景新增视角冲突拒绝/仅按键兼容检查，源码和重新构建产物均 **14/14通过**，Temp分别为`uina-mc-native-6468Xd`、`uina-mc-native-R6eslw`，p50/p95分别59.6/62.0ms及60.6/63.3ms。日志为`dev/mc-feedback-review-{typecheck,build,tests,host,source,dist}.log`。本次没有再调用真实模型；前述模型结果保留其当时版本边界。验证中并行构建曾遇Windows加载中native模块无法覆盖，测试退出后顺序构建与类型检查通过，没有修改构建机制。

### 模型成本与失败轮次

首轮 `uina-mc-model-3htvpS` 失败：准备回执触发不必要的思考，指南未明确frame.self.value及默认self传感形状，随后出现重复探测。为止住继续试探终止了校准宿主；会话/Runtime库和 `dev/mc-feedback-model.log` 保留，不计通过。该轮成本控制失误如实记录。

修正后，准备先在相同真实Driver/Runtime的独立执行侧完成，再启动模型Host；首次真实loop进度握手后只注入一次伤害。脚本限制12次请求、90秒，预算耗尽时中断并关闭；限制仅属验收，不进入生产Runtime或真实配置。

| 轮次 | 已记录请求 | 非缓存input | output | cacheRead | totalTokens |
|---|---:|---:|---:|---:|---:|
| 首轮失败（已落盘usage；终止时在途部分不猜测） | 48 | 37699 | 5498 | 1121280 | 1164477 |
| 最终校准 | 5 | 7060 | 972 | 32896 | 40928 |

数值按真实会话usage汇总，不推算费用。最终只有2次模型工具调用（run与record），其余请求包括真实通知处理；协议、恢复与停止仍由确定性验证承担。

入口 `pnpm dev:mc:feedback`；产物 `node dist/.uina/worlds/minecraft/dev/feedback.js`；模型加 `--model`。本轮Paper1.21.11 build132 / Java21经 `/stop` 保存全部维度，Java会话exit0，世界和Temp材料保留。

本包仍25/51；不宣称完整战斗、长期开放生存、其他协议/认证组合或真实TTY通过。下一工作包为places/remember/forget与route.plan/explore。
