# Minecraft 能力面详细设计

> 2026-10-18 · 取代 `program.md` §3.4 的能力目录。程序语言、执行域、库仍以 `program.md` 为准；本文只定义**模型每天要碰的那一层**。

## 0. 这份文档裁决什么

程序怎么跑已经定了（单文件、`async function(mc, input)`、`mc.call`/`mc.read`、worker + QuickJS）。剩下的是：这两个入口后面有哪些名字，每个名字收什么、给什么、失败成什么样。

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
| 帮我做到 | 走到那、挖 16 个木头、把房子盖起来 | 37 个动作 | `mc.call` |
| 到底行不行、要多少料 | 到得了吗、料够吗、会不会挡路 | `route.plan` `build.plan` `recipe` | `mc.read` |

第四类是本文相对旧目录新增的。模型最贵的一次错误是"开工以后才发现缺 3 个木板或到不了"，而修正它的代价是整段程序重写。所以每个重动作都有一个只读的试算孪生体，且两者共享同一份几何/寻路/配方代码——试算说的和真跑的一定一致。

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
3. **37 个动作不等于 37 套算法。** 能力面对模型是并列的动词，对内是四个家族里的一组普通函数：`collect` 复用挖掘与寻路，`build` 复用放置与世界读，`fight` 复用攻击与移动，`transit` 复用 `goto`。判据只有一条——**模型需要分辨的行为差异**才允许成为新动词（比如 `mine` 与 `collect` 的差别是"一格"与"够数"，`place` 与 `build` 的差别是"一格"与"按图"）。同义动词（`journey`/`travel`/`transport`）永远不加，它们只增加选择成本。

### 1.4 七条设计律

| | 律 | 落地 |
|---|---|---|
| L1 | 名字扁平、单词、可猜 | `collect` `goto` `build`，不加 `dig.`/`move.` 前缀 |
| L2 | 参数可省 | 位置、数量、工具、工作站、燃料都有默认值，常见任务零坐标 |
| L3 | 结果可数 | 返回实测数字与 `remaining`，不返回布尔 |
| L4 | 失败可分支 | 13 个 code + `hint` + `progress` + `effects`，永不用 message 分支 |
| L5 | 部分完成不是失败 | 失败带已完成的量与剩余清单，程序接着做；**没有 resume 句柄** |
| L6 | 只有世界侧的等待是异步的 | 烧炼/作物可以 `wait:false`；身体动作一律同步返回 |
| L7 | 意图冻结，世界动态 | 派发前固定输入、默认值、能力版本；执行期间持续观察世界并重规划 |

L5 值得解释：给动作设计"句柄 + 恢复"看起来强大，实际是最贵的一层状态——句柄会过期、会与身体所有权纠缠、要在程序退出后清理。而领域值里带 `remaining` 已经够程序重试：少 5 个就再调一次 `collect(..., 5)`。**用数据表达部分完成，不用会话表达。**

L7 要划清三种冻结（细节见 §2.13）：**提交的是意图**（Run 的输入与约束，受理时固定）、**派发的是调用**（参数、默认值、解析到的能力版本，第一个副作用前固定，并记进 `CallRecord`）、**执行的是算法**（路径、目标选择、走位，随世界持续更新）。"目的地不变、路线可变"——把这三层混成"提交时冻结一切"，会让 `goto` 拿着一张过期地图走到死。

## 2. 总则

### 2.1 名字与版本

- 能力名：`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$`，扁平单词；只有"读一个目标的计划"用两段（`route.plan`、`build.plan`）。
- 引用：`<name>@<major>`，例如 `collect@1`。`@` 后是正整数主版本；不兼容的参数/语义变化才升主版本，旧版本保留。
- 程序里 `mc.call`/`mc.read` 的第一个参数：**带 `@` = 能力，不带 `@` = 库里的程序名**（`program.md` §2）。模型写 `collect@1` 不会有歧义，写 `mine_iron` 是在调自己的程序。
- `describe` 收裸名（`collect`）时解析到当前主版本。

### 2.2 位置

```ts
type Pos = Vec3 | { rel: Vec3 }        // Vec3 = { x, y, z }
```

- 绝对坐标是方块坐标（整数），`y` 是脚所在方块。
- `{ rel: { x: 0, y: -1, z: 0 } }` 是"脚下一格"。相对位置在**调用发生的瞬间**求解，不是程序开头。
- 领域值里的位置一律是 `Vec3`（`position` 字段），可以直接喂回输入，不需要转换。
- 省略位置时的手边语义：`place` = 身周 3 格内可放的空位；`take`/`stow` = 16 格内最近的容器；`smelt` = 16 格内最近的炉子。

### 2.3 名字

`Name` 可以是四种写法，按顺序解析：

1. 精确 id：`oak_log`、`minecraft:iron_ore`
2. 显示名/中文名：`Oak Log`、`橡木原木`、`铁矿石`
3. 类别词：`log` `planks` `wool` `stone` `ore` `pickaxe` `sword` `food` `torch` `chest` `bed` `sand` `dirt` `glass`（首批约 40 个，见附录 B）
4. 显式标签：`#minecraft:logs`

解析失败 → `INVALID_INPUT`，`hint` 带 `candidates`（≤8 个最接近的名字）。歧义（例如 `pickaxe` 在只需要"一把镐"的位置）按"取当前可用的最好一个"处理，不报错。

`collect` 的 `item` 是**掉落物**：会反查产出它的方块（`cobblestone`→`stone`、`charcoal`→`log`）。`drop`/`give`/`equip` 的 `item` 是物品本身。

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
- **`version` 可能是 `null`**：只有真正可被观察的查询才有令牌（`self`/`inventory`/`block`/`blocks`/`region`/`entities`/`world`/`places` 八个，即 `feedback:true`）。派生计算（`route.plan`/`build.plan`/`recipe`）与静态知识（`item`）的 `version` 恒为 `null`，它们不能进 `waitForChange`——否则 World 就要为"任意派生结果的依赖变化"建立响应式依赖图。要等这些，就等它依赖的基础事实（库存、方块、世界）。
- **动作**（`mc.call`）返回领域值（普通 JSON 对象），没有包装。

共同的三条约定：

