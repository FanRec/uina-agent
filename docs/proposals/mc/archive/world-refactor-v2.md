# Minecraft World V2 验收记录

基线为 `mc/world-refactor@4508e3f2`。54 个既有 selector 各保留一个绑定。新增 `build.resume@1` 后，Catalog 共装配 18 个查询与 37 个动作。生产入口用 `tasks`，执行侧 Run、Segment、Effect 和 Host 投递身份分别沿用原记录。开发验收直接使用 Executor 的诊断端口。

## Paper 采集切换

Paper Java 1.21.11，隔离存档与临时 Profile。每轮重置库存与场景，交错执行 Native 和候选 Program。服务端用独立库存查询确认每轮均从 0 增至 16 个原木。

| 指标 | Native | Program | 切换预算 |
| --- | ---: | ---: | ---: |
| 服务端确认成功 | 10/10 | 10/10 | 等价 |
| 耗时中位数 | 29.423 s | 29.519 s | Native 的 115% |
| P90 | 31.389 s | 30.641 s | Native 的 125% |
| goto 子调用合计 | 31 | 30 | |
| mine 子调用合计 | 160 | 160 | |
| pickup 子调用合计 | 67 | 71 | |

另做一轮插桩对照。Native 产生 219 次 World 读取，其中 136 次是库存读取。Program 产生 179 次 World 读取，其中 90 次是库存读取，并使用 16 次库存 Watch。Program 的 guest RPC 共 131 次，分别为 89 次读、26 次子调用和 16 次等待。动作计数与插桩表明移动、挖掘和拾取的规模相近，库存 Watch 减少了轮询读取。插桩样本独立于切换预算的 20 轮。

满包和缺工具分别以 `INVENTORY_FULL` 和 `MISSING_TOOL` 结束，源块保持原状。已有掉落时双方都按库存增量结算。半程场景双方都是 1/2，错误为 `NOT_FOUND`。半径内悬空源块各试过一次，无法到达后块仍在。真实挖掘包派发后断线各保留 1 条未知 Effect。通过对照后移除旧 Native 采集编排和候选绑定。`pnpm dev:mc:refactor-bench 10` 现在只跑当前正式绑定。若需重做前后比较，从各自提交运行相同场景。

可复制的采集示例改变半径后，从找不到资源变成服务端确认入包。小型施工示例在缺料时保留余量，补料后完成朝向明确的目标格，邻近的非目标方块保持原状。通用 `build@1`、隧道和窗口事务继续由 Native 提供。

## Fabric 与执行进程重启

测试组合为 Java 21、Minecraft 1.21.11、Fabric Loader 0.20.1、Launcher 1.1.2、Fabric API 0.141.4+1.21.11 和 SpectatorPlus 1.2.3-local。服务器二进制、配置和存档位于忽略目录 `.uina/worlds/minecraft/dev-env/fabric/server/`。客户端 Loom 运行时显式使用 SpectatorPlus 内嵌的 permissions API 0.6.1。

| 本地制品 | SHA-256 |
| --- | --- |
| Fabric Server Launcher | `2b06e5e0719199ba100659a283626d9b055e5fded1cb87fa1cdf4df571c0754d` |
| SpectatorPlus | `0e12b3069ceed7d1de02eefd4176a96e4bf1e1881d1cc56f859eba2249e3a3bd` |
| Fabric API | `9286762874fd20d1d45e006d175fea8ff762da54e00946bbe952c4f61077159a` |

夹具源码在 `dev-env/fabric/fixture/`，用 Gradle 9.2.1 执行 `build`，将 `build/libs/uina-fabric-fixture-1.0.0.jar` 放入隔离服务端的 `mods/`。测试使用回环地址、离线玩家 `UinaDev` 与临时 Profile。Fabric API 由官方仓库提供。 [Fabric API 固定制品](https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.141.4%2B1.21.11/)

| 场景 | 实测结果 |
| --- | --- |
| 注册表和自定义内容 | 普通 Program 发现 token，读取真实背包，放置并复读 tile。服务端命令独立核验物品和方块。换到 Paper 后旧物品 ID 和方块状态 ID 均未知。 |
| SpectatorPlus | 两次真实制作各发送 `01/00`。实际 Java 观察客户端只在镜头跟随 Uina 时显示并关闭 `SyncedInventoryScreen`。 |
| 持久检查点 | 看到 SQLite 已提交第一格后终止进程。重开使用同一 Run，认领一个新 Segment，只放置剩余格。服务端独立确认两格。 |
| 发送后崩溃 | 在真实 `block_place` 发送边界终止进程。重开复读目标，保留无法归因的 Effect，原任务停在待决策。显式停止后仍只有原 Segment。 |
| 更新 Addon 资产 | 改变已安装资产摘要后重开，原任务保留，认领被拒绝，显式停止后保持取消。 |
| 同地址换存档 | 同一 TCP 地址转接到另一份 Fabric 存档，存档 UUID 不同。续段被拒绝，显式停止后保持取消。 |
| 数据回退 | 复制 SQLite 数据，当前 Runtime 读取旧 Run 并写入 Owner 门。基线 Runtime 也能打开新数据副本并执行同样操作，历史 Run 读值保持一致。 |

