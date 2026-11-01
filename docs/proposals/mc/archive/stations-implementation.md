# 批15 实施记录：K7 专用工作站五动作（brew / enchant / anvil / grindstone / trade）

日期：2026-11-01。分支 `codex/phase0-baseline`。施工规格：development-plan §10.3（工作站 K7）、known-gaps G2/G5、capabilities.md §4 的五条合同、public-api §4.3。开工 HEAD = 批14 `868485e`。

## 交付

### 能力面 +5（14 查询 + 30 动作 = 44/51）

| 能力 | 文件 | 要点 |
|---|---|---|
| `brew@1` | `capabilities/actions/stations.ts` | 一批 ≤3 瓶（`bottle`/`ingredient`/`fuel` 区域），完成只认**瓶子的 `potion_contents` 组件变号**（不信 `properties["0"]` 归零），成品一律读回并取回背包 |
| `enchant@1` | 同上 | 先放物品再读 `properties[0..2]` 三档等级要求；缺省取"等级+青金石都够的最高档"；`selectEnchant` 后以槽内物品的 `enchantments` 组件为完成证据 |
| `anvil@1` | 同上 | combine/repair 放双输入，rename 走 `renameItem` 包；费用读 `properties["0"]`；完成 = 结果槽非空且取回 |
| `grindstone@1` | 同上 | 结果槽出现即取；`repaired` = 耐久差、`removedEnchantments` = 输入/输出组件差；`xp` 恒 null（见偏差） |
| `trade@1` | 同上 | `offers()` 读 `trade_list`，`item` 按产物匹配或 `offer` 1 基取第 N 条；付款收敛成"正好一份"后取货（见裁决） |

### G2 关闭：布局表 +1 处唯一定义（`driver/window/layout.ts`）

| 窗口类型 | 槽数 | 区域 |
|---|---|---|
| `minecraft:brewing_stand` | 41 | `bottle`(0..2)、`ingredient`(3)、`fuel`(4)、`player`(5..40) |
| `minecraft:enchantment` | 38 | `input`(0)、`lapis`(1)、`player`(2..37) |
| `minecraft:anvil` / `minecraft:grindstone` / `minecraft:merchant` | 39 | `input`(0,1)、`result`(2)、`player`(3..38) |

同一文件新增 `opensWindow(blockName)`，替换 `driver/body/session.ts` 里那份硬编码正则白名单——它原本把 `enchanting_table`/`anvil` 等全部拒之门外，是 K5 之外真正的卡点；"能开窗的方块"与"窗口布局"同住一个文件，`container@1` 的容器策略仍是能力层自己的名单。

### 窗口会话与协议窄口（contracts/body.ts、public-api §4.3 先行）

- `WindowSession` 增 4 个方法：`selectEnchant(1|2|3)`、`renameItem(name)`、`selectTrade(index)`、`offers()`。
- `driver/mineflayer/protocol.ts`：`trade_list` 捕获（`itemId` 经 `registry.itemsArray` 一次性建表解析，查不到报 `unknown` 不编名字）、三条写包 `enchant_item{windowId,enchantment: offer-1}` / `name_item{name}`（**协议不带 windowId**）/ `select_trade{slot: 报价下标}`。
- `driver/window/session.ts`：三条提交走 `commit()`——只派发、不改 revision、不做槽位预测、**不置 uncertain**；完成合同与 chat 同口径（"包已进入连接的协议发送边界"），生效与否归能力层。`offers()` 返回 Fact，未收到 `trade_list` 为 null（不冒充空报价）；换窗/关闭即作废，不跨窗口复用。
- `runtime/scoped-body.ts` 的窗口视图透传四个新方法（都过 `run()` 的串行化）。

### 共享件抽取（含既有实现收口）