1. **数字是实测的**：`mined` 是实际破坏的方块数，`collected` 是实际进背包的数量（掉落物可能没捡到）。
2. **剩余量必给**：任何可能做不完的动作都返回 `remaining`（数量或清单）。
3. **缺省不出现**：可选字段没有就不出现，不写 `null`（`block` 查询的 `block: null` 是例外，它表达"那里是空气"）。
4. **体积有上限**：单次返回 ≤ 1 MiB；`region` 用 `palette` + 索引压缩，8192 格约 10–20 KB，而不是 8192 个重复对象。

### 2.6 失败

调用失败抛出 `CallError`，字段与 `program.md` §3.6 一致：

```ts
interface CallError extends Error {
  name: "CallError"
  code: CallFailureCode
  source: "program" | "capability" | "world" | "input" | "environment"
  message: string        // 一句话，给模型看的，含实测值
  hint?: string          // 建议；确定的修复要写成可直接抄的调用
  dispatch: "not_sent" | "sent" | "unknown"
  effects: Ref[]         // 已发生的效果记录
  progress?: Progress    // 已完成的量与阶段
  recoverable: boolean
}
```

13 个 code。`source` 是"哪一层报的"（事实），不是责任判定；`dispatch` 决定"重来安不安全"：`not_sent` 重来无害，`sent` 要先看世界，`unknown` 必须观察后再决定。

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

一个程序里同时 `Promise.all` 两个动作没有意义：身体只有一个，第二个会在身体队列里等第一个做完。这不是错误，但也不是并行——两个动作按 FIFO 顺序执行。

**要并行，就消除等待**：`smelt({wait:false})` 返回后程序继续做别的，回来再 `take`。这是唯一被支持的并发形式。

### 2.9 `withBody` 内不能用 `mc.call` 调动作

`withBody` 已经把身体交给程序做逐 tick 控制。此时用 `mc.call` 调任何需要身体的动作 → 立即抛 `BODY_SCOPE_ACTIVE`（guest 侧错误，不进段记录）。理由：一个动作的控制器和程序的手动输入会打架，且失败模式极难诊断。宁可立即报错。

确实要在持身体期间跑一个动作，只有一条路：`body.call("mine@1", {at})`——把当前 BodyScope **委托**给这次调用，本调用的句柄在委托期间挂起。这条规则对原生动作和程序**完全一样**，不因为目标是原生就自动放行（详见 `program.md` §3.3.1）。

### 2.10 感知边界

`mc.read` 的 `unknown` 与查询值里的 `scanned`/`truncated` 一起构成"我知道多少"。**找不到不等于不存在**：只代表"已加载区块里没看到"。模型据此决定是扩大范围还是换假设——这一点必须写进指南，否则它会反复重试同一个半径。

### 2.11 试算

`route.plan`、`build.plan`、`recipe` 的 `plan` 字段只读世界与背包，不写世界。它们与对应动作共享实现（同一份寻路、栅格化、配方解析），所以"试算通过"意味着"执行时不会因为几何/材料失败"，只剩世界变化的风险。

### 2.12 分层

| 层 | 内容 | 判据 |
|---|---|---|
| P0 能活 | `self inventory block blocks entities item recipe world goto mine collect craft smelt place take stow container equip eat use say attack fight` | 木→石→铁全链、箱子存取、战斗撤退 |
| P1 能建 | `build tunnel excavate route.plan build.plan region container.last follow flee surface explore drop give pickup remember forget places` | 盖房子、挖矿道、存点 |
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

## 3. 查询（13 个）

查询是 `access: "read"` 的能力：不写世界，不持身体，可以高频调用。下面写的是 `mc.read` 返回的 `value`。带“可等待”的查询有真实观察令牌（`version`），能让 `mc.waitForChange` 无漏唤醒；其余查询 `version` 恒为 `null`。

### self · `self@1`
- 输入 `{}`
- 返回 `{ place: { dimension, position }, health, maxHealth, food, saturation, oxygen, onGround, inWater, inLava, held?: { name, count, durability? }, armor: { head?, chest?, legs?, feet?, offhand? }, effects: [{ name, amplifier, seconds }], xpLevel }`
- 例：`{ place:{dimension:"overworld",position:{x:120,y:64,z:-30}}, health:18, food:17, onGround:true, held:{name:"stone_pickaxe",count:1,durability:{used:12,max:131}} }`

### inventory · `inventory@1`
- 输入 `{}`
- 返回 `{ slots:[{ slot, name, count, durability? }], counts:{ [name]: number }, usedSlots, freeSlots, held?, armor }`
- `slots` 用 mineflayer 编号：0..8 快捷栏、9..35 背包、36..44 装备。
- 例：`{ counts:{ oak_log:8, cobblestone:5, crafting_table:1 }, freeSlots:30 }`

### block · `block@1`
- 输入 `{ at: Pos }` 或 `{ below: 1..4 }`（脚下第 N 格）
- 返回 `{ block: { name, position, properties, light?, harvest? } | null }`；`null` 表示空气，未加载走 `unknown`
- `harvest` 是"以手头最好的工具能不能掉落"：`{ ok, requiredTool? }`
- 例：`{ at:{x:120,y:63,z:-30} } → { block:{ name:"stone", position:{x:120,y:63,z:-30}, harvest:{ ok:true } } }`

### blocks · `blocks@1`
- 输入 `{ name: Name, radius?: 4..64 = 32, limit?: 1..256 = 64, exclude?: [Pos] (≤32) }`
- 返回 `{ blocks:[{ position, name }], count, truncated, scanned:{ radius, chunksLoaded } }`
- 按距离排序取最近的 `limit` 个。`count` 是**已扫描范围内**的命中数（可能大于 `limit`，看 `truncated`）；`exclude` 用来跳过已经处理过的位置，避免循环里反复拿到同一块。
- 例：`{ name:"oak_log", radius:32 } → { blocks:[{position:{x:118,y:64,z:-28},name:"oak_log"}], count:23, truncated:false, scanned:{radius:32,chunksLoaded:9} }`

