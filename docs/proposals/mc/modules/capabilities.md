# Minecraft 能力面详细设计

> 2026-10-18 · 能力签名的权威正文。程序语言、执行域、库见 `program.md`；本文定义查询与动作的输入、结果和失败。

## 0. 这份文档裁决什么

程序怎么跑已经定了（单文件、`async function main(mc, input)`、`mc.call`/`mc.read`、worker + QuickJS）。剩下的是：这两个入口后面有哪些名字，每个名字收什么、给什么、失败成什么样。

这一层决定三件事：写一段程序要查几次资料、一次跑对的概率、卡住后能不能自己爬出来。所以本文的验收标准不是"覆盖面全"，而是**给定任务，模型能不能不看文档写出大概对的程序，跑错后能不能只靠返回值改对**。

三条硬要求，贯穿全文：

- **能猜**：名字是动词，参数有合理默认，模型不必记坐标、工具、工作站。
- **能数**：结果全是可判断的数（挖了几个、还差多少），不是 `ok: true`。
- **能分**：失败是 13 个 code 之一，带 `hint` 与已完成的量，能写 `if (e.code === ...)`。

## 1. 站在模型的位置

### 1.1 一次推演：备齐工具，挖 32 个圆石

模型手上的信息：8 个原木、天快黑了、大概知道北边有山。它要做的决定有十二个：去哪棵树、砍几棵、工作台放哪、木镐做不做、石头在哪、挖到什么时候停、背包满了丢什么、怪来了打不打、天黑了回家还是继续、工具断了怎么办、镐子升级了要不要换、剩下的木头留不留。

其中只有两个是任务决定（做石镐、挖 32 个圆石），其余十个是**身体常识**——每个玩家都不假思索，但写成代码就是十段循环加错误处理。

能力面的职责就是把这十个吸收掉。判断标准只有一条：**把一条能力换回手写循环，程序会长 5 倍且更常错**；反过来，如果一条能力只是把两行循环包起来，它就不该存在。

### 1.2 模型会问的四类问题

| 类型 | 例子 | 本文的答案 | 入口 |
|---|---|---|---|
| 我现在怎么样 | 血、饿、位置、手上的东西 | `self` `inventory` `world` | `mc.read` |
| 那是什么/附近有什么 | 这块是不是矿、附近有羊吗、这玩意怎么合成 | `block` `blocks` `entities` `item` `recipe` | `mc.read` |
| 帮我做到 | 走到那、挖 16 个木头、把房子盖起来 | 35 个动作 | `mc.call` |
| 到底行不行、要多少料 | 到得了吗、料够吗、会不会挡路 | `route.plan` `build.plan` `recipe` | `mc.read` |

第四类是本文相对旧目录新增的。模型最贵的一次错误是"开工以后才发现缺 3 个木板或到不了"，而修正它的代价是整段程序重写。有实际规划价值的动作提供只读试算，复用几何/寻路/配方实现。试算说明本次已知条件下的计划和缺口，执行前仍需核验，不把计划通过说成执行保证。

### 1.3 边界：什么进能力面，什么留给程序

判据：**需要每 tick 读世界做决定的，进能力面；只需要读一次结果做判断的，留给程序。**

- 走到 `{x:120,y:64,z:-30}`：每 tick 重新寻路、绕障、跳、搭桥 → `goto`
- 挖 16 个木头：每块都要重新找、走近、挖、捡、换工具 → `collect`
- 先挖木再挖石：顺序是任务决定 → 程序
- 房子的形状：每格坐标是几何计算，正是 JS 擅长的 → 程序生成 `cells`，能力负责把 `cells` 变成方块

一句话：**能力负责"身体能不能做到"，程序负责"要不要做、先做什么"。**

由这条线得到两个反直觉结论：

1. **不做几何 DSL。** 旧方案里的 `build.shape({kind:"box",...})` 是错的——形状是任务，用 `for` 循环生成 `cells` 比记一套 shape 语法简单，也更强。能力只收 `cells`。
2. **不做技能队列。** 程序本身就是队列：一段程序跑完就是任务跑完，中途状态由 `runs` 展示，继续由 `continue` 接手。
3. **35 个动作不等于 35 套算法。** 能力面对模型是并列的动词，对内是四个家族里的一组普通函数：`collect` 复用挖掘与寻路，`build` 复用放置与世界读，`fight` 复用攻击与移动，`transit` 复用 `goto`。判据只有一条——**模型需要分辨的行为差异**才允许成为新动词（比如 `mine` 与 `collect` 的差别是"一格"与"够数"，`place` 与 `build` 的差别是"一格"与"按图"）。同义动词（`journey`/`travel`/`transport`）永远不加，它们只增加选择成本。

### 1.4 七条设计律

| | 律 | 落地 |
|---|---|---|
| L1 | 名字扁平、单词、可猜 | `collect` `goto` `build`，不加 `dig.`/`move.` 前缀 |
| L2 | 参数可省 | 位置、数量、工具、工作站、燃料都有默认值，常见任务零坐标 |
| L3 | 结果可数 | 返回实测数字与 `remaining`，不返回布尔 |
| L4 | 失败可分支 | 13 个 code + `hint` + `progress` + `effects`，永不用 message 分支 |
| L5 | 目标与会话分清 | 目标型调用未满足则抛稳定领域错误，progress 保留真实完成量和剩余；会话型调用返回 ended；没有 resume 句柄 |
| L6 | await 等待声明完成范围 | 所有程序入口均为 Promise；身体动作不另返后台句柄，烧炼等世界过程可 wait:false 装料后返回 |
| L7 | 意图冻结，世界动态 | 派发前固定输入、默认值、能力版本；执行期间持续观察世界并重规划 |

L5 值得解释：给动作设计"句柄 + 恢复"看起来强大，实际是最贵的一层状态——句柄会过期、会与身体所有权纠缠、要在程序退出后清理。而领域值里带 `remaining` 已经够程序重试：少 5 个就再调一次 `collect(..., 5)`。**用数据表达部分完成，不用会话表达。**

L7 要划清三种冻结（细节见 §2.13）：**提交的是意图**（Run 的输入与约束，受理时固定）、**派发的是调用**（参数、默认值、解析到的能力版本，第一个副作用前固定，并记进 `CallRecord`）、**执行的是算法**（路径、目标选择、走位，随世界持续更新）。"目的地不变、路线可变"——把这三层混成"提交时冻结一切"，会让 `goto` 拿着一张过期地图走到死。

## 2. 总则

### 2.1 名字与版本

- 能力名：`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$`，扁平单词；只有"读一个目标的计划"用两段（`route.plan`、`build.plan`）。
- 引用：`<name>@<major>`，例如 `collect@1`。`@` 后是正整数主版本；不兼容的参数/语义变化才升主版本，旧版本保留。
- 程序里 `mc.call`/`mc.read` 的第一个参数：**带 `@` = 能力，不带 `@` = 库里的程序名**（Program §3.3）。模型写 `collect@1` 不会有歧义，写 `mine_iron` 是在调自己的程序。
- `describe` 收裸名（`collect`）时解析到当前主版本。

### 2.2 位置、方块与精确物品

```ts
type Pos = PointTarget | {rel: Vec3};       // 连续坐标目标，PointTarget 见 public-api
type GridPos = BlockPos | {rel: Vec3};      // 整数方块格，含 rel 时各分量也须为整数
interface MoveTargetRequest {
  at: Pos; tolerance?: number; digThrough?: boolean; placeToReach?: boolean; sprint?: boolean;
}
type GotoInput = MoveTargetRequest & {maxTimeMs?: number};
type BuildTargetRequest = {replace?: boolean} & (
  | {cells: {at: GridPos; block: BlockSpec}[]; from?: never; at?: never;
      mirror?: never; rotate?: never; airPolicy?: never; expectDigest?: never}
  | {from: BlueprintRef; at: GridPos; mirror?: "none"|"x"|"z"; rotate?: 0|90|180|270;
      airPolicy?: "set_air"|"preserve";
      expectDigest?: string; cells?: never}
);
type BuildInput = BuildTargetRequest & {maxTimeMs?: number};
type TransferEndpoint = GridPos | EntityRef | "nearest";
type TransferInput = (
  | {from: TransferEndpoint; to?: never}
  | {to: TransferEndpoint; from?: never}
) & (
  | {item: string | ItemSelector; count?: number; all?: never}
  | {all: true; item?: never; count?: never}
);
interface DropInput {item: string | ItemSelector; count?: number; toward?: string | EntityRef}
```

移动/实体位置可为小数；block/mine/place/build.cells/region/excavate 使用 GridPos，绝对坐标不隐式 floor。程序从 self 位置生成格子时显式 Math.floor；GridPos 的 rel 以当前脚所在整数格为原点再加整数偏移，连续 Pos 的 rel 则以当前位置为原点。相对目标在本次调用前解析并记录实际坐标，执行中的寻路仍可更新；持久地点用 `{position, dimension}`，World 分区补 world/worldRevision。不能把旧维度历史地点简化成三个数后在当前维度执行。

放置目标使用 public-api 的 BlockSpec：字符串仅约束方块名，对象 `{name, properties?}` 约束指定状态（如 facing/half/waterlogged），未指定状态不构成完成条件。能力选择可行的站位/交互面，再核验声明状态；明确状态做不到则报错，不静默退化成默认状态。block/region 的输出保留实际 BlockStateValue，可按目标字段比较。

装备、消耗、存取/丢弃物品的 item/tool/food 等选择子接受 `Name | ItemSelector`。精确 components、minDurability 与 substitutions 复用共享合同，读取槽位保留组件和耐久。字符串仍走 Name 解析，不会要求常见调用填写实例字段。

省略位置的便捷规则沿用：place 在身周 3 格内选可放空位，transfer 的 nearest 在 16 格内选容器，smelt 在 16 格内选炉子；实际选择、默认值和约束在派发前记录。

### 2.3 名字

`Name` 可以是四种写法，按顺序解析：

1. 精确 id：`oak_log`、`minecraft:iron_ore`
2. 显示名/中文名：`Oak Log`、`橡木原木`、`铁矿石`
3. 类别词：`log` `planks` `wool` `stone` `ore` `pickaxe` `sword` `food` `torch` `chest` `bed` `sand` `dirt` `glass`（首批约 40 个，见附录 B）
4. 显式标签：`#minecraft:logs`

解析失败 → `INVALID_INPUT`，`hint` 带 `candidates`（≤8 个最接近的名字）。歧义（例如 `pickaxe` 在只需要"一把镐"的位置）按"取当前可用的最好一个"处理，不报错。

`collect` 的 `item` 是**掉落物**：会反查产出它的方块（`cobblestone`→`stone`；charcoal 没有直接方块掉落，须由程序组织熔炼）。`drop`/`equip` 的 `item` 是物品本身。

### 2.4 数量与时间

| 参数 | 范围 | 默认 |
|---|---|---|
| `count` | 1..1024 | 大多是 1 |
| `limit`（`blocks`） | 1..256 | 64 |
| `region` 体素 | 1..8192 格 | — |
| `build.cells` | 1..512 格 | — |
| `excavate` | 1..4096 格 | — |
| `radius` | 4..64 | 32（查询）/ 8（`pickup`） |
| `maxTimeMs` | 1000..600000 | 按能力给（`goto` 120s、`collect` 180s、`build` 300s、`fight` 30s） |