| 文件 | 职责 |
|---|---|
| `capabilities/shared/workstation.ts`（新） | `resolveStation`（= 原 smelt 的 `resolveFurnace`，通用化）、`validateStation`、`withStation`（走到→开窗→断言窗口类型→force 关窗）、`withEntity`（商人）、`moveExact`（按具体槽搬，指名实例）、`trimPayment`（付款收敛）、`countInRegion`/`stackLimit`（自 smelt 上移）、`enchantmentsOf`/`customNameOf`/`potionIdOf`（只认组件，不从名字猜） |
| `capabilities/shared/observe.ts` | `checkBudget` / `waitFor` 自 `smelt.ts` 上移（前者带 `what` 参数便于诊断） |
| `contracts/knowledge.ts` | `RegistryKnowledge.enchantment(id)`：线上组件的附魔是 Holder 编号，经 `bot.registry.enchantmentsArray` 解名；未知编号报 `#<id>` |
| `driver/facts/knowledge.ts` | `entityKind` 补 `entity.type === "passive"` 分支——minecraft-data 里村民 `category: "UNKNOWN"`，漏掉这一支会让 `entities@1 {kind:"passive"}` 看不见村民，trade 的无目标路径就找不到商人 |

## 真服窄探测结论（能力代码落地前实测，Paper 1.21.11 build132）

这些事实直接决定了实现，全部来自一次性探测脚本（已删，结论留档）：

| 项 | 结论 |
|---|---|
| 窗口槽数 | 五类 41/38/39/39/39，`inventoryStart` = 5/2/3/3/3，与布局表一致 |
| 附魔台属性 | `0..2` = 三档等级要求（无书架时实测 1/6/0，第三档 0 表示该档不可用）、`3` = 随机种子；**已附魔物品三档全 0**（下一条偏差的根因） |
| `enchant_item` | 服务端接受（附魔出现在槽 0 物品组件、青金石 -1、经验 -1）；`enchantment` 是 0..2 档位下标 |
| `name_item` | 服务端接受（结果槽出现带 `custom_name` 的副本，费用 `p0`=1）；包体只有 `name` |
| 酿造 | `p0` = 酿造刻数 400→0，`p1` = 燃料；成品瓶子 `potionId` 从 0 变 3（water→awkward）；**服务端不下发 `minecraft:potion` 注册表**（registry_data 只送 22 个注册表，无 potion），编号→名字不可得 |
| `trade_list` | `inputItem1`/`inputItem2`/`outputItem(Slot)`，itemCount=0 即空；附魔注册表 43 项与 minecraft-data 同序（id 33=sharpness 与真服一致，双向印证） |
| `select_trade` | 服务端**自动把整摞付款搬进付款槽**并填好结果槽；点结果槽只扣应付量，余量留在付款槽 |
| 附魔组件 | `enchantments:{enchantments:[{id,level}]}`；附魔书是 `stored_enchantments`；`custom_name.data = {type:"string", value}` |
| mineflayer 限制 | `bot.clickWindow` 在商人窗口上会崩（把 `trade_list` 更新当窗口内容读）——驱动自写包是对的 |

## 真服验收（`dev:mc:stations`，源码与构建产物各跑一次，均 14/14）

源码与 `dist/.uina/worlds/minecraft/dev/stations.js` 各 **PASS 14/14**，断言全部走独立事实（`inventory@1` 的组件、数量差、`block@1`），不用动作自己的返回值自证：

1. brew 三瓶水+地狱疣 → 3 瓶 potionId 3，地狱疣剩 2（恰好消耗 1）。
2. brew `wait:false` → `readyAt` 与 `loaded.bottle.count`；上一轮成品还在台上时按 `WRONG_STATE` 如实拒绝（`/setblock` 同名替换不清方块实体，场景改为先 air 再放）。
3. brew 缺水瓶 → `MISSING_MATERIAL`，未占身体。
4. enchant 钻石剑 → 报告与组件一致（sharpness 1，cost=服务端报的档位）。
5. enchant 等级不足（0 级）→ `MISSING_MATERIAL`，剑未被附魔。
6. enchant 附魔书 → `stored_enchantments` 组件可读。
7. anvil 合并两把附魔剑 → 结果带附魔、只剩 1 把剑。
8. anvil 改名 → 背包副本 `custom_name === "Excalibur"`。
9. anvil 缺参数 → `INVALID_INPUT`。
10. grindstone 去附魔 → `removedEnchantments` 与输入一致、`xp` 为 null。
11. trade 买面包 → 面包 +3、绿宝石 -2（`trimPayment` 后取货为纯交换，回执可确认）。
12. trade 没有的报价 → `NOT_FOUND`。
13. `container@1` 对铁砧 → 拒绝（工作站不产出 `container`）。
14. 收尾清点不污染后续批次。