### region · `region@1`
- 输入 `{ from: Pos, to: Pos }`（闭区间，含两端）或 `{ at: Pos, size: Vec3 }`；体素数 ≤ **8192**（如 16×16×32）
- 返回 `{ origin: Pos, shape: [nx,ny,nz], palette: [Name], cells: [number], order: "xzy", missing: number, scanned: { chunksLoaded } }`
  - 第 0 项恒为 `"air"`；`palette[cells[i]]` 是该格的名字；**未加载的格为 `-1`**（用 `missing` 计数）
  - `order` 固定为 `x` 最快、`z` 次之、`y` 最慢：`i = (y-oy)*nx*nz + (z-oz)*nx + (x-ox)`
- 用途：读一片几何（房间形状、矿脉、天花板高度、地面平整度），给自定义判断用。**找方块用 `blocks`，读一片形状用 `region`**——两者上限不同，因为数据形态不同。
- 超过 8192 格 → `INVALID_INPUT`，`hint` 给建议切片大小；真要整栋建筑的物料与占位，用 `build.plan`/`build`，不要在程序里手拼。
- 例：`{ from:{x:0,y:63,z:0}, to:{x:7,y:65,z:7} } → { origin:{x:0,y:63,z:0}, shape:[8,3,8], palette:["air","stone","cobblestone","oak_planks"], cells:[1,1,2,…], order:"xzy", missing:0 }`

### entities · `entities@1`
- 输入 `{ radius?: 32, kind?: "hostile"|"passive"|"player"|"all", limit?: 32 }`
- 返回 `{ entities:[{ ref, name, kind, position, distance, health?, held? }], scanned:{ radius } }`
- `ref` 是稳定引用（连接+世代+网络 id），可直接传给 `attack`/`fight`/`follow`。
- 例：`{ kind:"hostile", radius:16 } → { entities:[{ref:"s3:7:1042",name:"zombie",kind:"hostile",position:{x:124,y:64,z:-25},distance:6.4}] }`

### item · `item@1`
- 输入 `{ name: Name }`
- 返回 `{ name, displayName, stackSize, tags:[string], block?: Name, tool?:{ type, tier, durability }, food?:{ hunger, saturation }, fuel?:{ ticks }, dropOf?: Name, placeAs?: Name }`
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

### places · `places@1`
- 输入 `{ kind?: "home"|"mine"|"farm"|"other", near?: number }`
- 返回 `{ places:[{ name, at, kind, note?, savedAt }] }`

### container.last · `container.last@1`
- 输入 `{ at: Pos }`
- 返回 `{ found, at?, type?, contents?: [{ slot, name, count }], counts?: { [item]: number }, observedAt?, source?: "window"|"event", complete?: boolean }`
- 返回的是**上次真实看见的内容**，不是现在的库存。只在真的打开过窗口（`container`/`take`/`stow`/`withBody` 里的窗口快照）或收到可验证的内容更新时写入；**不为维护记忆主动开箱，也不后台轮询**。
- `complete:false` 表示只看到了部分槽位（例如只看了上半个箱子）。没见过的容器 `found:false`。
- 物品转移永远重新打开并核验当前槽位——`take`/`stow` 已经这么做了；这条查询只用来做"上次那箱里有没有铁"这种判断。
- 存储复用 World 的记录（§5），不新建容器账本。
- **不可等待**：`version: null`。它记的是"上次看见的样子"，不会因为箱子被远处的人改动而变化；要确认就重新打开。

### route.plan · `route.plan@1`
- 输入 `{ to: Pos, tolerance?: 2, digThrough?: false, placeToReach?: true }`
- 返回 `{ ok, distance, steps:[{ at, action:"walk"|"dig"|"place"|"jump" }], needs:{ dig, place }, blockers:[{ at, reason }], estTimeSec }`
- **不可等待**：路径是试算结果，`version: null`；要盯路况就等 `block@1`/`blocks@1`。
- 例：`{ ok:false, distance:64, blockers:[{at:{x:130,y:64,z:-30},reason:"3 格宽岩浆"}] }`

### build.plan · `build.plan@1`
- 输入 `{ from: ExactRef, at: Pos, mirror?: "none"|"x"|"z", rotate?: 0|90|180|270 }` 或 `{ cells:[{ at, block }] }`
- 返回 `{ blueprint?: { ref, digest }, cells, need:{ [block]: number }, missing:{ [block]: number }, blocked:[{ at, by }], unreachable:[{ at }], estTicks }`
- **不可等待**：`version: null`；施工要等材料变化就等 `inventory@1`。
- `missing` 按背包 + 可合成（木板可从原木算）折算；`blocked` 是目标格已有别的方块且不可替换。
- `blueprint.ref`/`digest` 说明"规划的是哪一份内容"。把 `digest` 传给 `build` 的 `expectDigest`，就能在施工前发现蓝图被改过（`CONFLICT`），而不是默默盖出另一个房子。

## 4. 动作（37 个）

每个动作块给：签名、做什么、完成条件、返回、失败码。`P0/P1/P2` 是实施层级。

### 移动

#### goto · `goto@1` · act · P0
- 输入 `{ at: Pos, tolerance?: 1..8 = 2, digThrough?: false, placeToReach?: true, sprint?: true, maxTimeMs?: 120000 }`
- 做：**在当前维度内**寻路走过去；路上卡住会跳、绕、必要时挖一格或搭一块（由 `digThrough`/`placeToReach` 控制）。不找传送门、不换交通方式——跨维度用 `transit`。
- 完成：与 `at` 的直线距离 ≤ `tolerance`，且站在可站立方块上。
- 返回 `{ at, distance, dug, placed, ticks }`
- 失败 `UNREACHABLE`（`hint` 带 `blockers`）、`TIMEOUT`、`INTERRUPTED`

#### follow · `follow@1` · act · P1
- 输入 `{ target: Name | EntityRef, distance?: 2..8 = 3, maxTimeMs?: 120000 }`
- 做：持续跟随目标，目标停下就停在其 `distance` 外。
- 完成：目标消失/超时/被中断。
- 返回 `{ target, moved, lost?, at }`
- 失败 `NOT_FOUND`、`TIMEOUT`、`INTERRUPTED`