超过 `maxTimeMs` → `TIMEOUT`，带已完成的量与 `progress`。

### 2.5 返回

- **查询**（`mc.read`）返回 `{ value, version, unknown? }`：`value` 是领域值，`version` 是宿主的观察令牌（程序原样回传，不解释），`unknown` 只在有未知时出现（`chunk_unloaded`、`not_connected`、`stale`）。本文 §3 各条的"返回"写的是 `value` 的形状。
- **`version` 可能是 `null`**：只有声明可观察的查询才有令牌（`self`/`inventory`/`block`/`blocks`/`region`/`entities`/`players`/`world`/`places` 及有固定 after、已读完当前窗口的 `events`，即 `watchable:true`；feedback 单独表示能否快速采样）。派生计算（`route.plan`/`build.plan`/`recipe`）、静态知识（`item`）与历史视图（`container.last`）的 `version` 恒为 `null`，它们与 `map` 都不能进 `waitUntil`——否则 World 就要为"任意派生结果的依赖变化"建立响应式依赖图。要等这些，就等它依赖的基础事实（库存、方块、世界）。
- **动作**（`mc.call`）返回领域值（普通 JSON 对象），没有包装。

共同的三条约定：

1. **数字是实测的**：`mined` 是实际破坏的方块数，`collected` 是实际进背包的数量（掉落物可能没捡到）。
2. **进度可继续**：目标型调用不足时抛领域错误，progress 包含正常结果同名的完成量与 remaining；成功 remaining 为 0/空清单。会话型调用使用明确 ended，不把撤退、失联和击杀混在一起。
3. **空值按合同**：可选且不适用的字段省略；schema 明确声明的未知/不可得字段使用 null 并给 unknown。不能将未知名单、牌面、地图或状态效果变成空集合。
4. **体积有上限**：单次返回 ≤ 1 MiB；`region` 用 `palette` + 索引压缩，8192 格约 10–20 KB，而不是 8192 个重复对象。

### 2.6 失败

调用失败抛出 CallError，共享字段由 public-api §2 的 CallFailure 唯一定义；领域错误只收紧 code：

```ts
type CallFailureCode = "NOT_FOUND"|"UNREACHABLE"|"MISSING_MATERIAL"|"MISSING_TOOL"
  |"INVENTORY_FULL"|"CONFLICT"|"WRONG_STATE"|"TARGET_NOT_MET"|"INTERRUPTED"
  |"TIMEOUT"|"INVALID_INPUT"|"INTERNAL"|"DISCONNECTED";
interface CallError extends CallFailure {name: "CallError"; code: CallFailureCode}

```

13 个动作领域 code；查询的 STORE_UNAVAILABLE/SNAPSHOT_EXPIRED 等沿 World 合同，不改成 NOT_FOUND。`source` 是"哪一层报的"（事实），不是责任判定；`dispatch` 决定"重来安不安全"：`not_sent` 重来无害，`sent` 要先看世界，`unknown` 必须观察后再决定。

| code | 含义 | 典型 source | 模型该做什么 |
|---|---|---|---|
| `NOT_FOUND` | 目标不存在 | world | 换目标/扩大范围；`scanned` 说明看过多大 |
| `UNREACHABLE` | 存在但到不了 | world | 换路线（`digThrough`）、换目标 |
| `MISSING_MATERIAL` | 缺材料 | world | 先补；`hint` 给差额 |
| `MISSING_TOOL` | 缺工具/工具不够级 | world | 先做工具；`hint` 给最低要求 |
| `INVENTORY_FULL` | 背包满 | world | 丢/存/合成掉一些再试 |
| `CONFLICT` | 目标被占/世界变了 | world | 重新观察再决定 |
| `WRONG_STATE` | 前置状态不成立（不是晚上、炉子被占、该物品不能装备） | world | 换时机或换对象 |
| `TARGET_NOT_MET` | 做了但没达成（服务器拒绝、方块没消失） | world | 别原样重试；换方法或放弃 |
| `INTERRUPTED` | 被打断（安全反射/stop/掉线） | environment | 看 `progress` 决定继续还是交还 |
| `TIMEOUT` | 超时 | world | 缩小目标或加时 |
| `INVALID_INPUT` | 参数错（含名字解析不到） | input | 按 `candidates`/`hint` 改参数 |
| `INTERNAL` | 能力/协议错误 | capability | 记录下来交还，别绕 |
| `DISCONNECTED` | 连接断了 | environment | 停下报告，别重试 |

失败文本是这一层的产品，写法固定（`hint` 在能确定时直接给可抄的调用）：

```
MISSING_MATERIAL: 缺 3 oak_planks（有 5）
  hint: collect@1 {item:"oak_log", count:2} 然后 craft@1 {item:"oak_planks", count:12}
UNREACHABLE: 到不了 {x:120,y:64,z:-30}，最近可达点距 14 格，中间是 3 格宽岩浆
  hint: 试 goto@1 加 placeToReach:true，或换目标
INTERRUPTED: 安全反射（脚下是岩浆）中断了 collect；已挖 12/32
  hint: 离开岩浆后 collect@1 {item:"stone", count:20}
```

`hint` 可能不准（它是建议不是判决），但**凡是修复路径确定的，都必须写成可直接抄的参数**。这条让模型的重试路径从"读代码理解为什么"降到"复制参数"。

### 2.7 中断

任何动作可能在任意位置 `INTERRUPTED`：安全反射（岩浆、溺水、坠落、低血）、`stop`、连接断开。约定：

- `effects` 与 `progress` **一定**反映中断前已发生的事，哪怕只做了一半。
- 能力自己不做回滚（回滚比重做贵），但会尽量停在"安全且连贯"的位置（手里不拿着半放的方块、窗口已关）。
- 中断后身体归属立刻回到 Runtime，程序拿到错误后还能继续跑（除非整个 run 被 stop）。

### 2.8 身体是串行的

程序根可用 Promise.all 表达独立工作。两个需要身体的调用各自按 FIFO 申请，身体部分串行；无身体查询、计算和世界等待仍可重叠。同一委托路径内不能并发竞争身体。

独立查询、计算与世界等待可以并发，只有实际身体控制互斥。smelt 自行取得身体时在世界等待前关闭窗口并退出自身 BodyScope，取成品时重新申请；接受祖先委托时只关闭自己的窗口/操作，保留祖先身体完成等待。wait:false 提供装料后立即继续的便捷方式，不是唯一并发形式。

### 2.9 身体委托与等待

withBody 拿到身体后使用 body.call 显式委托。被调程序/原生能力的普通 call 继续传播同一 BodyScope，嵌套 withBody 重入；上层写句柄暂挂，子退出不释放祖先。一次只有一条控制委托路径，竞争 BODY_BUSY。

捕获的外部 mc/ctx 不会自动升级；独立调用实际申请身体而形成自等待时 BODY_SCOPE_ACTIVE。waitUntil/sleep 在回调内也可使用，但不会释放身体或延长反馈帧/持续输入有效期。需让其他任务用身体时在 withBody 外等待；不检测任意 Promise 等待环。具体身份/并发规则以 [Program §2.2](program.md) 为准。

### 2.10 感知边界

`mc.read` 的 `unknown` 与查询值里的 `scanned`/`truncated` 一起构成"我知道多少"。**找不到不等于不存在**：只代表"已加载区块里没看到"。模型据此决定是扩大范围还是换假设——这一点必须写进指南，否则它会反复重试同一个半径。

### 2.11 试算与执行共用目标

route.plan/goto 共用 at、tolerance、digThrough、placeToReach、sprint。build.plan/build 共用目标、落点、变换、airPolicy、replace 与 expectDigest。maxTimeMs 只控制执行期限，不改变目标；规划不通过 dryRun 开关变成另一种执行模式。

计划与执行复用目标解析及领域算法，计划说明观察范围、材料缺口、冲突与估计。执行前按新现场复核；相同请求不保证世界未变，不强制引入 plan ID。recipe 返回配方与可选材料计划，仍是查询。

### 2.12 分层

| 层 | 内容 | 判据 |
|---|---|---|
| P0 能活 | `self inventory block blocks entities item recipe world events goto mine collect craft smelt place transfer container equip eat use chat attack fight` | 木→石→铁全链、箱子存取、战斗撤退 |
| P1 能建 | `build tunnel excavate route.plan build.plan region container.last follow flee surface explore drop pickup remember forget places players map` | 盖房子、挖矿道、存点、地图和玩家协作 |
| P2 能玩 | `brew enchant anvil grindstone transit ride lead fish trade sleep` | 附魔、酿造、骑乘、交易 |

P2 的契约在本文给出意图与边界，参数在实现该能力时冻结（理由见 §11）。

### 2.13 冻结：什么固定、什么在变

| 数据 | 何时固定 | 记在哪 |
|---|---|---|
| Run 的输入与策略约束 | Run 受理时 | Run 记录 / `RunSnapshot` |
| 调用的参数、默认值、解析到的能力版本 | 派发前，第一个副作用前 | `CallRecord` |
| 世界状态、路径、目标选择、走位 | **不固定**，执行期间持续观察并重规划 | 观察、回执、`progress` |

- `mc.call("goto@1", { at })` 里的 `at` 一旦派出就不会变；`tolerance`/`digThrough` 等默认值在派发时确定；解析到哪个主版本也在派发时定下（`collect@1` 不会中途换成另一套语义）。
- 但路线、绕障、挖不挖这一格、先打谁，都由能力按当前世界决定——**目的地不变，路线可变**。
- 不需要额外的参数版本系统：把最终有效输入记进 `CallRecord` 即可追溯"当时到底请求了什么"。
- 两个反例：把"配置"当隐式输入在后台改，让同一个 `goto` 的目标悄悄变（意图漂移）；或相反，派发前把整条路径算死，遇到新刷出的岩浆还照走（世界冻结）。

<a id="survival"></a>

### 2.14 生存反射

自保是领域模块中的普通判定/控制函数，复用当前事实、已有控制器与 Runtime 的 safety 资格；不新增模型工具、常驻策略字典或后台任务系统。

| 初始触发 | 必须有的事实 | 有界动作与结束条件 |
|---|---|---|
| lava | inLava=true | 离开当前接触岩浆并站稳 |
| drowning | inWater=true、oxygen≤4，当前 effects 已知且无有效水下呼吸免疫 | 游至可呼吸处；气量开始恢复且不再淹没 |
| low_health_damage | 已知 maxHealth、0<health≤maxHealth×30%，最近 2 秒确有新伤害 | 脱离已观察威胁、连续 2 秒无新伤害并站稳；不能推断伤害来源 |

低血本身、普通饥饿或附近出现怪不自动触发攻击/消耗物品。缺氧气/免疫等触发依据就报告未知，不填健康默认值。运动控制器依据已知地形避开坠落；不承诺独立反射能挽救任意已经发生的坠落。自保不自动吃珍贵食物、制作、挖路、建造或反击。

一次介入最长 10 秒；可复用现有移动/游泳算法，但不发普通长任务给另一个调度器。只有确认本行结束条件才报 safe；受阻、超时、停止、资格失效分别记录，不能把“尝试逃生”写成安全。初始阈值随介入记录固定，真实版本验收后可调整，不成为用户配置面。

