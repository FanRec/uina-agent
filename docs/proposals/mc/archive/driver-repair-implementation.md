# Driver 修复与重构

日期：2026-10-25（Asia/Shanghai）。范围：现有 10 查询、13 动作及其 Runtime/Driver/World 链路；不新增 craft/smelt、Program、Host 回执或 Executor。

## 责任与替换

- `driver/mineflayer/protocol.ts` 是按连接创建、随连接退役的窄协议端口。当前实现 Java 1.21.11 的物品编解码、同步写入和标准化服务端通知；其他版本的相关写入明确返回 `UNSUPPORTED_PROTOCOL`。未来支持其他版本时替换此适配，能力、World、Runtime 不承担包名和协议版本分支。
- BodySession 保留资格、操作资源归属、撤销和停止屏障；inventory、mining、sign 各自持有异步等待、定时器和精确监听。操作每次异步恢复及同步写入前核验资格，清理只能作用于原连接及资源。
- 玩家库存与普通容器共用 WindowSession 的快照、revision、槽位/光标期望、串行点击与服务端确认。删除装备、移槽和丢弃对上游异步库存便利链的依赖，不保留两套写入路径。
- 数据库表结构不变，不增加迁移或旧字段兼容层；真实运行数据不在本次重构中清理。已有容器观察继续沿 World 的原证据表和提交屏障持久化。

## 行为合同

### 库存与选择器

窗口、库存和查询共用 `ItemValue={name,count,stackSize,components,durability}`。components 是当前适配得到的纯 JSON patch；stackSize 和 durability 使用有效的 max_stack_size、max_damage、damage 组件覆盖注册表默认值，移除相关组件时不回填默认值。durability 是实际剩余耐久；未知仍是 null。

同一个 ItemSelector 匹配实现处理名称规范化、substitutions、精确 components 和 minDurability。未知字段不能满足显式约束；存在可验证匹配项时仍可使用该项，不因另一项未知而阻断。约束不再被按名字静默降级。

`BodyOps.toss(selector,count)` 返回 `{receipt,removed,remaining}`。removed 只记录服务端确认移出自身库存的各名称数量，部分失败保留同样进度；余量回原槽、光标核验为空后才完整完成。公开 drop 仍负责逐名称核验地面增量，不能用离包代替落地、用一种物品的多余掉落补另一种物品。

业务点击只发一次。取消或不明回包保留未知，不自动补点；未知光标不能成为下一次操作“已空”的前置事实。未确认开窗的停止屏障仍沿既有规则封闭同连接的再次身体授予，需重连。

### 采矿与工具

`HarvestRequirement` 区分 any、实际 tools 名称集合和 unknown。来源为注册表的 harvestTools，block.harvest、mine、collect 共用判断，不用金/铜/铁等材质的假定顺序。自动选择优先当前合格手持，其次按库存槽序；显式工具还须满足原 ItemSelector。

Driver 只复用客户端的挖掘耗时计算，自行持有开始、结束、取消与服务端监听。开始前订阅单块/批量方块更新，匹配原连接、化身和位置的空气更新才认证破坏。计时完成、本地空气和协议 ACK 均不能认证结果。结束后 5 秒无确认保留 unknown；确认不足不自动重试。mine 只在确认后返回 broken:true，collect.mined 只累计确认的破坏。

### 牌面、查询、导航与结算

- 牌面编辑器等待与提交分别受控，确认监听先于提交安装；取消后晚到编辑器不能触发文字提交，不发送空文字作为清理。
- QueryDescriptor.input 在装配时编译，World read/watch 先校验再分派 current/static/history。null 输入归一化为 {}；缺少校验器在历史库启动前明确失败。历史只保留坐标、游标、过滤和分区等语义检查。损坏 token 拒绝，不取整或静默过滤后续读位置。
- placeToReach=false 同时取消可用垫块材料并禁止垫柱，覆盖搭桥和跳跃补块；重新启用恢复默认 dirt/cobblestone，配置不跨调用残留。
- Goto 完成复查与派发前的快速路径统一使用 GoalNear 的整数格 nodeGap 判据。欧氏距离仍用于返回诊断，不能用 tolerance+0.75 拒绝已满足节点目标的实际站位。
- Runtime 结算先取得实际效果，再检查调用子树。正常返回但有未确认效果时保留返回值并结算 unknown；失败/取消及其未知副作用分别保留。效果保持唯一归属，持久记录和恢复读取不洗白结果，也不重放动作。

## 独立审查后的必要修复

最终独立审查的五项 Important 均以失败回归复现后修复：