#### flee · `flee@1` · act · P1
- 输入 `{ from?: Name | EntityRef, distance?: 16..64 = 24, maxTimeMs?: 30000 }`
- 做：背向威胁离开到 `distance` 外；没有 `from` 时离开最近的敌对生物。
- 返回 `{ moved, distance, safe }`；失败 `NOT_FOUND`、`UNREACHABLE`、`TIMEOUT`

#### surface · `surface@1` · act · P1
- 输入 `{ maxTimeMs?: 120000 }`
- 做：从洞穴/水下回到露天且可站立的位置；会自己挖竖井或游上去。
- 返回 `{ at, escaped, reason? }`；失败 `TIMEOUT`、`UNREACHABLE`

#### explore · `explore@1` · act · P1
- 输入 `{ until: { block?: Name, biome?: string, player?: string }, direction?: "n"|"e"|"s"|"w"|"any" = "any", maxTimeMs?: 180000 }`
- 做：朝未访问过的方向走一段、扫一眼、再走；命中 `until` 即停。
- 返回 `{ found?:{ kind, at, name? }, traveled, scanned }`；未命中返回 `{ traveled }` 而不是失败。
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
- 输入 `{ at: Pos, tool?: Name, collect?: true }`
- 做：走近并破坏一格方块；自动选合适工具（有 `tool` 则用指定的）。
- 完成：该格变为空气且掉落已捡（`collect:false` 则不捡）。
- 返回 `{ broken, dropped?:{ name, count }, tool? }`
- 失败 `NOT_FOUND`（那块是空气/未加载）、`UNREACHABLE`、`MISSING_TOOL`（`hint` 带 `required`）、`TARGET_NOT_MET`（服务器拒绝，如领地保护）、`INTERRUPTED`

#### collect · `collect@1` · act · P0
- 输入 `{ item: Name, count?: 1..1024 = 1, radius?: 32, digThrough?: false, tool?: Name }`
- 做：找最近的、掉落为 `item` 的方块 → 走近 → 挖 → 捡；做完一块找下一块，直到 `count` 或没有更多。
- 完成：**已挖出** `count` 个（不是"背包里有 count 个"）。
- 返回 `{ mined, collected:{ [item]: number }, remaining, toolsUsed:[Name], stopped?: "not_found"|"inventory_full"|"unreachable" }`
- 失败 `NOT_FOUND`（附近没有；带 `scanned`）、`MISSING_TOOL`（`hint` 带 `required`，例如需要 `stone_pickaxe` 才能挖铁）、`INVENTORY_FULL`、`UNREACHABLE`、`TIMEOUT`、`INTERRUPTED`
- 例：`{ item:"oak_log", count:8 } → { mined:8, collected:{oak_log:8}, remaining:0 }`

#### tunnel · `tunnel@1` · act · P1
- 输入 `{ to: Pos, size?: "1x2"|"1x3"|"2x2"|"3x3" = "1x2", stairs?: "auto"|"never" = "auto", support?: true, maxTimeMs?: 180000 }`
- 做：挖一条到 `to` 的通道；高度差大时自动做台阶；`support` 时在头顶补支撑（防砂砾）。
- 完成：通道连通且可从起点走到终点。
- 返回 `{ dug, path:[{ at, name }], stopped?: "unbreakable" }`；失败 `UNREACHABLE`、`TIMEOUT`、`INTERRUPTED`

#### excavate · `excavate@1` · act · P1
- 输入 `{ region: { from: Pos, to: Pos }, keep?: [Name] = ["bedrock","chest","furnace","spawner"], maxTimeMs?: 300000 }`
- 做：清空长方体区域（按层，从上到下，先收容器内容）。
- 返回 `{ dug, kept:[{ at, name }], drops:{ [item]: number }, remaining:[{ at, reason }] }`
- 失败 `TIMEOUT`、`INTERRUPTED`；区域里挖不动的方块不算失败，进 `remaining`

### 建造

#### place · `place@1` · act · P0
- 输入 `{ block: Name, at?: Pos, face?: "auto"|"up"|"down"|"north"|"south"|"east"|"west", replace?: false }`
- 做：把背包里的 `block` 放到 `at`；`at` 省略时放在身周最近的空位（自己脚下不行）。`face` 是附着面。
- 完成：该格变为该方块。
- 返回 `{ at, block }`
- 失败 `MISSING_MATERIAL`（背包没有）、`CONFLICT`（已有别的方块且 `replace:false`）、`UNREACHABLE`（超出可达 4 格）、`TARGET_NOT_MET`（服务器拒绝）、`WRONG_STATE`（不能附着的面，如床上不能放火把）

#### build · `build@1` · act · P1
- 输入 `{ cells:[{ at, block }], replace?: false, maxTimeMs?: 300000 }` 或 `{ from: ExactRef, at: Pos, mirror?: "none"|"x"|"z", rotate?: 0|90|180|270, expectDigest?: Digest }`
- 做：按可达性排序放置/替换一组方块；同一格重复出现时后者胜。会自己搭脚手架（用背包里的方块）够高处，拆掉脚手架。`from` 的 ref 由 Library 解析、Construction 解码与转坐标——**能力不建第二个蓝图注册表**。
- `expectDigest` 与当前解析出的内容摘要不一致 → `CONFLICT`（`hint`：重新 `build.plan`）。这样"plan 的是这份、build 的却是另一份"不会静默发生。
- 完成：所有 `cells` 都成为目标方块，或剩下的列在 `remaining`。
- 返回 `{ placed, skipped:[{ at, reason }], remaining:[{ at, block, reason }], missing?:{ [block]: number }, scaffoldsUsed, blueprint?: { ref, digest } }`
- 失败 `MISSING_MATERIAL`（`missing` 给差额，未放置任何格）、`UNREACHABLE`（部分格不可达，进 `remaining`）、`CONFLICT`、`TIMEOUT`、`INTERRUPTED`
- 幂等：已匹配的格跳过，可直接整段重试。

### 容器

#### container · `container@1` · act · P0
- 输入 `{ at: Pos }`
- 做：走到容器旁打开，读内容，关上。这次读取会写进 `container.last`（§3）。
- 返回 `{ at, type, slots:[{ slot, name, count }], freeSlots, properties? }`
- 失败 `NOT_FOUND`（那不是容器）、`UNREACHABLE`、`WRONG_STATE`（被占用/需要权限）