兼容短动作由现有控制器协调；必须独立介入时先中断并退役冲突 BodyScope，再按同一 Runtime 门取得 safety 资格。旧调用返回 INTERRUPTED 和真实进度，父程序可在外层重新判断，不能恢复旧句柄。急停/Owner Lost/停用禁止新介入；停止和交接仍可执行。对同一未解除危险只启动一次，解除后再次出现或新的伤害证据才重新评估，避免每帧重启。

介入记录、效果归属与通知见 [Runtime §3.3.3](runtime.md#safety-intervention)。死亡使旧化身引用和在途身体失效；客户端重生属于生命周期维护，不自动重跑旧任务，也不认定库存全丢。

## 3. 查询（16 个）

查询是 `access: "read"` 的能力：不写世界，不持身体，可以高频调用。下面写的是 `mc.read` 返回的 `value`。带“可等待”的查询有真实观察令牌（`version`），能让 `mc.waitUntil` 无漏唤醒；其余查询 `version` 恒为 `null`。

### self · `self@1`
- 输入 `{}`
- 返回 public-api 的 SelfState，并从同次 inventory 采样补充 `held?:{name,count,durability?}` 与 `armor:{head?,chest?,legs?,feet?,offhand?}`。velocity 也可用于程序控制。
- health/food/maxHealth/saturation/oxygen/inWater/inLava/effects/xpLevel 不可得为 null，并在 unknown 给出字段；已知 effects=[] 才表示没有效果，health/food 缺失也不能填 0。oxygen 为 0..20，effects.seconds 是名义游戏秒数，单位与来源见 [公开类型](../public-api.md#client-facts)。inWater/inLava 取客户端物理每 tick 写入实体的判定（prediction），不由脚部方块名推导。
- 例：`{ place:{dimension:"overworld",position:{x:120,y:64,z:-30}}, health:18, food:17, onGround:true, held:{name:"stone_pickaxe",count:1,durability:{used:12,max:131}} }`

### inventory · `inventory@1`
- 输入 `{}`
- 返回 `{ slots:[{ slot, name, count, components?, durability? }], layout:{regions:[{name,slots}]}, counts:{ [name]: number }, usedSlots, freeSlots, held?, armor }`
- slots 使用当前库存窗口实际编号，另给 layout.regions；常见 Java 库存窗口为合成 0..4、护甲 5..8、背包 9..35、快捷栏 36..44、副手 45。quickBarSlot 的 0..8 只是快捷栏选择索引，不能拿来 click。版本实际布局以返回 regions 为准，物品项保留 components/durability。
- 例：`{ counts:{ oak_log:8, cobblestone:5, crafting_table:1 }, freeSlots:30 }`

### block · `block@1`
- 输入 `{ at: GridPos }` 或 `{ below: 1..4 }`（脚下第 N 格）
- 返回 `{block:{name,position,properties,light?,harvest?,sign?:SignValue|null}|null}`；外层 null 表示空气，未加载走 unknown。告示牌的正背面、颜色、发光与上蜡状态见 public-api 的 SignValue；牌面未知不当成空白。非告示牌省略 sign。
- `harvest` 是"以手头最好的工具能不能掉落"：`{ ok, requiredTool? }`
- 例：`{ at:{x:120,y:63,z:-30} } → { block:{ name:"stone", position:{x:120,y:63,z:-30}, harvest:{ ok:true } } }`

### blocks · `blocks@1`
- 输入 `{ name: Name, radius?: 4..64 = 32, limit?: 1..256 = 64, exclude?: [Pos] (≤32) }`
- 返回 `{ blocks:[{ position, name }], count, truncated, scanned:{ radius, chunksLoaded } }`
- 按距离排序取最近的 `limit` 个。`count` 是**已扫描范围内**的命中数（可能大于 `limit`，看 `truncated`）；`exclude` 用来跳过已经处理过的位置，避免循环里反复拿到同一块。
- 例：`{ name:"oak_log", radius:32 } → { blocks:[{position:{x:118,y:64,z:-28},name:"oak_log"}], count:23, truncated:false, scanned:{radius:32,chunksLoaded:9} }`

### region · `region@1`
- 输入 `{ from: GridPos, to: GridPos }`（闭区间，含两端）或 `{ at: GridPos, size: Vec3 }`；size 各分量为正整数，体素数 ≤ **8192**（如 16×16×32）
- 返回 `{ origin: Pos, shape: [nx,ny,nz], palette: [BlockStateValue], cells: [number], order: "xzy", missing: number, scanned: { chunksLoaded } }`
  - 第 0 项恒为 `{name:"air",properties:{}}`；`palette[cells[i]]` 是该格的实际方块状态；**未加载的格为 `-1`**（用 `missing` 计数）
  - `order` 固定为 `x` 最快、`z` 次之、`y` 最慢：`i = (y-oy)*nx*nz + (z-oz)*nx + (x-ox)`
- 用途：读一片几何（房间形状、矿脉、天花板高度、地面平整度），给自定义判断用。**找方块用 `blocks`，读一片形状用 `region`**——两者上限不同，因为数据形态不同。
- 超过 8192 格 → `INVALID_INPUT`，`hint` 给建议切片大小；真要整栋建筑的物料与占位，用 `build.plan`/`build`，不要在程序里手拼。
- 例：`{ from:{x:0,y:63,z:0}, to:{x:7,y:65,z:7} } → { origin:{x:0,y:63,z:0}, shape:[8,3,8], palette:[{name:"air",properties:{}},{name:"stone",properties:{}},{name:"cobblestone",properties:{}},{name:"oak_planks",properties:{}}], cells:[1,1,2,…], order:"xzy", missing:0 }`

### entities · `entities@1`
- 输入 `{ radius?: 32, kind?: "hostile"|"passive"|"player"|"all", limit?: 32 }`
- 返回 `{ entities:[{ ref, name, kind, position, distance, health?, held? }], scanned:{ radius } }`
- `ref` 是稳定引用（连接+世代+网络 id），可直接传给 `attack`/`fight`/`follow`。
- 例：`{ kind:"hostile", radius:16 } → { entities:[{ref:"s3:7:1042",name:"zombie",kind:"hostile",position:{x:124,y:64,z:-25},distance:6.4}] }`

### players · `players@1`
- 输入 `{name?:string,limit?:1..256=64}`；name 按玩家名不区分大小写精确筛选，结果按 name/uuid 稳定排序。
- 返回 `{extent:"server_listed",players:[{name,uuid,displayName,latencyMs,gameMode,tracked:{ref,position,distance}|null}],listedCount,truncated}`；listedCount 是筛选后公告名单的数量，不受 limit 截断。
- 只读取服务器实际公告的名单。离开实体跟踪范围仍可在名单里，但 tracked=null；未公告不证明离线，服务器插件隐藏的人也不凭空出现。尚未收到名单时返回部分覆盖和 unknown，不冒充空服。
- UUID 可为 null；offline 服务端提供的 UUID 仍不证明正版身份。tracked.ref 必须关联当前 EntityRef；不能将名单项直接传给 attack/follow。
- **可等待，非 feedback**：名单、关联实体出现/失效、位置及覆盖变化推进版本；不读历史或为名单主动发送 `/list`。

### item · `item@1`
- 输入 `{ name: Name }`
- 返回 `{name,displayName,stackSize,tags:[string],block?:Name,tool?:{type,tier,durability},food?:{hunger,saturation},fuel?:{ticks},placeAs?:Name,sources:ItemSource[],sourcesComplete:boolean,dataVersion:string}`。
- sources 用统一结构替代单个 dropOf：

```ts
type ItemSource =
  | {kind: "craft" | "smelt"}
  | {kind: "block"; block: string; requiredTool: string | null}
  | {kind: "entity"; entity: string}
  | {kind: "trade"; profession: string | null};
```

- 制作/熔炼的具体原料仍查 recipe；block 表示已知方块掉落，entity 表示已知实体产出，不暗示每次保证掉落，trade 不承诺当前存在相应交易。数据按实际服务端版本取自已有注册表/维护数据；缺项 sourcesComplete=false，不把空列表解释为无法获得，也不伪造掉落率或模组配方。dataVersion 标出实际采用的数据版本。
- recipe 的 plan 仍只展开 craft/smelt 和当前库存差额；采集、击杀、交易等叶子由程序依据 sources 组织。知识查询不执行行动，不新增自动科技树规划器。
- 用途：模型不确定"这东西能不能吃/当燃料/放成方块"时查一次，而不是试错。
- **不可等待**：静态知识，`version: null`。

### recipe · `recipe@1`
- 输入 `{ item: Name, count?: 1 }`
- 返回 `{ recipes:[{ station, ingredients:[{ item, count }], output:{ item, count }, fuel? }], plan?: { steps:[{ item, count, action:"craft"|"smelt", station? }], need:{ [item]: number }, have:{ [item]: number }, missing:{ [item]: number } } }`
- **不可等待**：`plan` 依赖背包，但它是派生计算，`version: null`；要等就等 `inventory@1`。
- `plan` 按当前背包实算：`need` 是总料，`have` 是现有，`missing` 是差额。多配方时取"缺得最少"的一条。
- 例：`{ item:"iron_pickaxe" } → { plan:{ steps:[{item:"iron_ingot",count:3,action:"smelt"},{item:"stick",count:2,action:"craft"},{item:"iron_pickaxe",count:1,action:"craft",station:"crafting_table"}], missing:{ raw_iron:3, coal:1 } } }`

### world · `world@1`
- 输入 `{}`
- 返回 `{ dimension, timeOfDay:"day"|"noon"|"night"|"midnight"|"dawn"|"dusk", ticks, dayCount, weather:"clear"|"rain"|"thunder", biome, difficulty, gameMode, spawn? }`

<a id="events"></a>

### events · `events@1`

```ts
type EventKind = ClientEventPayload["kind"];
type EventAfter = string; // 不透明增量位置，绑定历史分区、存储身份和 kinds；不是观察版本
type EventInput =
  | {kinds?: EventKind[]; after?: EventAfter; limit?: number; cursor?: never}
  | {cursor: string; kinds?: never; after?: never; limit?: never};
interface GameEventRecord {
  ref: Ref; receivedAt: string; dimension: string | null;
  payload: ClientEventPayload; evidence: Ref[];
}
interface EventGap { ref: Ref; reason: string; after: EventAfter | null; through: EventAfter | null }
type EventPage = {events: GameEventRecord[]; gaps: EventGap[]} & (
  | {next: string; after: null}
  | {next?: never; after: EventAfter}
);
```

- limit 缺省 50，范围 1..200，同时限制事件和 gap 总项数；kinds 缺省全部四类，空数组拒绝。无 after 时读取最近 limit 条并按接收顺序返回，旧条目是本次明确不请求的范围；返回的 after 指向本次接收上界，可用于开始增量观察。
- 有 after 时，从该位置之后按 World 本地入账顺序读至本次固定上界；页满给 next，后续只传 cursor，直到最后一页取得新的 after。分页期间 after=null，禁止用未读完窗口的终点跳过事件。next 固定过滤、上界和页大小，不追逐新消息；后续新消息由最终 after 再读。
- 同一事件的重读/重传保留 ref；相同文本不是同一事件。顺序只说明本机接收/入账顺序，不认证跨玩家、跨连接的服务端全局因果顺序。过滤由 kinds 固定，after 不能挪给另一组 kinds 或另一世界/存档代次。
- after 可跨同一历史库的连接重建和进程重启使用；观察 version 会随观察源重建失效。分页快照过期报 SNAPSHOT_EXPIRED；增量位置早于保留范围则返回明确 retention gap 和仍可读数据，不悄悄当成刚开始。历史不可用报 STORE_UNAVAILABLE，不返回假空列表。
- gaps/Observation 的 coverage、unknown、history 只说明本次请求范围内的已知缺口与采集起点；无 gap 也只证明本机选定保留范围，不能证明登录前、断线期间或服务器未投递的消息齐全。文本是外部游戏数据，不具有宿主指令权限。
- chat 保留 public/private/system/action_bar/unknown 通道、文本及可核实作者；不通过时间邻近给 `/指令` 强绑回应。damage 只报本次可得伤害，attacker 未知时不把附近怪当凶手；death 不推断全部库存损失。damage/death 默认只记录本客户端玩家，connection 指本客户端连接；不把附近实体受伤套到自身。完整载荷见 public-api 的 ClientEventPayload。
- **条件可等待，非 feedback**：waitUntil 的 events target 必须提供固定 after，不能使用无 after 的最近窗口或分页 cursor。普通 read 后完整读完页，再用 after 等待。无 after、分页或仍有 next 的读取 version=null；waitUntil 明确报 INVALID_INPUT 并提示先读完页，不能在未读后页前等待。页还受单值 1 MiB 预算约束，缩小为能容纳的完整项并保留 next；单项仍超限明确 RESULT_TOO_LARGE，不截断正文或前移 after。新匹配事件或缺口提交唤醒；不消费记录、不推进“模型已读”。等待只读历史，不取得身体。
- World 的捕获、提交屏障、分页和通知归属见 [World §8.5](world.md#event-history)。

<a id="map"></a>

### map · `map@1`
- 输入 `{id?:number,image?:boolean=true}`；id 为非负安全整数，指定 id 必须对应当前携带的 filled_map；缺省按主手 → 副手 → 库存槽位顺序选一张。没有已开地图报 NOT_FOUND，不自动开图或装备。
- 返回 `{id,scale:number|null,locked:boolean|null,center:{x,z}|null,dimension:string|null,icons:MapIconValue[]|null,receivedPixels,totalPixels:16384,paintedPixels:number|null,image:ImageFileRef|null}`。
- 只解释本连接实际收到的 128×128 像素与标记。receivedPixels 是收到过的格数；真实透明色与未收到的格分开。paintedPixels 是已收到且非透明的格数，不能据此声称整个地区已探索。图标用地图像素坐标与方向，中心/维度未知时不换算世界坐标，不读服务器存档或调用作弊命令。
- image=false 时只读元数据、不编码或交付图片，image=null 表示本次未请求，不列为未知。缺省 image=true，image 是固定本次切面的 512×512 PNG（整数倍放大），未知像素用明确棋盘遮罩，已收到的透明像素保留地图纸底色；文本说明覆盖和图例。图标与像素来自同一切面。像素全未知或编码不可用时 image=null 并给 unknown，元数据仍可用。
- 图片生成与工具交付见 [World §8.6](world.md#map-observation) 和 [Executor §2.1.1](executor.md#observation-images)。程序只取得 JSON 和文件引用；主脑 observe 通过已有图片附件读取画面，不另建视觉代理。
- **不可等待，非 feedback**：version=null。需要新画面时显式重新查询；不能为 PNG 缓存建一套响应式依赖图。

### places · `places@1`
- 输入 `{ kind?: "home"|"mine"|"farm"|"other", near?: number }`
- 返回 `{ places:[{ name, at:{position,dimension}, kind, note?, savedAt }] }`

### container.last · `container.last@1`
- 输入 `{ at: Pos }`
- 返回 `{ found, at?, type?, contents?: [{ slot, name, count }], counts?: { [item]: number }, observedAt?, source?: "window"|"event", complete?: boolean }`
- 返回的是**上次真实看见的内容**，不是现在的库存。只在真的打开过窗口（`container`/`transfer`/`withBody` 里的窗口快照）或收到可验证的内容更新时写入；**不为维护记忆主动开箱，也不后台轮询**。
- `complete:false` 表示只看到了部分槽位（例如只看了上半个箱子）。没见过的容器 `found:false`。
- 物品转移永远重新打开并核验当前槽位——`transfer` 已经这么做了；这条查询只用来做"上次那箱里有没有铁"这种判断。
- 存储复用 World 的记录（§5），不新建容器账本。
- **不可等待**：`version: null`。它记的是"上次看见的样子"，不会因为箱子被远处的人改动而变化；要确认就重新打开。

### route.plan · `route.plan@1`
- 输入 MoveTargetRequest，字段和默认值与 goto 相同；执行期限不参与计划。
- 返回 `{ ok, distance, steps:[{ at, action:"walk"|"dig"|"place"|"jump" }], needs:{ dig, place }, blockers:[{ at, reason }], estTimeSec }`
- **不可等待**：路径是试算结果，`version: null`；要盯路况就等 `block@1`/`blocks@1`。
- 例：`{ ok:false, distance:64, blockers:[{at:{x:130,y:64,z:-30},reason:"3 格宽岩浆"}] }`

### build.plan · `build.plan@1`
- 输入与 build 共用 BuildTargetRequest（下文）；可读材料与现场差异，不执行拆除、放置或开箱。
- 返回 `{blueprint?:{ref,digest}, targets, need:{[block]:number}, missing:{[block]:number}, blocked:[{at,by}], unreachable:[{at}], estTicks}`；targets 为本次规范化 set/clear/preserve/unknown 目标，保留位置、状态约束与未知原因。
- **不可等待**：`version: null`；施工要等材料变化就等 `inventory@1`。
- `missing` 是当前可直接施工的物料差额，不把“背包有原木”当作“已有木板”；可合成缺口由 recipe 查询另行说明。blocked 表示当前冲突；build 开始及每次操作前仍重新核验。
- `blueprint.ref`/`digest` 说明"规划的是哪一份内容"。把 `digest` 传给 `build` 的 `expectDigest`，就能在施工前发现蓝图被改过（`CONFLICT`），而不是默默盖出另一个房子。

## 4. 动作（35 个）

每个动作块给：签名、做什么、完成条件、返回、失败码。`P0/P1/P2` 是实施层级。

### 移动

#### goto · `goto@1` · act · P0
- 输入 GotoInput；目标字段为 MoveTargetRequest（§2.2），与 route.plan 原样复用。tolerance 缺省 2（1..8），digThrough=false、placeToReach=true、sprint=true；maxTimeMs 缺省 120000。
- 做：**在当前维度内**寻路走过去；路上卡住会跳、绕、必要时挖一格或搭一块（由 `digThrough`/`placeToReach` 控制）。不找传送门、不换交通方式——跨维度用 `transit`。
- 完成：与 `at` 的直线距离 ≤ `tolerance`，且站在可站立方块上。
- 返回 `{ at, distance, dug, placed, ticks }`
- 失败 `UNREACHABLE`（`hint` 带 `blockers`）、`TIMEOUT`、`INTERRUPTED`

#### follow · `follow@1` · act · P1
- 输入 `{ target: Name | EntityRef, distance?: 2..8 = 3, maxTimeMs?: 120000 }`
- 做：持续跟随目标，目标停下就停在其 `distance` 外。
- 会话正常结束返回 ended=target_lost/timeout；stop/安全中断抛 INTERRUPTED，不能同时将超时写成成功与失败。
- 返回 `{target, moved, ended:"target_lost"|"timeout", at}`
- 失败 `NOT_FOUND`、`INTERRUPTED`

#### flee · `flee@1` · act · P1
- 输入 `{ from?: Name | EntityRef, distance?: 16..64 = 24, maxTimeMs?: 30000 }`
- 做：背向威胁离开到 `distance` 外；没有 `from` 时离开最近的敌对生物。
- 返回 `{ moved, distance, safe }`；失败 `NOT_FOUND`、`UNREACHABLE`、`TIMEOUT`

#### surface · `surface@1` · act · P1
- 输入 `{ maxTimeMs?: 120000 }`
- 做：从洞穴/水下回到露天且可站立的位置；会自己挖竖井或游上去。
- 返回 `{ at, escaped, reason? }`；失败 `TIMEOUT`、`UNREACHABLE`

#### explore · `explore@1` · act · P1
- 输入 `{until:ExploreTarget,direction?:"n"|"e"|"s"|"w"|"any"="any",maxTimeMs?:180000}`。

```ts
type ExploreTarget =
  | {block: string; biome?: never; player?: never; entity?: never}
  | {biome: string; block?: never; player?: never; entity?: never}
  | {player: string; block?: never; biome?: never; entity?: never}
  | {entity: string | {kind: "hostile" | "passive"}; block?: never; biome?: never; player?: never};
```

- until 恰选一种目标；`{entity:"cow"}` 找指定生物，`{entity:{kind:"passive"}}` 找一类，player 仍按玩家名字匹配。不接受跨 guest 回调或任意条件 DSL。
- 做：朝未访问过的方向走一段、扫一眼、再走；命中 `until` 即停。
- 返回 `{found:{kind:"block"|"biome"|"player"|"entity",at,name,ref?:EntityRef},traveled,scanned}`；实体 ref 只在当前仍可核验跟踪代次时给出。先检查当前覆盖，再逐段移动、扫描，命中便停止本次探索控制；只读 players 中出现名字不算已找到位置。
- 未满足 until 抛 NOT_FOUND/TIMEOUT，progress 保留 traveled/scanned，不把目标未找到报告成已完成。复杂组合条件由程序组织多次短探索与查询，不在原生目标中增加逻辑表达式。
- 失败 `TIMEOUT`、`UNREACHABLE`、`INTERRUPTED`

#### transit · `transit@1` · act · P2
- 输入 `{ destination: { dimension: string, at?: Pos }, allow?: ["portal"|"minecart"|"boat"|"horse"], maxTimeMs?: 600000 }`
- 做：把"跨维度/跨交通方式"的旅行编成阶段——走 → 找或建传送门 → 进 → 换乘 → 最后一段 `goto`。阶段内部复用 `goto`，但找门、建门、验证维度切换是它自己的事。
- 完成：`self.place.dimension === destination.dimension`；给了 `at` 时还要到达容差内。
- 返回 `{ reached, dimension, at, stages: [{ kind:"goto"|"portal"|"ride"|"enter", ok, at?, reason? }] }`
- 失败 `UNREACHABLE`（`hint` 带 `stage` 与 `furthest`，说明是哪一段做不到）、`MISSING_MATERIAL`（缺建门材料）、`WRONG_STATE`（门被堵/连接异常）、`TIMEOUT`。交通方式不可用时**明确失败**，不静默退化成一段不可能的步行。
- 只此一个旅行入口：不再加 `journey`/`travel`/`transport` 这类同义 API。

#### ride · `ride@1` · act · P2
- 输入 `{ target?: Name | EntityRef, to?: Pos, off?: false }`
- 做：骑上最近的可用坐骑（船/矿车/马/猪），可选驾驶到 `to`，`off:true` 下马。
- 返回 `{ riding, mount?, at }`；失败 `NOT_FOUND`、`UNREACHABLE`、`WRONG_STATE`

### 采集

#### mine · `mine@1` · act · P0
- 输入 `{ at: GridPos, tool?: Name|ItemSelector, collect?: true }`
- 做：走近并破坏一格方块；自动选合适工具（有 `tool` 则用指定的）。
- 完成：该格变为空气且掉落已捡（`collect:false` 则不捡）。
- 返回 `{ broken, dropped?:{ name, count }, tool? }`
- 失败 `NOT_FOUND`（那块是空气/未加载）、`UNREACHABLE`、`MISSING_TOOL`（`hint` 带 `required`）、`TARGET_NOT_MET`（服务器拒绝，如领地保护）、`INTERRUPTED`

#### collect · `collect@1` · act · P0
- 输入 `{ item: Name, count?: 1..1024 = 1, radius?: 32, digThrough?: false, tool?: Name|ItemSelector }`
- 做：寻找掉落匹配 item 的方块，走近、挖掘并拾取；只负责已经可执行的采集，不为 charcoal 等自动展开科技树。
- 完成：本次新增入包的匹配物品合计至少 count；原有库存不计，破坏了但未入包不计，超额如实返回。分类选择子按实际各物品计数，acquired 为这些匹配新增数量之和。
- 返回 `{ mined, acquired, collected:{[item]:number}, remaining:0, toolsUsed:[Name] }`；mined 是实际破坏格数。
- 未满足抛 NOT_FOUND/MISSING_TOOL/INVENTORY_FULL/UNREACHABLE/TIMEOUT/INTERRUPTED，progress 为 `{mined, acquired, collected, remaining, toolsUsed}`；已有进度和效果不回滚，不再成功返回 stopped/remaining>0。
- 例：请求 8 个原木，挖 8 格但只入包 6 个 → 领域错误携带 acquired:6、remaining:2；重试明确请求剩余 2 个。

#### tunnel · `tunnel@1` · act · P1
- 输入 `{ to: Pos, size?: "1x2"|"1x3"|"2x2"|"3x3" = "1x2", stairs?: "auto"|"never" = "auto", support?: true, maxTimeMs?: 180000 }`
- 做：挖一条到 `to` 的通道；高度差大时自动做台阶；`support` 时在头顶补支撑（防砂砾）。
- 完成：通道连通且可从起点走到终点。
- 返回 `{ dug, path:[{ at, name }], stopped?: "unbreakable" }`；失败 `UNREACHABLE`、`TIMEOUT`、`INTERRUPTED`

#### excavate · `excavate@1` · act · P1
- 输入 `{ region: { from: GridPos, to: GridPos }, keep?: [Name] = ["bedrock","chest","furnace","spawner"], maxTimeMs?: 300000 }`
- 做：清空长方体区域（按层，从上到下，先收容器内容）。
- 返回 `{ dug, kept:[{ at, name }], drops:{ [item]: number }, remaining:[{ at, reason }] }`
- 失败 `TIMEOUT`、`INTERRUPTED`、`TARGET_NOT_MET`；未能清理的目标保留在 progress.remaining；keep 明确保留的方块不属于待清空目标

### 建造

<a id="construction-target"></a>

#### 共用目标与差异处理

Construction 唯一定义 Target：按整数格组成的 set（BlockSpec）、clear、preserve、unknown 目标及其范围。Library 只保存字节；原始蓝图通过明确 AirPolicy 解释后进入同一 Target。cells 是 set 目标的便捷输入，place 是单格目标，excavate 按区域和 keep 生成 clear/preserve 目标；不另造形状 DSL。

共用流程为：固定目标 → 读取现场 → 求差异/材料/冲突 → 排定操作 → 挖掘或放置 → 核验剩余差异。build.plan 只执行前半段，build 执行全部；place 保留单格默认落点/交互面约束，excavate 保留清空顺序与容器处理。它们复用普通函数，不建通用规划服务。tunnel 的连通、台阶与支撑算法仍独立，只复用实际挖放操作。

只有所有 set/clear 目标经实际核验才完成。preserve 不产生修改，unknown 不能变为拆除或被计为目标满足；未知设计需要澄清时在派发前失败，现场未知则保留缺口。修复就是同一目标对新现场重新求差异，不按旧完成量跳格。

#### place · `place@1` · act · P0
- 输入 `{ block: BlockSpec, at?: GridPos, face?: "auto"|"up"|"down"|"north"|"south"|"east"|"west", replace?: false }`
- 做：按声明方块名/状态求解有限范围的站位与交互面并放置；face 是交互约束，不是最终朝向。
- 完成：目标格的名字与所有显式 properties 匹配；未声明的状态不纳入目标。例 `{block:{name:"oak_stairs",properties:{facing:"east",half:"top"}},at:{x:1,y:64,z:2}}`。
- 返回 `{ at:{position,dimension}, block:BlockStateValue }`。
- 失败 MISSING_MATERIAL、CONFLICT、UNREACHABLE、TARGET_NOT_MET、WRONG_STATE；目标已匹配不重复消耗物品。

#### build · `build@1` · act · P1
- 输入为 BuildTargetRequest（§2.2）加可选 maxTimeMs（缺省 300000）。cells 直接声明 set 目标；from 从蓝图取得目标并按落点/变换实例化，两种来源互斥。
- Raw 还未解释且包含已知空气时必须提供 airPolicy，缺少时在派发前报 INVALID_INPUT 并给出缺失字段；已有 Target 使用其明确语义，不能用本次策略改写 preserve/unknown。expectDigest 约束实际源设计摘要。
- replace 缺省 false；只有源目标明确要求替换且 replace=true，才允许拆除与 set 冲突的现场方块。蓝图显式 clear 是声明的清空目标，不由 replace 猜出。preserve/unknown 始终按 Target 语义处理。
- 做：由 Construction 解码/变换/排序并放置；复用放置、材料与可达性算法。Raw/Target/Project、clear/preserve/unknown 及 AirPolicy 仍按 Library/Construction 合同解释，未知不自动拆除。
- expectDigest 不符当前源摘要 → CONFLICT；在途使用本次固定设计字节，不重读变更文件。
- 完成：所有声明的 set/clear 目标匹配；成功返回 `{placed, cleared, skipped, remaining:[], scaffoldsUsed, blueprint?:{ref,digest}}`。
- 未完成抛 MISSING_MATERIAL/UNREACHABLE/CONFLICT/TARGET_NOT_MET/TIMEOUT/INTERRUPTED，progress 保留 `{placed, cleared, skipped, remaining:[{at,target,reason}], missing?, scaffoldsUsed, blueprint?}`；缺料可能发生在部分施工之后，不能一概说“未放任何格”。
- 当前已匹配格跳过；重新调用时依实际现场差异计算，不把旧完成量当新现场真相。

### 容器

#### container · `container@1` · act · P0
- 输入 `{ at: GridPos }`
- 做：走到容器旁打开，读内容，关上。这次读取会写进 `container.last`（§3）。
- 返回 `{ at, type, slots:[{ slot, name, count }], freeSlots, properties? }`
- 失败 `NOT_FOUND`（那不是容器）、`UNREACHABLE`、`WRONG_STATE`（被占用/需要权限）

#### transfer · `transfer@1` · act · P0

- 输入 TransferInput：`from` / `to` 恰一，端点为容器方块格、容器 EntityRef 或 `"nearest"`；未指定的一端是自身库存。选择物品用 `{item:Name|ItemSelector, count?:1..1024}`，或 `{all:true}`，两种形式互斥。`count` 省略时转移选定源中所有匹配物品。
- `from` 表示容器 → 库存，`to` 表示库存 → 容器。当前不接受两端同时指定，不隐式开展箱到箱运输。
- 库存端点使用窗口 layout 的玩家背包/快捷栏区域，不包含光标、合成或装备专用槽；特殊槽位用显式窗口操作。
- `nearest` 在 16 格内按距离最多核验 3 个可达容器：取物选择有匹配物品的容器；存物优先已有同类且可接收的容器，再选有空位的容器。`all:true` 取物选择最近的非空容器。开始转移后固定该容器，不在部分失败后暗中换箱。
- 做：走近、开窗、根据同一槽位搬移算法选择源/目标区域、逐次核验、关闭。只复用真实窗口观察，历史记录仅帮助选候选，不作为库存证明。
- 完成：指定数量实际从源移入目标；省略 count 或 all:true 时，在首次可核验源快照固定本次清单，之后新增物品不扩大清单。源/目标的本地预测不计为已完成；无法确认的点击保留未知效果。
- 返回 `{from, to, moved:{[item]:number}, remaining:{}, containersChecked}`。from/to 为实际容器身份与 `"inventory"`，不返回 `"nearest"`。不足时抛领域错误，progress 使用相同字段，remaining 保留本次固定清单中的差额；已转移部分不回滚。
- 失败 `NOT_FOUND`（没有候选或没有匹配物品）、`MISSING_MATERIAL`（选定源不足指定数）、`INVENTORY_FULL`（目标空间不足，hint 指明哪一端）、`UNREACHABLE`、`CONFLICT`、`TARGET_NOT_MET`、`TIMEOUT`、`INTERRUPTED`。禁止把部分转移正常返回为完整目标。
- 例：`{from:"nearest",item:"coal",count:16}`；`{to:{x:10,y:64,z:20},item:"iron_ingot",count:24}`；`{to:"nearest",all:true}`。

### 物品与装备

#### equip · `equip@1` · act · P0
- 输入 EquipInput；slot 缺省 hand。

```ts
type EquipInput =
  | {item: string | ItemSelector; slot?: "hand" | "offhand" | "head" | "chest" | "legs" | "feet"}
  | {item: null; slot?: "hand" | "offhand"};
```

- item=null 腾空指定手：选择已知空快捷栏或把该物品移至可核验空槽，不隐式丢弃、占用光标或拆其他装备；无安全位置报 INVENTORY_FULL。未指定 item 仍是无效输入，不隐式取空手。
- 返回 `{slot,item,previous?}`，腾空后 item=null；失败 MISSING_MATERIAL、INVENTORY_FULL、WRONG_STATE（不能装到这个槽）。

#### eat · `eat@1` · act · P0
- 输入 `{ food?: Name|ItemSelector, until?: "full"|"count" = "full", count?: 1 }`
- 做：选最好的食物吃到饱（或吃到指定数量）。`food` 省略时按饥饿值/饱和度选。
- 返回 `{ eaten:[{ name, count }], food:{ before, after }, saturation:{ before, after } }`
- 失败 `NOT_FOUND`（没有食物）、`WRONG_STATE`（不饿）、`INTERRUPTED`

#### drop · `drop@1` · act · P1

- 输入 DropInput：`{item:Name|ItemSelector, count?:1..1024, toward?:Name|EntityRef}`；count 缺省为首次库存快照中全部匹配物品。
- 不给 toward 时原地丢弃；给出玩家/实体时走近至可投掷距离、朝向目标后丢弃。目标失踪或不可达明确失败，不改成原地丢弃。目标引用与当前位置在派发前复核。
- 完成：声明数量已从自身库存丢出；返回 `{dropped:{[item]:number}, remaining:0, at, toward?:EntityRef}`。只证明丢弃，不证明目标拾取、背包增加或交易完成。
- 部分丢弃抛错并在 progress 保留 dropped/remaining/at/toward；派发未知不自动补丢。失败 `NOT_FOUND`、`MISSING_MATERIAL`、`UNREACHABLE`、`TARGET_NOT_MET`、`TIMEOUT`、`INTERRUPTED`。

#### pickup · `pickup@1` · act · P1
- 输入 `{ item?: Name, radius?: 4..16 = 8, maxTimeMs?: 30000 }`
- 做：把地上的掉落物走过去捡起来。
- 返回 `{ picked:{ [item]: number } }`；失败 `NOT_FOUND`、`INVENTORY_FULL`

### 制作

#### craft · `craft@1` · act · P0
- 输入 `{ item: Name, count?: 1..256 = 1, station?: "auto"|"hand"|"crafting_table" }`
- 做：查配方 → 找附近工作台（`auto` 时没有就用背包里的放一个，用完拆走）→ 摆格子 → 取产物。3x3 配方自动处理。
- 完成：背包里增加了 `count` 个该物品（多余产出也算）。
- 返回 `{crafted, produced:{[item]:number}, consumed:{[item]:number}, remaining:0, at?:Pos}`；crafted 为目标物品实际新增数量，可因配方批量超额；不足抛错并带同名 progress 与 remaining。
- 失败 `MISSING_MATERIAL`（`hint` 给差额）、`MISSING_TOOL`（需要工作台但没有也没材料做）、`INVENTORY_FULL`、`TIMEOUT`

#### smelt · `smelt@1` · act · P0
- 输入 `{ item: Name, count?: 1..256 = 1, fuel?: Name, at?: Pos, wait?: true, maxTimeMs?: 120000 }`
- 做：找/放炉子 → 装燃料与原料 → `wait` 时等完成并取出；`wait:false` 时装好就返回。自行持有的身体在等待前释放，受委托时保留祖先身体；均关闭自己的窗口。计时只安排重新开炉复查，不能等待不可 watch 的 container.last 或把估计时间当成产物证明；实际取物前核验炉子和库存。
- 完成（`wait:true`）：背包里增加 `count` 个产物。
- 返回 `wait:true` → `{ produced:{ [item]: number }, consumed:{ input, fuel }, at }`；`wait:false` → `{ at, loaded:{ input, fuel, count }, readyAt, hint:"用 transfer@1 的 from 取出产物" }`
- 失败 `MISSING_MATERIAL`（缺原料或燃料）、`WRONG_STATE`（炉子被占用/没有炉子且没有材料）、`TIMEOUT`、`INTERRUPTED`

#### brew · `brew@1` · act · P2
- 输入 `{ potion: string, ingredient: Name, count?: 1, at?: Pos, wait?: true }`
- 做：酿造台放水瓶/原料，等 20 秒，取出。返回 `{ produced, consumed, at }`
- 失败 `MISSING_MATERIAL`、`WRONG_STATE`、`TIMEOUT`

#### enchant · `enchant@1` · act · P2
- 输入 `{ item: Name|ItemSelector, slot?: 1|2|3, at?: Pos }`
- 做：附魔台放物品与青金石，选第 `slot` 项。返回 `{ enchantments:[{ name, level }], cost, at }`
- 不指定具体附魔：附魔是随机的，能力只负责"执行这次选择"。定向附魔用 `anvil` 合并附魔书。
- 失败 `MISSING_MATERIAL`（青金石/等级不够）、`WRONG_STATE`（没有附魔台/书架不足）、`TIMEOUT`

#### anvil · `anvil@1` · act · P2
- 输入 `{ operation: "combine"|"repair"|"rename", base: Name, material?: Name, name?: string, at?: Pos }`
- 返回 `{ result:{ name, enchantments }, cost, at }`；失败 `MISSING_MATERIAL`、`WRONG_STATE`（等级不够）、`TARGET_NOT_MET`（不可合并）

#### grindstone · `grindstone@1` · act · P2
- 输入 `{ item: Name|ItemSelector, at?: Pos }` → `{ repaired, removedEnchantments, xp, at }`；失败 `NOT_FOUND`、`WRONG_STATE`

### 交互与社会

#### use · `use@1` · act · P0
- 输入分两种互斥形式：普通右键保持 `{at?:Pos,item?:Name,entity?:Name|EntityRef,face?:Face,hand?:"main"|"off"="main",times?:1..16=1}`；写牌面使用下面的 UseSignInput，不混用 item/entity/face/hand/times。

```ts
interface UseSignInput {
  at: GridPos; text: string; side?: "front" | "back";
  item?: never; entity?: never; face?: never; hand?: never; times?: never;
}
```

- text 按 LF 分成最多四行，缺行补空，空字符串表示清空该面；不 trim、不截字、不把字串当 JSON/命令解析。side 缺省 front；版本不支持背面时明确 WRONG_STATE，不改写正面。每行长度按实际适配版本预校验，首个上游 updateSign 路径上限是 45 UTF-16 单元；describe 发布当前有效限制。
- 写字前按牌子的实际朝向/挂载求解指定面的可站立交互位置，走近、核验当前方块/可用面/上蜡状态、用 equip(null) 腾空主手（没有安全槽位便失败，不丢物品），再用受控 body.writeSign 打开对应编辑面并提交。上蜡或无编辑资格明确失败；不自动拆牌、换牌或消耗其他物品。此过程不是 WindowSession.click。整体期限初始为 30 秒；编辑资格与提交确认各最多 2 秒，纳入整体期限且可取消，均为内部策略值。
- 做：右键。目标可以是方块（`at`）、实体（`entity`）或空（用手里的东西）。同一个动作覆盖：打火石点火、桶取水、锄头翻地、种子播种、骨粉催熟、门/栅栏门开关、拉杆/按钮、床、剪刀、挤奶。
- 完成：按 (手上物品, 目标) 组合判定的效果出现（内部一张效果表，与 Driver §7 对齐）。
- 普通右键返回 `{effect,at?,entity?,changed?:{[k]:JsonValue}}`。写牌成功返回 `{effect:"sign_written",at,side,lines:SignText,changed:boolean}`；同面已有相同且有当前服务端依据的文字可直接完成，changed=false。
- 新写入只有取得派发后同位置/同面的服务端牌面观察且四行匹配才完成（证明目标文字成立，不排除其他玩家恰好做出相同改动）；单看本地 updateSign 返回或旧缓存不算成功。明确不同报 TARGET_NOT_MET；无法确认报 TIMEOUT/INTERRUPTED 并保留 sent/unknown 效果，不能自动再写或借新快照认证原派发因果。
- 失败 NOT_FOUND、UNREACHABLE、WRONG_STATE（该组合没有效果）、TARGET_NOT_MET、MISSING_MATERIAL；写牌另可能 INVENTORY_FULL、TIMEOUT、INTERRUPTED，并保留实际效果。
- 容器/工作台/炉子不走这里：用 `container`/`craft`/`smelt`，它们有可验证的完成口径。

<a id="chat"></a>

#### chat · `chat@1` · act · P0

- 输入 `{ text: string }`；首字符是 `/` 时发送一条玩家身份的服务器指令，否则发送一条普通消息。保留原文，不自动 trim、不替换前缀；`/msg` 等私聊和插件命令也沿此入口。
- 一次调用只发送一个非空单行文本：空白、`/` 后无实际命令、换行或 NUL 在派发前报 `INVALID_INPUT`。长度按协议、适配器单次发送限制及消息/指令类别校验，describe 显示有效限制；不沿用通用 256 字符硬限，不静默截断、拆成多条或拆分指令。
- 返回 `{ sent:true, kind:"message"|"command" }`，正常完成只确认完整文本已进入当前连接的实际协议发送边界。不是“加入上游队列即成功”，也不表示玩家已读、服务器接受命令或其效果已发生。
- 不占 Body，但必须经过 Runtime 当前 act、Owner、连接和停止门。权限和命令语义由服务器决定，不提供 RCON/控制台权限，也不另建命令许可系统。
- 命令可能改变位置、维度、物品或方块；后续按服务器真实更新使观察/控制失效或重规划。该发送能力不认证这些目标；程序需要时显式读取相关世界事实。回复只按 World 历史/游标合同保存，不按任意文本匹配假装获得命令专属 ACK，未接入的回复查询/等待不得宣称可用。
- 失败 `INVALID_INPUT`、`DISCONNECTED`、`WRONG_STATE`（当前协议/签名能力不支持）及通用取消/未知派发。已发或派发不明不自动重发；用真实观察决定下一步。
- describe 的 summary/tags 覆盖聊天、私聊、服务器命令/指令，examples 同时给普通消息和 `/` 指令；不增加单独 command 能力或旧名别名。

```js
await mc.call("chat@1", {text:"我到家了"});
await mc.call("chat@1", {text:"/list"});
```

#### sleep · `sleep@1` · act · P2
- 输入 `{ at?: Pos }`
- 做：找床（或放床）并睡到天亮；会被梦魇/怪物打断。
- 返回 `{ slept, at, until:"morning" }`；失败 `NOT_FOUND`（没有床）、`WRONG_STATE`（不是晚上/有怪）、`TARGET_NOT_MET`（床被占）

#### trade · `trade@1` · act · P2
- 输入 `{ target?: EntityRef, offer?: number = 1, item?: Name }`
- 做：与村民交易，`item` 指定想买的，`offer` 是选第几个报价。
- 返回 `{ traded:[{ item, count }], cost:{ [item]: number }, at }`；失败 `NOT_FOUND`、`MISSING_MATERIAL`、`WRONG_STATE`（村民没这个报价）

#### fish · `fish@1` · act · P2
- 输入 `{ maxTimeMs?: 60000 }` → `{ caught:[{ item, count }], casts }`；失败 `MISSING_MATERIAL`（没有鱼竿）、`WRONG_STATE`（水面不对）、`TIMEOUT`

#### lead · `lead@1` · act · P2
- 输入 `{ target: EntityRef | Name, to?: Pos, tie?: false, release?: false }`
- 返回 `{ leashed, at }`；失败 `NOT_FOUND`、`MISSING_MATERIAL`（没有拴绳）、`UNREACHABLE`

### 战斗

#### attack · `attack@1` · act · P0
- 输入 `{ target: Name | EntityRef }`
- 做：走近到攻击距离，打一次（带冷却与暴击判定）。
- 返回 `{ hit, damage?, target:{ name, health? } }`；失败 `NOT_FOUND`、`UNREACHABLE`、`WRONG_STATE`（目标已死）

#### fight · `fight@1` · act · P0
- 输入 `{ target?: Name | EntityRef, radius?: 8..32 = 16, stance?: "balanced"|"cautious"|"aggressive" = "balanced", weapon?: "auto"|"melee"|"ranged" = "auto", retreatHealth?: number, maxTimeMs?: 30000 }`
- 做：一次战斗会话：选目标 → 自动换最好的武器/盾 → 追击 → 按冷却攻击 → 走位（不站岩浆/悬崖边）→ 按 `stance` 决定进退。`weapon:"ranged"` 用弓/弩。
- `stance` 是**真实决策规则**，不是形容词：

  | stance | 接战血量 | 撤退血量 | 目标数上限 | 距离 | 远程偏好 | 逃跑方向 |
  |---|---|---|---|---|---|---|
  | `balanced` | ≥ 60% | < 40% | 2 | 2 格 | 有弓且血厚才用 | 背向最近威胁 |
  | `cautious` | ≥ 85% | < 60% | 1 | 3 格 | 优先 | 先 `surface` 再撤 |
  | `aggressive` | ≥ 35% | < 20% | 4 | 1 格 | 只对远程怪 | 不主动撤 |

  stance 提供默认值；retreatHealth 是可选绝对生命值阈值（0..当前 maxHealth，0 表示不因血量主动撤退），显式给出覆盖 stance 的撤退血量规则。其他委托与急停约束仍生效；有效阈值随 CallRecord 记录。其余内部权重不逐项开放，精细控制仍可用 body.loop。
- 会话结束：目标清除、撤退、目标失去跟踪或期限到；对应 ended=targets_cleared/retreated/target_lost/timeout。期限到是本次会话结束，stop/掉线等中断仍抛错，不能把目标失踪当击杀。
- 返回 `{ended, kills:[{name,drops:{[item]:number}}], hp:{before,after}, retreated?:"low_health"|"no_progress", stance, retreatHealth, at}`；击杀/掉落仅记录可确认部分。
- 失败 `NOT_FOUND`（启动时没有目标）、`INTERRUPTED`、`DISCONNECTED`
- 注意：`retreated` 是**成功返回**的一种，不是失败——模型问的是"打完了吗"，答案可以是"我撤了"。

### 记录

#### remember · `remember@1` · act · P1
- 输入 `{ name: string(1..32), at?: Pos, kind?: "home"|"mine"|"farm"|"other" = "other", note?: string }`
- 做：把坐标写进世界记录（同名覆盖）。`at` 省略时记当前位置。
- 返回 `{name, at:{position,dimension}, kind}`；失败 `INVALID_INPUT`（名字不合法）

#### forget · `forget@1` · act · P1
- 输入 `{ name }` → `{ removed }`；失败 `NOT_FOUND`

## 5. 记录

`remember`/`forget`/`places` 读写的是 **World 的记录**（不是程序状态、不是 Library）：一个世界里 Uina 自己攒的地点表，跨运行、跨会话存活。这是"越玩越熟"的最小载体：家、矿口、农田、传送门。

容器只保存最后一次真实观察，不维护推算库存。transfer 使用历史选择候选，实际转移前重新开窗核验；没有历史时按 nearest 规则查找。

## 6. 示例流程

### 6.1 从查询配方到获得铁镐

下面是待实现的契约示例，不承诺从空背包只靠一次配方查询就自动补齐科技树。工具/炉子/材料不足会明确失败，程序或主脑据错误补齐。

```js
async function main(mc, input) {
  const {value: inv} = await mc.read("inventory@1");
  const have = inv.counts.iron_ingot ?? 0;
  const need = Math.max(0, 3 - have);
  try {
    if (need) {
      await mc.call("collect@1", {item:"raw_iron", count:need, digThrough:true});
      await mc.call("smelt@1", {item:"raw_iron", count:need, fuel:"coal"});
    }
    await mc.call("craft@1", {item:"iron_pickaxe", count:1});
  } catch (e) {
    if (!["NOT_FOUND","MISSING_TOOL","MISSING_MATERIAL"].includes(e.code)) throw e;
    mc.decide({reason:e.message, checkpoint:{goal:"iron_pickaxe", progress:e.progress ?? null}});
  }
  return {produced:"iron_pickaxe"};
}
```

该程序被别人调用时，决策请求可由父程序处理；未处理才到根。采集数量按入包算，采集目标不足抛出的 progress 仍保留实际成果。

### 6.2 按设计施工与精确状态

```js
async function main(mc, input) {
  const at = input.at; // 调用方提供带维度的整数落点，不能把 self 的小数直接当格子
  const from = {kind:"blueprint", name:input.blueprint};
  const {value: plan} = await mc.read("build.plan@1", {from, at});
  if (Object.keys(plan.missing).length || plan.blocked.length) {
    mc.decide({reason:"需要材料或现场取舍", checkpoint:{from, at, plan}});
  }
  try {
    return await mc.call("build@1", {from, at, expectDigest:plan.blueprint.digest});
  } catch (e) {
    if (!["MISSING_MATERIAL","UNREACHABLE","CONFLICT","TARGET_NOT_MET"].includes(e.code)) throw e;
    mc.decide({reason:e.message, checkpoint:{from, at, progress:e.progress ?? null}});
  }
}
```

自定义几何仍用普通 JS 生成 `{at,block}` cells，Construction 拥有施工算法。精确楼梯示例为 `await mc.call("place@1", {block:{name:"oak_stairs",properties:{facing:"east",half:"top"}},at:{x:1,y:64,z:2}})`；成功核验所声明状态，不只看名字。

### 6.3 一次失败恢复

第一次跑，`collect` 报：

```
MISSING_TOOL: 需要 stone_pickaxe 或更好（手持 wooden_pickaxe）
  hint: collect@1 {item:"cobblestone", count:3} 然后 craft@1 {item:"stone_pickaxe"}
```

程序改成：

```js
try {
  await mc.call("collect@1", { item: "raw_iron", count: 3 });
} catch (e) {
  if (e.code !== "MISSING_TOOL") throw e;
  await mc.call("collect@1", { item: "cobblestone", count: 3 });
  await mc.call("craft@1", { item: "stone_pickaxe", count: 1 });
  await mc.call("collect@1", { item: "raw_iron", count: 3 });
}
```

模型不需要知道"铁需要石镐"——错误里直接给了。这是 `hint` 存在的理由：**把知识放在出错点，而不是放在必须先读完的文档里。**

### 6.4 玩家、牌面和地图

以下只演示接口组合；成功写牌需要可达、可编辑且服务端回送牌面，地图可能只有部分覆盖。

```js
async function main(mc, input) {
  const listed = await mc.read("players@1", {name:input.player});
  const sign = await mc.call("use@1", {
    at:input.sign, side:"front", text:"仓库\n木材在左边\n矿物在右边",
  });
  const actual = await mc.read("block@1", {at:input.sign});
  const map = await mc.read("map@1", {image:false});
  return {players:listed.value, sign, actual:actual.value, map:map.value};
}
```

主脑直接取得地图画面使用 `{action:"observe",params:{selector:"map@1"}}`；JSON 中的 path 本身不是图片。输入/回复消息的完整例子见 [Program §2.4](program.md#24-等待未知与观察版本)。

## 7. 能力家族索引

模型的常驻指南唯一见 [Program 附录 A](program.md#附录-a模型的最小指南)。下表由 descriptor 生成供 describe 展开，不作为另一份常驻提示。

| 家族 | 查询或动作 |
|---|---|
| 查询 | self inventory block blocks region entities players item recipe world events map places container.last route.plan build.plan |
| 移动 | goto follow flee surface explore transit ride |
| 采集 | mine collect tunnel excavate |
| 建造 | place build |
| 容器 | container transfer |
| 物品 | equip eat drop pickup |
| 制作 | craft smelt brew enchant anvil grindstone |
| 交互 | use chat sleep trade fish lead |
| 战斗 | attack fight |
| 记录 | remember forget |

## 8. `describe` 的输出

`mc describe` 无参数返回家族概览；query 搜索覆盖能力、程序、蓝图与经验，候选标 kind/callable，具体排序与数量上限由 Library §8 定义。查询能力用 read，动作/程序用 call，蓝图/经验供读取。

`mc describe collect` 返回单条契约，下列六项齐全，另包含 kind/callable/availability；候选和详情都取同一 descriptor：

```
collect@1  kind:capability · callable:true · act · P0
收集 N 个指定物品的掉落：找方块 → 走近 → 挖 → 捡，自动选工具。
输入 { item: Name, count?: 1..1024 = 1, radius?: 4..64 = 32, digThrough?: false, tool?: Name|ItemSelector }
返回 {mined, acquired, collected:{item:n}, remaining:0, toolsUsed}；不足抛错并携带同名 progress
失败 NOT_FOUND | MISSING_TOOL | INVENTORY_FULL | UNREACHABLE | TIMEOUT | INTERRUPTED
例 await mc.call("collect@1", {item:"oak_log",count:8}); → {mined:8,acquired:8,collected:{oak_log:8},remaining:0,toolsUsed:[]}
```

## 9. 与三份参考实现的取舍

| 机制 | Voyager | mc_claw | Cortico | 本文 |
|---|---|---|---|---|
| 组合语言 | 手写 JS（有原生 bot） | 无（HTTP 一次一个动作） | 无（声明式步骤队列） | JS + `mc.call` |
| 身体常识 | primitive JS | HTTP 动作 | 声明式技能步骤 | 35 个动词 |
| 感知 | 文本 observation + 原生 API | 状态/事件/scan | 快照/probe/地图 PNG | 16 个查询（含 `events`、`players`、`map`、`region`）+ `scanned` |
| 试算 | 无 | 无 | `mc_scout` 干跑 | `route.plan`/`build.plan`（独立查询）+ `recipe@1` 的 `plan` 字段 |
| 部分完成 | 吞掉（打印聊天） | 返回消息 | 步骤结果 + 回执 | `remaining` + `progress` |
| 失败 | 文本聊天 | 规则匹配建议 | 中文回执 + 测量 | 13 码 + `hint` + `source` |
| 长任务 | 阻塞执行 | 每动作一个请求 | 队列 + 策略层 | 程序 + `runs` + `continue` |
| 常驻配置 | 无 | 无 | `mc_policy` 6 项 | 无（显式参数/程序封装） |
| 世界记忆 | 箱子最后观察 | 地标/资源/经验文件 | 路标/蓝图/箱子 | `places` + `container.last`（只记看见过的） |
| 冻结 | 无（代码即现场） | 每次请求即时 | 目标 + 持久策略 | 三层：Run 输入 / Call 参数 / 算法现场（§2.13） |
| 战斗风险 | 无（自写） | `fight` 固定 | 策略层 `fight` | `stance` 三档，落成具体阈值 |

取：

- **常用身体操作封装**：三家都提供了高层动作，但 Voyager 仍暴露原生 API。本设计使用受控动词，程序保留组合。
- **试算先于执行**（Cortico 的 `mc_scout` 思想）：但不做"整个队列干跑"，只给三个纯读的 plan。
- **实测回执**（Cortico）：我们的返回值就是回执，`progress` 给 `runs` 看。
- **`until` 式停止条件**（Cortico）：只出现在 `collect`/`tunnel`/`explore` 的目标上，不做通用条件 DSL。

拒：

- **原生 bot 暴露**（Voyager）：能力面无法保证完成与证据，模型会写出 `bot.dig` 这种绕过一切的东西。
- **一次一个 HTTP 动作**（mc_claw）：模型被迫在两次调用之间重读世界，长任务的每一步都要在一个回合里规划。
- **技能队列 + 常驻策略**（Cortico）：本设计用普通 JS 组合，不另建技能队列。风险参数随调用固定并记录，重复偏好封在库程序里，不增加独立常驻策略字典。
- **容器账本**：见 §5。保留的只是"最后一次真实看见"。

## 10. 实施顺序与验收

P0/P1/P2 是范围与优先级分组，实际依赖、可并行工作及交付顺序以 [总开发规划](../development-plan.md) 为准。以下列出应覆盖的行为，环境选择与重复检查约束统一遵守 [开发规范](../development-guide.md#5-验证选择)。

### 阶段 A：P0 能活（23 个）

优先在真实服务器完成有关场景；纯计算与难以稳定制造的边界用针对性检查补足，不要求假 Bot 与真服各写一套：

事件/感知补全先验收：查询首次同步前 self 新字段为 null/unknown；同源聊天回调不重复入账，相同文本的两个包保留两 ref；发 `/list` 后增量读到实际回应但不自动认证成功；断线/重连/重启后 after 可读，观察 version 不冒充仍有效；源缺口、分页未读及清理过期均可解释。

1. 空手 → 8 原木 → 工作台 → 木镐 → 3 圆石 → 石镐 → 3 粗铁 → 熔炼 → 铁镐（全链不写坐标）。
2. transfer 向 nearest 存 24 铁锭、从 nearest 取 16 煤；不足和目标满都返回带差额的错误。
3. 三只僵尸围上来：`fight` 打完或撤退，血量不下 6。
4. 挖矿时被安全反射打断：`e.progress` 显示已挖数量，重试只补差额。
5. `fight` 三档差异可见：同场景 `cautious` 在 60% 血撤退、`aggressive` 追到 4 个目标上限；`retreated` 是成功值。

### 阶段 B：P1 能建（18 个）

6. 5×5 木屋（§6.2）：`build.plan` 缺料 → 补 → `build` 全放，含门与火把。
7. 从 y=64 挖到 y=-59 的阶梯矿道，中途不卡。
8. 洞穴里迷路 → `surface` 回到地面。
9. `remember home` 后重启进程 → `places` 仍在。
10. `region` 读 16×16×3 的房间：`palette`/`cells` 解出的方块与实测一致，未加载格计进 `missing`；8193 格报 `INVALID_INPUT` 并给切片建议。
11. `container.last`：存完东西后返回上次内容与 `observedAt`，进程重启后仍在；`transfer` 仍然重新打开核验，不信任该记录。
12. `build` 带 `expectDigest`：plan 后改蓝图再 build → `CONFLICT`，不会静默盖另一份。
13. `explore {until:{entity:"cow"}}` 在当前区域先命中或走出新区域找到，返回实际 ref；只在玩家名单上见到名字不算找到。
14. 同一玩家离开实体跟踪范围后仍可在 players 名单里，tracked=null；未公告不推断离线。offline UUID 不认证正版。
15. 告示牌正/背面分别写读，短文本补空行、原空格保留；上蜡、超长、错误面及取消不误写，派发后无回执保留未知；block 牌面变化能唤醒等待。
16. 地图只收到一块矩形时，其他像素明确未知；图标更新不抹像素，透明色不当作未知；重连不续旧当前覆盖，中心未知不造坐标。observe 真正携带图片，guest 仍只有 JSON；图片缓存缺失与模型不支持图片均有明确呈现。

### 阶段 C：P2 能玩（10 个）

`brew enchant anvil grindstone transit ride lead fish trade sleep`。每个都要真实服务器冒烟后冻结参数。

13. `transit` 进地狱：门被堵时 `UNREACHABLE` 的 `hint.stage` 指向 `enter` 而不是笼统的"走不到"；缺黑曜石时报 `MISSING_MATERIAL` 并给数量。

### 能力合同检查

关注参数校验（INVALID_INPUT 与 candidates）、真实成功结果、声明失败条件及部分完成的 remaining/progress。参数/schema 可本地检查，游戏效果直接用真服；只有真实环境难以稳定构造的窄边界才使用测试侧替身，不建设完整 Fake Driver 或复制所有成功路径。

本轮合并的必验场景：

- transfer 两个方向使用同形结果；from/to 混用、方向缺失、all 与 item/count 混用在派发前拒绝。显式 count=16 只确认转移 10 时抛错，progress.moved=10、remaining=6；未知点击不计入 moved。
- transfer 省略 count/all:true 后源又新增物品，只处理首次固定清单；nearest 不在部分转移后暗换箱，目标满时指出哪一端。
- drop.toward 先复核当前目标再丢弃；目标离开跟踪不原地丢物，对方未拾取不能返回已接收，未知丢弃不自动重发。
- 同一 MoveTargetRequest/BuildTargetRequest 分别进入计划和执行；执行仍重验现场。place 单格、excavate 清空、build 混合 set/clear 与修复走同一差异核验，preserve/unknown 不被误拆。
### 发现质量：三条黄金查询

describe 使用文本与标签匹配。三条固定查询分别检查候选召回（前 10 条）与无关项不占前排（前 3 条）：

| 查询 | 必须出现在前 10 条 | 不得占前 3 条 |
|---|---|---|
| `造房子` | `build`、`build.plan`、`collect`、`craft` | `fish`、`chat`、`brew` |
| `挖矿` | `mine`、`collect`、`goto`、`equip`（按需换工具） | `sleep`、`trade`、`build` |
| `整理背包` | `transfer`、`container` | `attack`、`transit`、`fish` |

验收口径：三条查询的首条命中都必须是"任务直接动词"（`build`/`mine`/`transfer`）；任何一条出现"必须出现的没出现"或"不得出现的占了前排"，就回去改 descriptor 的 `summary` 与 `tags`，**不引入检索框架**。51 个能力，人工维护标签足够。

### 新增场景：生存与记录

- 空闲与长程序执行中分别触发缺氧/岩浆/低血受伤，复用同一身体仲裁；急停时不产生新的逃生、进食或攻击。
- 自保先退役旧 BodyScope，旧程序拿到真实部分进度；安全动作的 EffectOwner 为 safety，不挂到已经退出的 Call。
- 普通饥饿只供程序决定，低血而无新伤害不反复启动逃跑。危险未解除而超时只报告失败/未知，不每帧重新启动。
- 生命、气量、免疫未知不填默认；死亡中断旧化身，重生不重放采集、投料或攻击。

## 11. 未决

已裁决的不再列（参数冻结三层见 §2.13；`region` 上限、`container.last`、`goto`/`transit` 分工、`stance` 预设、蓝图归属分别见 §3 与 §4）。剩下这些要真实服务器数据才能定：

1. **概率掉落的采集策略**：count 已固定为本次新增入包数量；掉落反查、搜索效率与有限覆盖需要真实数据验证，不能退回按破坏格数完成。
2. **生存反射参数验收**：默认只处理明确紧急危险，普通饥饿由程序调用 eat；触发/预算见 §2.14，阈值是待真实环境验收的初始策略值。
3. **`container@1` 是不是该算 act**：它短暂持身体、可能被打断。现在保留 act（有可验证的完成口径），历史读取另给 `container.last`。
4. **实体寻址**：drop.toward/follow 的名字只在当前跟踪范围解析；无目标报 NOT_FOUND，多候选报 INVALID_INPUT 并给候选；不自动等待离线玩家。精确 EntityRef 仍受出现代次约束。
5. **附魔的随机性**：`enchant` 只执行"选第 N 项"，定向附魔要走 `anvil` 与附魔书；这条链路是否够用要看实际。
6. **`route.plan` 的成本**：plan 要跑一次完整寻路，岩浆/水域下可能上百毫秒；是否缓存同一目标的 plan。
7. **群系/结构探测**：`explore` 的 `biome` 依赖客户端生物群系数据；`structure` 一律不支持（mineflayer 拿不到可靠结构信息）。
8. **`region` 的实测**：`xzy` 顺序、`-1` 未知格、以及 8192 格在真实区块边界上的切分体验，要跑一次矿洞才知够不够用。
9. **`stance` 阈值**：表里的 60%/40% 等是初始值，要用真实战斗（含盾、击退、苦力怕）调；调完更新 stance 默认值；retreatHealth 显式覆盖仍保留。
10. **`transit` 的阶段集合**：`portal`/`minecart`/`boat`/`horse` 是否都有必要；建门（黑曜石/打火石）与下界坐标换算的边界要在实现时定。

## 附录 A：失败码 × 能力

| 能力 | 可能失败码 |
|---|---|
| `goto` | UNREACHABLE TIMEOUT INTERRUPTED |
| `collect` | NOT_FOUND MISSING_TOOL INVENTORY_FULL UNREACHABLE TIMEOUT INTERRUPTED |
| `mine` | NOT_FOUND UNREACHABLE MISSING_TOOL TARGET_NOT_MET INTERRUPTED |
| `place` | MISSING_MATERIAL CONFLICT UNREACHABLE TARGET_NOT_MET WRONG_STATE |
| `craft` | MISSING_MATERIAL MISSING_TOOL INVENTORY_FULL TIMEOUT |
| `smelt` | MISSING_MATERIAL WRONG_STATE TIMEOUT INTERRUPTED |
| `transfer` | NOT_FOUND MISSING_MATERIAL INVENTORY_FULL UNREACHABLE CONFLICT TARGET_NOT_MET TIMEOUT INTERRUPTED |
| `build` | MISSING_MATERIAL UNREACHABLE CONFLICT TIMEOUT INTERRUPTED |
| `fight` | NOT_FOUND INTERRUPTED DISCONNECTED |
| `use` | NOT_FOUND UNREACHABLE WRONG_STATE TARGET_NOT_MET MISSING_MATERIAL INVENTORY_FULL TIMEOUT INTERRUPTED |
| `transit` | UNREACHABLE MISSING_MATERIAL WRONG_STATE TIMEOUT |
| 其余 | 见各条 |

## 附录 B：类别词（首批）

| 类别 | 覆盖 |
|---|---|
| `log` `planks` `wool` `stone` `sand` `dirt` `glass` | 全部变体 |
| `ore` | 所有原矿方块（深层矿单独写 `deepslate_iron_ore`） |
| `pickaxe` `axe` `shovel` `hoe` `sword` | 各材质，解析到"当前可用的最好一个" |
| `food` | `minecraft:foods` 标签 |
| `torch` `chest` `bed` `boat` `door` `slab` `stairs` | 主变体优先（`oak_*`） |

解析顺序与歧义处理见 §2.3。

## 附录 C：与 2026-10-17 旧命名的差异（历史）

| 旧 | 新 | 原因 |
|---|---|---|
| `move.to@1` | `goto@1` | 扁平、更短 |
| `dig.collect@1` | `collect@1` | 同上 |
| `use@1` + `interact@1` | 合并为 `use@1` | 右键就是一个动作，效果由 (物品, 目标) 决定 |
| `world.status@1` | `world@1` | 同上 |
| `crafting.craft@2` | `craft@1` | 同上 |
| `blueprint@1` | `build@1 {from}` / `build.plan@1 {from}` | 蓝图只需要"变成方块"与"算料"两个用途 |
| 7 查询 + 10 动作 | 13 查询 + 37 动作 | 补齐建造/容器/制作/社交/记录 |
| `MISSING_MATERIALS`/`PATH_NOT_FOUND`/… | 13 码统一表 | 同一含义不许两个名字 |