## 裁决与合同偏差（capabilities.md 已写回）

1. **`grindstone` 的 `xp` 恒 null**：返还经验是经验球，需拾取且无法归因到本次动作；`self.xpLevel` 只按整级变化，用它冒充就是造值。
2. **`brew` 的 `potion` 是期望值不是查表键**：服务端不下发 potion 注册表（registry_data 实测无 `minecraft:potion`），成品名只能按入参报告；`observedPotionIds` 是唯一可核实的证据，写成文档约束。
3. **trade 取货前先 `trimPayment`**：服务端把整摞付款搬进槽里，余量不清掉的话取货后结果槽立刻补货，点击后态不等于 mode-0 预测 → 回执 unknown → **整个 run 被 Runtime 结算成 unknown**（engine.ts 的 `callHasUnknownEffects`）。收敛成"正好一份"回到纯交换，与 craft@1"每批只摆恰好一批料"同一个道理。`Runtime.callHasUnknownEffects` 是本批实测发现的真实结算规则，不是新加的分支。
4. **`enchant@1` 优先选没附魔的那一件**：已附魔物品在附魔台三档全 0（真服实测），塞进去只会白等；用 `moveExact` 按具体槽搬，避免同名的已附魔副本被搬进去。全都有附魔时 `WRONG_STATE` 并指向 `anvil@1` + 附魔书。
5. **`anvil combine` 只在"真的有变化"时出结果**：白板+白板、附魔+白板都是 cost 0 → 结果槽为空（真服实测，重点击也不算）。合同原文"不可合并 → TARGET_NOT_MET"涵盖，验收场景改用两把各带附魔的剑。
6. **附魔三档等级要求是服务端随机算的**：同一档两次开窗可能差 1 级，`cost` 以本次属性为准，不做断言上限。

## 测试与门禁

- `tests/mc/mc-workstation.test.ts`（新，18 项）：布局直接取真实 `windowLayout()`，覆盖五类的成功路径、材料不足/等级不足/已附魔/报价耗尽/不可合并/缺参数/无商人，以及"组件只认事实"（未知编号报 `#99`）。
- `tests/mc/mc-window-layout.test.ts`：五类布局 + 槽数不符拒绝 + `beacon` 这类未接窗口仍拒绝（原"`minecraft:enchantment` 必须被拒"随本批反转）。
- `tests/mc/mc-protocol.test.ts`：`trade_list` 解码（双付款、空产物槽不编名）与三条提交的包形。
- `tests/mc/mc-driver-window.test.ts`：原"workstation 目标派发前拒绝"反转为"无窗口方块（stone）派发前拒绝"。
- `tests/mc/mc-capability-queries.test.ts`：目录计数 25 → 30。
- 全量 MC 回归 **68 文件 / 557 项全绿**（vmThreads）；`biome format`、`check:boundaries`（10 rules ok）、`tsc --noEmit`、`pnpm build`（含产物入口复跑场景）全部通过。

## 未验证 / 边界

- `brew@1` 只支持一批 ≤3 瓶（合同未定义多批语义，多次调用即可）；大量消耗烈焰粉的连酿未测。
- `anvil@1` 的 `repair` 分支没有专门真服用例（与 combine 同一条"放双输入→读费用→取结果"路径，改名已覆盖该机制）；`operation:"rename"` 的 50 字上限按合同校验。
- 商人"报价用完"只在单测覆盖（真服 villager 的 `maxUses` 未压到 0）。
- `enchant@1` 的 `slot` 只接受 1|2|3；`ItemSelector`（带组件/耐久的选法）合同允许但本批未开放 schema，模型选实例的能力仍是名字级。
- 沙箱内跑真服：Java 服务端由本会话后台启动并经 `/stop` 正常退出（exit 0）。