#### take · `take@1` · act · P0
- 输入 `{ item?: Name, count?: number = 全部, at?: Pos }` 或 `{ all: true, at?: Pos }`
- 做：打开目标容器取出物品。`at` 省略时从 16 格内最近的容器开始找（最多查 3 个），找到有该物品的为止。
- 返回 `{ at, taken:{ [item]: number }, remaining?:{ [item]: number }, containersChecked }`
- 失败 `NOT_FOUND`（查过的容器都没有）、`INVENTORY_FULL`、`UNREACHABLE`

#### stow · `stow@1` · act · P0
- 输入 `{ item: Name, count?: number = 全部, at?: Pos }`
- 做：放进容器；`at` 省略时优先放"已经有这种物品"的最近容器。
- 返回 `{ at, stowed, left?: number }`；失败 `NOT_FOUND`（没有容器）、`WRONG_STATE`（容器满）、`UNREACHABLE`

### 物品与装备

#### equip · `equip@1` · act · P0
- 输入 `{ item: Name, slot?: "hand"|"offhand"|"head"|"chest"|"legs"|"feet" = "hand" }`
- 返回 `{ slot, item, previous? }`；失败 `MISSING_MATERIAL`、`WRONG_STATE`（该物品不能装到这个槽）

#### eat · `eat@1` · act · P0
- 输入 `{ food?: Name, until?: "full"|"count" = "full", count?: 1 }`
- 做：选最好的食物吃到饱（或吃到指定数量）。`food` 省略时按饥饿值/饱和度选。
- 返回 `{ eaten:[{ name, count }], food:{ before, after }, saturation:{ before, after } }`
- 失败 `NOT_FOUND`（没有食物）、`WRONG_STATE`（不饿）、`INTERRUPTED`

#### drop · `drop@1` · act · P1
- 输入 `{ item: Name, count?: number = 全部 }` → `{ dropped }`；失败 `NOT_FOUND`

#### give · `give@1` · act · P1
- 输入 `{ player: string, item: Name, count?: 1 }`
- 做：走到玩家旁丢给他。
- 返回 `{ given, player, at }`；失败 `NOT_FOUND`（附近没有这个玩家）、`UNREACHABLE`、`TIMEOUT`

#### pickup · `pickup@1` · act · P1
- 输入 `{ item?: Name, radius?: 4..16 = 8, maxTimeMs?: 30000 }`
- 做：把地上的掉落物走过去捡起来。
- 返回 `{ picked:{ [item]: number } }`；失败 `NOT_FOUND`、`INVENTORY_FULL`

### 制作

#### craft · `craft@1` · act · P0
- 输入 `{ item: Name, count?: 1..256 = 1, station?: "auto"|"hand"|"crafting_table" }`
- 做：查配方 → 找附近工作台（`auto` 时没有就用背包里的放一个，用完拆走）→ 摆格子 → 取产物。3x3 配方自动处理。
- 完成：背包里增加了 `count` 个该物品（多余产出也算）。
- 返回 `{ crafted, produced:{ [item]: number }, consumed:{ [item]: number }, at?: Pos }`
- 失败 `MISSING_MATERIAL`（`hint` 给差额）、`MISSING_TOOL`（需要工作台但没有也没材料做）、`INVENTORY_FULL`、`TIMEOUT`

#### smelt · `smelt@1` · act · P0
- 输入 `{ item: Name, count?: 1..256 = 1, fuel?: Name, at?: Pos, wait?: true, maxTimeMs?: 120000 }`
- 做：找/放炉子 → 装燃料与原料 → `wait` 时等完成并取出；`wait:false` 时装好就返回。
- 完成（`wait:true`）：背包里增加 `count` 个产物。
- 返回 `wait:true` → `{ produced:{ [item]: number }, consumed:{ input, fuel }, at }`；`wait:false` → `{ at, loaded:{ input, fuel, count }, readyAt, hint:"用 take@1 取" }`
- 失败 `MISSING_MATERIAL`（缺原料或燃料）、`WRONG_STATE`（炉子被占用/没有炉子且没有材料）、`TIMEOUT`、`INTERRUPTED`

#### brew · `brew@1` · act · P2
- 输入 `{ potion: string, ingredient: Name, count?: 1, at?: Pos, wait?: true }`
- 做：酿造台放水瓶/原料，等 20 秒，取出。返回 `{ produced, consumed, at }`
- 失败 `MISSING_MATERIAL`、`WRONG_STATE`、`TIMEOUT`

#### enchant · `enchant@1` · act · P2
- 输入 `{ item: Name, slot?: 1|2|3, at?: Pos }`
- 做：附魔台放物品与青金石，选第 `slot` 项。返回 `{ enchantments:[{ name, level }], cost, at }`
- 不指定具体附魔：附魔是随机的，能力只负责"执行这次选择"。定向附魔用 `anvil` 合并附魔书。
- 失败 `MISSING_MATERIAL`（青金石/等级不够）、`WRONG_STATE`（没有附魔台/书架不足）、`TIMEOUT`

#### anvil · `anvil@1` · act · P2
- 输入 `{ operation: "combine"|"repair"|"rename", base: Name, material?: Name, name?: string, at?: Pos }`
- 返回 `{ result:{ name, enchantments }, cost, at }`；失败 `MISSING_MATERIAL`、`WRONG_STATE`（等级不够）、`TARGET_NOT_MET`（不可合并）

#### grindstone · `grindstone@1` · act · P2
- 输入 `{ item: Name, at?: Pos }` → `{ repaired, removedEnchantments, xp, at }`；失败 `NOT_FOUND`、`WRONG_STATE`

### 交互与社会