重现入口为 `pnpm dev:mc:fabric`。设置 `MC_DEV_PORT=25566` 并连接隔离 Fabric。模式包括 `--registry-switch`、`--spectator`、`--restart`、`--restart-unknown`、`--restart-assets`、`--restart-save`、`--restart-writer`。观察场景用夹具的 Gradle `runClient`，将 `UINA_FABRIC_SPECTATOR_JAR` 指向指定 JAR，并将客户端日志传给 `MC_FABRIC_OBSERVER_LOG`。运行前让观察者连接测试服并关闭自己的背包和菜单。换档场景还需设置 `MC_FABRIC_ALTERNATE_PORT`，指向带独立存档的第二个 Fabric 服务端。

自动续段的验证范围为同存档、同维度的显式绝对坐标格。进度由已提交检查点记录，现场差异由新 Segment 复读。Addon 装配摘要变化后保留原任务供查证。当前注册表适配验证了该组合中的单状态实心方块和物品。

## 发布门

- 受控 Provider 和真实模型分别通过正式 Host、WorldTool、Executor 与 Paper 链路。真实模型通过公开入口发现能力、处理一次拒绝、采集并显式停止。
- 源码和构建产物的 Task、Program 场景均通过。真实 Paper 上，I2 续段、容器 13 项、建造与空间回归全部通过。窗口全量内容先于布局到达时，布局就绪后会发布首份有效快照，覆盖了此前只读空容器未更新历史的场景。
- `pnpm typecheck` 与 `pnpm build` 通过。全量 `pnpm test --maxWorkers=4` 有 3621 项通过、1 项预期失败，两项 Windows 联接测试失败。Library 收到 `realpath UNKNOWN`，Executor 打开别名收到 Windows 448。C、E 两卷独立联接探针均出现 `UNKNOWN`，待在能通过联接探针的 Windows 主机上复验原断言。

回退按 Git 切片恢复唯一生产绑定。运行库保留已有动作和 Effect 事实，现场动作以服务端重新对账。

## 收尾审查

- 逐项核对 V2 方案所列 54 项能力与实际 Catalog。原有能力中只有 `collect@1` 绑定 Program。通用 `build@1`、`excavate@1`、`explore@1`、`transit@1` 和 `tunnel@1` 保留原生绑定。新增 `build.resume@1` 专用于可恢复的绝对坐标施工。
- 通过正式 Host 在真实 Paper 上，从任务证据复制已冻结的采集源码。只改默认半径，在同一场景验证短半径报告 `NOT_FOUND` 并保留源块，较长半径成功采集。另复跑 0 到 16 个原木的正式绑定单轮及部分完成、满包、缺工具和派发后断线。切换预算仍以原始 20 轮结果为准。
- 真实 Fabric 复跑恢复、未知写入、换存档及资产变化。待决策任务可查询具体拒绝原因，显式续段的拒绝可用原提交身份从持久记录查证。另在终止旧进程后特意省略 Writer 退休证明，确认新 Runtime 拒绝启动，数据库仍只有原 Segment。
- 复跑 Fabric 注册表及 SpectatorPlus。服务端重新确认自定义物品和方块，换到 Paper 后旧数字 ID 仍为未知。实机观察端复验两次制作各收到打开和关闭，且只在跟随目标时显示同步背包。
- 源码和构建产物的公开任务和 Program 验收通过。真实模型重新通过发现、拒绝后调整、采集和停止。类型检查和构建通过。全量测试复跑为 3624 项通过、1 项预期失败、2 项 Windows 联接失败。两项安全断言原样保留，Windows 联接复验仍是发布门的未完成项。

## 游玩体验

源码入口为 `node --import tsx .uina/worlds/minecraft/dev/native-host.ts --model --autonomy`。临时 Host 会话从未连接开始，只告知 Paper 地址、协议和可用身份。模型自行选择要不要连接和做什么。基线自行入服、观察、找不到附近原木后开始探索。120 秒观察窗内对同一任务查询 51 次，其中 26 次重复修订，最后一次可见进度为探索 24 处、移动约 467 格。

受控 Paper 场景验证了采集任务显示目标、完成通知得到原有 Host 回执，以及两个 Program 并存时按名称找到并停止其中一个，另一个仍持有身体控制。
