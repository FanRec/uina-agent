# MC 生产链修复实施与验收

日期：2026-10-25。基线 `8b46337`，当前工作树 `codex/phase0-baseline`；未提交或推送。保留开工前 `scripts/extract-mc-smelting.mjs` 的格式修改。修复范围为批 3 的合成、熔炼、共享窗口搬运及其消费者，不改数据库结构、Runtime 身体队列或真实运行数据。

## 实现与八项审查问题

| 问题 | 当前实现与回归 |
|---|---|
| 熔炼等待占用身体 | 装料与复查使用独立 `withBody` 回调，退出即关窗；可取消等待在回调外，自有身体释放、祖先委托仍保留。真实 Engine/BodyLeaseQueue 测试验证另一个身体调用先完成。 |
| 燃料截断、原料不缩小 | 批量同时受实际原料/燃料堆叠、产物容量和已知燃烧刻数约束；竹子 64 件只能装粗铁 16 件，wait:false 返回 remaining:48。 |
| 四种不可燃下界木材 | 从最小燃料表删除。逐项对照本地 Paper 1.21.11 的 FuelValues 字节码；干海带块同步修正为 4001 刻。 |
| 熔炼部分/跨批进度丢失 | 每次确认装入或取回立即累计 produced/consumed/loaded/remaining；未知点击、第二批失败、取消及 SQLite 重开后保留确认量。 |
| 满背包误拒合成 | 删除调用前输出容量预测，按消耗原料后的真实窗口完成搬运；最后一件原木腾槽可制作木板。 |
| 合成取货不能跨槽分装 | 与普通搬运共用 placeCursor，先填余量堆、再用空槽；两个木棍 62 堆可接收四个产物。 |
| 同名异组件被错误交换 | 共用 sameItem 的组件/耐久匹配；自定义名称木棍不被普通产物覆盖。 |
| 合成取消丢失已做批次 | 原料消耗与产物入包分别记账，错误 progress 保留 crafted/produced/consumed/remaining，既往派发不降回 not_sent。 |

旧混合 actions/crafting.ts 已删除，由 craft.ts 与 smelt.ts 各自承担领域循环；没有兼容入口。共享搬运保持原服务端确认路径，未知点击不重放，也不猜光标已空。

## 确认合同与明确边界

- WindowClickReceipt.confirmed 直接替换为确认时的完整 WindowSnapshot；只有被点击槽/光标转换归因于本次点击，其他槽位是同次观察。原先“回执已确认→再次 snapshot→记账”的取消竞争已删除；Driver、库存操作、能力、测试夹具和公开合同同步更新。
- produced 为本次服务端确认入包的累计量，不因等待期间其他动作使用库存而扣减。熔炼清理旧成品的取回量不抵扣新批次目标。
- consumed 为本次从背包确认投入炉子的材料，不代表实际烧掉；loaded 为本次累计装入量，不是炉内当前存量。只使用不可辨来源的已知余火、且未选择新燃料时，fuel 为 item:null/count:0。
- 自动燃料从首次开炉的实际背包快照选择，一次调用固定一种新添燃料，不增加混合燃料规划或更换燃料的累计协议；选定燃料不足时保留实际进度并报缺料。已知余火足够时允许熔炉保留空桶，不额外装料。
- 复查核验原世界、revision、维度、连接/化身及炉子；不自动换炉。烹饪估时只安排复查，不作为产物证明。所有批次共用一个截止时间；异步接口返回后复验预算，不新增通用超时/调度框架。

## 本轮验证

- pnpm typecheck：格式检查无改写、9 条边界和 TypeScript 通过。
- MC 显式文件列表、vmThreads：28 files / 236 tests 通过。新增关键行为先复现 RED，再修复 GREEN；独立最终审查三项问题一轮修复，其中回执后读取竞争、空桶余火和旧库存选燃料均有失败回归。
- pnpm build：通过；源码与 dist 使用同一正式装配和场景入口。
- 真实 Paper 1.21.11 build132、Java 21、offline UinaDev；沿用专用 9000/10000 高空测试平台，不重置世界。每次入口使用独立临时 Uina 数据根，串行执行。
- 最终源码 production-repair：7/7 PASS，日志 C:/Users/34150/AppData/Local/Temp/uina-production-source-final.log，数据根 C:/Users/34150/AppData/Local/Temp/uina-mc-production-repair-bKEO9W。覆盖满背包、分装、组件、弱燃料、真实并发身体动作、取消后33秒无新增开炉/点击，以及后续显式取货。
- 最终源码 K3：14/14 PASS，日志 C:/Users/34150/AppData/Local/Temp/uina-production-k3-source-final.log，数据根 C:/Users/34150/AppData/Local/Temp/uina-mc-k3-source-final-4c70ced848894e0fab62ee20a517821b。
- 最终 dist production-repair：7/7 PASS，日志 C:/Users/34150/AppData/Local/Temp/uina-production-dist-final.log，数据根 C:/Users/34150/AppData/Local/Temp/uina-mc-production-repair-M7X0kt。
- 最终 dist K3：14/14 PASS，日志 C:/Users/34150/AppData/Local/Temp/uina-production-k3-dist-final.log，数据根 C:/Users/34150/AppData/Local/Temp/uina-mc-k3-dist-final-1172fe6e13cc4c49b85e1c2990bfab7e。

初次 K3 曾失败：同名 setblock 保留上轮炉子数据，而旧脚本固定断言新装入一块煤；余燃料复用后实际新装入为零。脚本现仅清空专用测试炉，后续燃料计数按独立库存差核验。初次失败与继发超时不作为通过证据。

其他版本、真实模型使用、长期游玩和未涉及能力未验证。停止/乱序/窗口替换等窄竞争以确定性夹具与实际 Runtime 记录路径验证，不冒充真服场景。

验收收尾：本轮启动的 Paper 经游戏内 /stop 正常关闭，Java 启动会话 exit 0，25565 无监听。世界存档与四个独立验收数据根保留；索引为空，未提交或推送。