#### use · `use@1` · act · P0
- 输入 `{ at?: Pos, item?: Name, entity?: Name | EntityRef, face?: Face, hand?: "main"|"off" = "main", times?: 1..16 = 1 }`
- 做：右键。目标可以是方块（`at`）、实体（`entity`）或空（用手里的东西）。同一个动作覆盖：打火石点火、桶取水、锄头翻地、种子播种、骨粉催熟、门/栅栏门开关、拉杆/按钮、床、剪刀、挤奶。
- 完成：按 (手上物品, 目标) 组合判定的效果出现（内部一张效果表，与 Driver §7 对齐）。
- 返回 `{ effect, at?, entity?, changed?: { [k]: JsonValue } }`
- 失败 `NOT_FOUND`、`UNREACHABLE`、`WRONG_STATE`（该组合没有效果）、`TARGET_NOT_MET`、`MISSING_MATERIAL`
- 容器/工作台/炉子不走这里：用 `container`/`craft`/`smelt`，它们有可验证的完成口径。

#### say · `say@1` · act · P0
- 输入 `{ text: string(1..256) }` → `{ sent }`；失败 `DISCONNECTED`

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
- 输入 `{ target?: Name | EntityRef, radius?: 8..32 = 16, stance?: "balanced"|"cautious"|"aggressive" = "balanced", weapon?: "auto"|"melee"|"ranged" = "auto", maxTimeMs?: 30000 }`
- 做：一次战斗会话：选目标 → 自动换最好的武器/盾 → 追击 → 按冷却攻击 → 走位（不站岩浆/悬崖边）→ 按 `stance` 决定进退。`weapon:"ranged"` 用弓/弩。
- `stance` 是**真实决策规则**，不是形容词：

  | stance | 接战血量 | 撤退血量 | 目标数上限 | 距离 | 远程偏好 | 逃跑方向 |
  |---|---|---|---|---|---|---|
  | `balanced` | ≥ 60% | < 40% | 2 | 2 格 | 有弓且血厚才用 | 背向最近威胁 |
  | `cautious` | ≥ 85% | < 60% | 1 | 3 格 | 优先 | 先 `surface` 再撤 |
  | `aggressive` | ≥ 35% | < 20% | 4 | 1 格 | 只对远程怪 | 不主动撤 |

  这些阈值属于 Combat 内部算法，会随实测调，不写进模型要填的参数；要更细的控制用 `body.loop`。
- 完成：目标全部死亡，或 `maxTimeMs` 到，或撤退。
- 返回 `{ kills:[{ name, drops:{ [item]: number } }], hp:{ before, after }, retreated?: "low_health"|"no_progress", stance, at }`
- 失败 `NOT_FOUND`（附近没有该类目标）、`TIMEOUT`、`INTERRUPTED`
- 注意：`retreated` 是**成功返回**的一种，不是失败——模型问的是"打完了吗"，答案可以是"我撤了"。

### 记录

#### remember · `remember@1` · act · P1
- 输入 `{ name: string(1..32), at?: Pos, kind?: "home"|"mine"|"farm"|"other" = "other", note?: string }`
- 做：把坐标写进世界记录（同名覆盖）。`at` 省略时记当前位置。
- 返回 `{ name, at, kind }`；失败 `INVALID_INPUT`（名字不合法）

#### forget · `forget@1` · act · P1
- 输入 `{ name }` → `{ removed }`；失败 `NOT_FOUND`

## 5. 记录

`remember`/`forget`/`places` 读写的是 **World 的记录**（不是程序状态、不是 Assets）：一个世界里 Uina 自己攒的地点表，跨运行、跨会话存活。这是"越玩越熟"的最小载体：家、矿口、农田、传送门。

不做**容器账本**，但保留**最后一次真实观察**（`container.last`）：它只记"哪一刻看见了什么"，由真的打开窗口写入，不为维护记忆主动开箱、不后台轮询。Cortico 式的账本（用一张"哪个箱子有什么"的表支持 `take` 不给坐标）是另一回事：它引入三份状态（表、真实内容、打开时的快照）与一套过期规则，而收益只是省一次走近。我们的做法是 `take` 自己打开最近 3 个容器找——多花 1 秒，少一个子系统，且永远不会因为过期表而搬错东西。**最后一次看见 ≠ 现在的内容**；物品转移必须重新打开核验，`container.last` 只用于"值不值得跑一趟"这种判断。

## 6. 三个剧本

### 6.1 从零到铁镐

```js
async function main(mc, input) {
  const { value: plan } = await mc.read("recipe@1", { item: "iron_pickaxe" });
  const missing = plan.plan.missing;

  if (missing.stick) await mc.call("craft@1", { item: "stick", count: missing.stick });
  if (missing.raw_iron) {
    const got = await mc.call("collect@1", { item: "raw_iron", count: missing.raw_iron, digThrough: true });
    if (got.remaining > 0) {
      await mc.decide({ reason: `只挖到 ${got.mined}/${missing.raw_iron} 个粗铁，附近没有了，要下矿还是换地方？` });
    }
  }
  if (missing.coal) await mc.call("collect@1", { item: "coal", count: missing.coal });
  await mc.call("smelt@1", { item: "raw_iron", count: missing.raw_iron, fuel: "coal" });
  await mc.call("craft@1", { item: "iron_pickaxe", count: 1 });
  return { held: (await mc.read("self@1")).value.held };
}
```

注意这段程序里没有：坐标、工作台、炉子、工具选择、格子摆放。全部由能力吸收。

### 6.2 盖一间 5×5 的木屋

```js
function hut(base) {
  const cells = [];
  for (let dx = 0; dx < 5; dx++)
    for (let dz = 0; dz < 5; dz++)
      for (let dy = 0; dy < 3; dy++) {
        const shell = dx === 0 || dx === 4 || dz === 0 || dz === 4;
        const hole = dy < 2 && (dx === 2 || dz === 2);          // 门与窗
        if (shell && !hole) cells.push({ at: { x: base.x + dx, y: base.y + dy, z: base.z + dz }, block: "oak_planks" });
        else if (!shell && dy !== 1) cells.push({ at: { x: base.x + dx, y: base.y + dy, z: base.z + dz }, block: "oak_planks" });
      }
  return cells;
}

async function main(mc, input) {
  const { position } = (await mc.read("self@1")).value.place;
  const cells = hut({ x: position.x + 2, y: position.y, z: position.z });
  const { value: plan } = await mc.read("build.plan@1", { cells });
  if (Object.keys(plan.missing).length) {
    await mc.call("collect@1", { item: "oak_log", count: Math.ceil(plan.missing.oak_planks / 4) });
    await mc.call("craft@1", { item: "oak_planks", count: plan.need.oak_planks });
  }
  const r = await mc.call("build@1", { cells });
  if (r.remaining.length) {
    await mc.decide({ reason: `还差 ${r.remaining.length} 格没放：${r.remaining[0].reason}` });
  }
  await mc.call("place@1", { block: "oak_door", at: { x: position.x + 4, y: position.y, z: position.z + 2 } });
  await mc.call("place@1", { block: "torch", at: { x: position.x + 4, y: position.y + 2, z: position.z + 2 } });
  return { placed: r.placed };
}
```

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