1. 窗口构造先校验版本及初始玩家快照，再注册订阅；构造失败不泄漏监听。
2. 关窗后保留同连接 lastClosedWindow 的尾随玩家库存同步，直至新 open、respawn 或 end；关闭窗口不能导致服务端迟到的真实库存更新丢失，也不能借旧窗口污染新代次。
3. ItemValue 解码使用有效组件覆盖值与移除语义，不能始终使用物品类别的默认最大耐久或堆叠上限。
4. socket.write 异常转换为结构化 CallFailure，保留未知派发、effect 引用以及此前已确认的 removed；不把可能已派发或部分完成写成 not_sent/零进度。
5. Body 统一 guard 提前 assertSupported；已知未派发的开窗失败不制造“未确认开窗”屏障，不要求无意义的重连。

## 验收入口与数据归属

`openHarness` 支持 `options.dataRoot`，优先级为显式参数、`MC_DEV_DATA_DIR`、原本的 `.uina/world-data/minecraft` 默认路径。场景打印实际绝对数据根。`dev:mc:repair` 没有显式环境目录时自行创建独立 Temp 目录，不触碰默认库。

```powershell
$env:MC_DEV_DATA_DIR = Join-Path ([IO.Path]::GetTempPath()) ('uina-mc-repair-' + [guid]::NewGuid())
pnpm dev:mc:repair
# 构建后，使用同样的独立数据目录入口：
node dist/.uina/worlds/minecraft/dev/repair.js
```

同一开发玩家串行运行。Paper 使用现有专用开发服与 10000 附近 y=199 平台；脚本核验区块加载及落脚，只准备这块测试区，不重置世界。游戏动作经正式 Runtime、能力和 Driver；op 指令只负责准备地形、物品与读取服务端牌面事实。

repair 场景覆盖：金镐拒绝钻石矿、铜镐铁矿、自动铁镐钻石、实际采集、组件/耐久实例装备和移出、精确丢弃与余量、公开 drop、容器精确转移、牌面确认及真实编辑器响应上的取消、禁止放置导航、活动挖掘取消、查询 schema，以及完整关闭重开后的容器历史。正常路径要求 Run 成功且实际后态匹配；取消要求 Run cancelled，未知效果保留。

确定性回归另外覆盖难以稳定在真实服务器安排的无回包、迟到响应、换窗、取消竞争和恢复边界；真实依赖算法在普通 Node 子进程中验证，避免 vmThreads 的 Prismarine 类缓存差异。

## 本轮验证记录

- 当前工作树：`codex/phase0-baseline`，以 d77d20f 为修复基线，已提交为 **6157834**；保留用户原有 src/agent/context.ts 修改，不更改真实 Provider/会话/认证，不删除或重置已有游戏世界。
- 工程检查：`pnpm typecheck`（含 9 条边界）、MC 显式列表 **24 文件 / 176 项**、`pnpm build` 均通过。
- 最终源码与构建产物在既有 Paper 1.21.11 build132 上串行运行，各 **15/15 PASS**。两次使用不同的独立 Temp 数据根，均包含客户端/Runtime/World 完整关闭重开后的 SQLite 历史；真实物品覆盖 max_damage=50/damage=40→剩余耐久10、拒绝 minDurability=100，以及 max_stack_size=16 的精确移出与余量返回。

| 最终运行 | 日志 | 独立数据根 |
|---|---|---|
| 源码 `pnpm dev:mc:repair` | `C:/Users/34150/AppData/Local/Temp/uina-mc-repair-source-final.log` | `C:/Users/34150/AppData/Local/Temp/uina-mc-repair-c9rHeq` |
| 构建产物 `node dist/.uina/worlds/minecraft/dev/repair.js` | `C:/Users/34150/AppData/Local/Temp/uina-mc-repair-dist-final.log` | `C:/Users/34150/AppData/Local/Temp/uina-mc-repair-sy7RZb` |

首轮曾 **13/15**：容器动作被 Goto 的欧氏完成复查误拒，历史为空是继发失败；为 GoalNear/nodeGap 不一致增加真实依赖回归，先失败再修复。最终通过记录为上表两次，不将首轮记为全过。

验收结束后，本轮启动的开发服通过游戏内 `/stop` 正常关闭；Java 启动会话 exit 0，25565 已无监听。测试区与独立数据根保留，不删除既有世界。

普通 Node 子进程中的依赖算法和临时 SQLite 回归是对应边界的证据；不替代真服。未复跑的旧 I1/K1/容器脚本不沿用其历史 PASS 作为本轮现场结论；本轮不连接真实模型，不声称其他 Minecraft 版本已支持。