## 7. 一页速查

模型的上下文里始终有这一页（约 45 行），其余靠 `mc describe` 按需查。

```
你通过写程序玩 Minecraft：async function(mc, input)。
查询用 await mc.read("名字@1", 参数) → {value, version, unknown?}；动作用 await mc.call("名字@1", 参数) → 领域值。
名字带 @1 是能力，不带 @ 是库里的程序。失败抛 CallError {code, source, message, hint, dispatch, effects, progress}。

先看再做：参数不确定 → mc describe 名字；料不确定 → recipe；路不确定 → route.plan。
找方块用 blocks（有界、给 truncated）；读一片形状用 region（palette + 索引，≤8192 格）。
大工程先试算：recipe.plan / build.plan / route.plan 通过再开工。

查询  self inventory block blocks region entities item recipe world places container.last route.plan build.plan
移动  goto follow flee surface explore transit ride
采集  mine collect tunnel excavate
建造  place build
容器  container take stow
物品  equip eat drop give pickup
制作  craft smelt brew enchant anvil grindstone
交互  use say sleep trade fish lead
战斗  attack fight
记录  remember forget

四条规矩
1 能省就省：place/take/stow 不给坐标就用手边最近的；craft/smelt 自己找工作站；工具自己换。
2 看数字：collected/mined/placed/remaining 才是结果，别假设成功。
3 部分完成不是失败：e.progress 是已做的，返回值里的 remaining 是没做的；接着做剩下的，不要从头来。
4 失败按 code 分支，别看 message：
   NOT_FOUND UNREACHABLE CONFLICT WRONG_STATE → 换目标或改世界
   MISSING_MATERIAL MISSING_TOOL INVENTORY_FULL → 先补，hint 常给现成参数
   TARGET_NOT_MET → 换方法，别重试
   INTERRUPTED TIMEOUT → 看 progress 决定继续还是交还
   INVALID_INPUT → 按 hint 里的 candidates 改

坐标是 {x,y,z} 或 {rel:{x,y,z}}；名字写 oak_log / 橡木原木 / log 都行，标签写 #minecraft:logs。
意图固定、世界会变：派发后的参数不再改，但路线、目标、走位由能力按当前世界重算；看回执，别假设。
找不到不等于不存在：看 scanned 与 unknown，再决定扩大范围还是换假设。
长任务每 2-3 分钟 mc.progress 一句；要等世界用 smelt wait:false / sleep / blocks 轮询。
不要在 withBody 里用 mc.call 调需要身体的动作（改用 body.call）；不要在一个程序里并发两个动身体的调用。
```

## 8. `describe` 的输出

`mc describe`（无参数）返回能力索引：一行一个 `名字 · 一句话`，按家族分组，约 50 行——模型不需要背全部时的"目录"。

`mc describe collect` 返回单条契约，固定六行：

```
collect@1  act · P0
收集 N 个指定物品的掉落：找方块 → 走近 → 挖 → 捡，自动选工具。
输入 { item: Name, count?: 1..1024 = 1, radius?: 4..64 = 32, digThrough?: false, tool?: Name }
返回 { mined, collected: {item: n}, remaining, toolsUsed, stopped? }
失败 NOT_FOUND | MISSING_TOOL | INVENTORY_FULL | UNREACHABLE | TIMEOUT | INTERRUPTED
例 { item: "oak_log", count: 8 } → { mined: 8, collected: { oak_log: 8 }, remaining: 0 }
```

## 9. 与三份参考实现的取舍

| 机制 | Voyager | mc_claw | Cortico | 本文 |
|---|---|---|---|---|
| 组合语言 | 手写 JS（有原生 bot） | 无（HTTP 一次一个动作） | 无（声明式步骤队列） | JS + `mc.call` |
| 身体常识 | 8 个 primitive JS | 21 个动作 | 30 个 skill | 37 个动词 |
| 感知 | 完整 observation | lookAround | probe 区域 + 全图 | 13 个查询（含 `region`）+ `scanned` |
| 试算 | 无 | 无 | `mc_scout` 干跑 | `route.plan`/`build.plan`/`recipe.plan` |
| 部分完成 | 吞掉（打印聊天） | 返回消息 | 步骤结果 + 回执 | `remaining` + `progress` |
| 失败 | 文本聊天 | 规则匹配建议 | 中文回执 + 测量 | 13 码 + `hint` + `source` |
| 长任务 | 阻塞执行 | 每动作一个请求 | 队列 + 策略层 | 程序 + `runs` + `continue` |
| 常驻配置 | 无 | 无 | `mc_policy` 6 项 | 无（进程序/`policy`） |
| 世界记忆 | 无 | 经验 json | 地图/蓝图/箱子 | `places` + `container.last`（只记看见过的） |
| 冻结 | 无（代码即现场） | 每次请求即时 | 目标 + 持久策略 | 三层：Run 输入 / Call 参数 / 算法现场（§2.13） |
| 战斗风险 | 无（自写） | `fight` 固定 | 策略层 `fight` | `stance` 三档，落成具体阈值 |

取：

- **动词而不是协议**（三家一致）：模型不该写 mineflayer 调用。
- **试算先于执行**（Cortico 的 `mc_scout` 思想）：但不做"整个队列干跑"，只给三个纯读的 plan。
- **实测回执**（Cortico）：我们的返回值就是回执，`progress` 给 `runs` 看。
- **`until` 式停止条件**（Cortico）：只出现在 `collect`/`tunnel`/`explore` 的目标上，不做通用条件 DSL。

拒：

- **原生 bot 暴露**（Voyager）：能力面无法保证完成与证据，模型会写出 `bot.dig` 这种绕过一切的东西。
- **一次一个 HTTP 动作**（mc_claw）：模型被迫在两次调用之间重读世界，长任务的每一步都要在一个回合里规划。
- **技能队列 + 常驻策略**（Cortico）：队列与程序的表达能力重复；`mc_policy` 是**跨调用**的隐式状态，程序读不到也写不了，调试时看不见。等价物是：参数里给、库程序里封、`RunRequest.policy` 里给运行时看的那一份。**风险偏好做成单次调用的 `stance`，不做常驻开关**——常驻开关会悄悄改变下一次 `fight` 的语义。
- **容器账本**：见 §5。保留的只是"最后一次真实看见"。

## 10. 实施顺序与验收

### 阶段 A：P0 能活（23 个）

验收脚本（真实服务器 + 假 bot 契约测试各一份）：

1. 空手 → 8 原木 → 工作台 → 木镐 → 3 圆石 → 石镐 → 3 粗铁 → 熔炼 → 铁镐（全链不写坐标）。
2. 箱子存 24 铁锭、取 16 煤（`at` 省略，走最近容器）。
3. 三只僵尸围上来：`fight` 打完或撤退，血量不下 6。
4. 挖矿时被安全反射打断：`e.progress` 显示已挖数量，重试只补差额。
5. `fight` 三档差异可见：同场景 `cautious` 在 60% 血撤退、`aggressive` 追到 4 个目标上限；`retreated` 是成功值。

### 阶段 B：P1 能建（17 个）

6. 5×5 木屋（§6.2）：`build.plan` 缺料 → 补 → `build` 全放，含门与火把。
7. 从 y=64 挖到 y=-59 的阶梯矿道，中途不卡。
8. 洞穴里迷路 → `surface` 回到地面。
9. `remember home` 后重启进程 → `places` 仍在。
10. `region` 读 16×16×3 的房间：`palette`/`cells` 解出的方块与实测一致，未加载格计进 `missing`；8193 格报 `INVALID_INPUT` 并给切片建议。
11. `container.last`：存完东西后返回上次内容与 `observedAt`，进程重启后仍在；`take` 仍然重新打开核验，不信任该记录。
12. `build` 带 `expectDigest`：plan 后改蓝图再 build → `CONFLICT`，不会静默盖另一份。

### 阶段 C：P2 能玩（10 个）

`brew enchant anvil grindstone transit ride lead fish trade sleep`。每个都要真实服务器冒烟后冻结参数。

13. `transit` 进地狱：门被堵时 `UNREACHABLE` 的 `hint.stage` 指向 `enter` 而不是笼统的"走不到"；缺黑曜石时报 `MISSING_MATERIAL` 并给数量。

### 每条能力的契约测试（假 bot）

固定四段：参数校验（`INVALID_INPUT` 与 `candidates`）→ 成功路径的返回值形状 → 每个失败码的触发条件 → 部分完成时的 `remaining`/`progress`。与 `tests/minecraft-*.test.ts` 的 fake bot 基建共用。
### 发现质量：三条黄金查询

`describe` 不做语义检索，所以**发现的成功率取决于措辞，必须被测试锁住**。三条固定查询，同时检查"该出现的出现"与"无关的不占前排"（前排 = 返回的前 3 条）：

| 查询 | 必须出现在前排 | 不得占前排 |
|---|---|---|
| `造房子` | `build`、`build.plan`、`collect`、`craft` | `fish`、`chat`/`say`、`brew` |
| `挖矿` | `mine`、`collect`、`goto`、`equip`（按需换工具） | `sleep`、`trade`、`build` |
| `整理背包` | `container`、`take`、`stow` | `attack`、`transit`、`fish` |

验收口径：三条查询的首条命中都必须是"任务直接动词"（`build`/`mine`/`container`）；任何一条出现"必须出现的没出现"或"不得出现的占了前排"，就回去改 descriptor 的 `summary` 与 `tags`，**不引入检索框架**。约 50 个能力，人工维护标签完全划算。

## 11. 未决

已裁决的不再列（参数冻结三层见 §2.13；`region` 上限、`container.last`、`goto`/`transit` 分工、`stance` 预设、蓝图归属分别见 §3 与 §4）。剩下这些要真实服务器数据才能定：

1. **`collect` 的概率掉落**：`count` 定义为"挖出的方块数"还是"入包物品数"？现取前者；稀有掉落（小麦种子）下模型可能觉得少。
2. **自动进食是否进反射**：现在饥饿只进 `self`，由程序决定。长任务里模型可能忘记吃。
3. **`container@1` 是不是该算 act**：它短暂持身体、可能被打断。现在保留 act（有可验证的完成口径），历史读取另给 `container.last`。
4. **多人寻址**：`give`/`follow` 用玩家名，重名/离线时的行为未定。
5. **附魔的随机性**：`enchant` 只执行"选第 N 项"，定向附魔要走 `anvil` 与附魔书；这条链路是否够用要看实际。
6. **`route.plan` 的成本**：plan 要跑一次完整寻路，岩浆/水域下可能上百毫秒；是否缓存同一目标的 plan。
7. **群系/结构探测**：`explore` 的 `biome` 依赖客户端生物群系数据；`structure` 一律不支持（mineflayer 拿不到可靠结构信息）。
8. **`region` 的实测**：`xzy` 顺序、`-1` 未知格、以及 8192 格在真实区块边界上的切分体验，要跑一次矿洞才知够不够用。
9. **`stance` 阈值**：表里的 60%/40% 等是初始值，要用真实战斗（含盾、击退、苦力怕）调；调完仍不进模型参数。
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
| `take`/`stow` | NOT_FOUND INVENTORY_FULL WRONG_STATE UNREACHABLE |
| `build` | MISSING_MATERIAL UNREACHABLE CONFLICT TIMEOUT INTERRUPTED |
| `fight` | NOT_FOUND TIMEOUT INTERRUPTED |
| `use` | NOT_FOUND UNREACHABLE WRONG_STATE TARGET_NOT_MET MISSING_MATERIAL |
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

## 附录 C：与 `program.md` §3.4 的差异

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
