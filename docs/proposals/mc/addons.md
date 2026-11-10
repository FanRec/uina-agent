# Addon：非原版 Minecraft 的独立可安装兼容能力

更新时间：2026-11-08。本文是 Addon 的**权威合同**：Manifest、Profile 选择、装配、连接级协议、
事实与知识的边界。代码注释中的 `docs/proposals/mc/addons.md §x` 均指本文。

## 1. 目标与边界

Addon 让 Uina 在没有原版客户端 Mod 的前提下，接入**真实服务器插件/Mod 提供的状态与交互**：
自定义通道 Payload、服务端权威计数、模组物品身份、受控动作。它解决的是"非原版环境的兼容能力"，
不是插件加载器，也不是第二套执行层。

明确不做：

- 不新建 `ModRuntime` / `ModAgentLoop` / 第二套能力目录 / 第二套身体仲裁器；
- 不伪造 HUD、GUI、客户端渲染（那属于真实 Java 客户端 Mod）；
- 不把 Manifest 的 `serverRequirement` 声明当作"服务端已安装"的证据；
- 不在主进程 import 第三方代码（只有 Companion 的 loader 会 import）。

## 2. 目录与事实

```
<worldDataDir>/
  addons/<addonId>/package.json + index.js   # 安装（本机有完整包）
  sessions/<64-hex-profileId>/addons.json    # 启用（该 Profile 选择运行哪些包）
```

五个事实必须分开表达，任何一层都不能冒充另一层：

| 事实 | 来源 | 含义 |
|---|---|---|
| Installed | `addons/<id>/` 扫描 | 本机有可解析的包；**不代表**会运行 |
| Enabled | `sessions/<profile>/addons.json` | 该 Profile 明确选用；**不代表**已加载 |
| Loaded | Companion `loadAddons` 成功 | 本次连接已装配并贡献能力 |
| Compatible | 协议/服务端条件经验证 | 特定通道、命令、插件确实可用 |
| Available | 能力调用时的环境判定 | 当前连接/身体条件下可调用 |

离线 `describe` 只报 `installed` 且 `contributed.refs` 为空；活动会话的 `describe` 只报本次
Companion 真正加载的包。两者都不推断"应该能用"。

## 3. Manifest

`package.json` 的 `uinaMinecraft` 段（只读解析，不执行代码）：

```json
{
  "name": "@uina-addons/example-mod",
  "version": "1.0.0",
  "main": "./index.js",
  "uinaMinecraft": {
    "id": "example-mod",
    "api": 1,
    "minecraft": ["1.21.11"],
    "requiresAddons": { "core-lib": "1.0.0" },
    "serverRequirement": {
      "kind": "plugin",
      "id": "uina-example-plugin",
      "requiredFor": "feature",
      "note": "counter lives on the server"
    }
  }
}
```

校验规则（失败码均为 `ADDON_*`，不静默跳过）：

- `id`：`^[a-z0-9][a-z0-9._-]{0,63}$`；同一安装根内重复 id 记为 scan problem，后者不加载；
- `api`：必须为 `1`，否则 `ADDON_API_UNSUPPORTED`；
- `version`：`x.y.z[-prerelease]`；
- `minecraft`：字符串数组；**空数组 = 未声明**，不据此拒绝；
- `requiresAddons`：`id -> version`（`*` 表示任意）；
- `serverRequirement.kind`：`plugin | mod | mod-or-plugin`；`requiredFor`：`feature | connection`；
- `main`：包内相对路径；绝对路径或 `..` 逃逸在解析阶段就失败；入口必须是包根内真实文件
  （`ADDON_ENTRY_MISSING`）。

坏包只影响自己：`scanInstalledAddons` 返回 `problems`，其它包照常可用；但 Profile **明确启用**
的包损坏时，连接前显式失败。

## 4. Profile 选择

`addons.json`：

```json
{ "enabled": { "example-mod": { "verifyTimeoutMs": 4000 } } }
```

- `enabled` 是显式选用列表；未列出的已安装包不运行、不 import、不出现在目录；
- 每次 `connect` 读一次并**冻结**：连接期间改文件不生效，重连才重新解析；
- 解析失败发生在建立执行域之前：`ADDON_NOT_INSTALLED` / `ADDON_VERSION_MISMATCH` /
  `ADDON_DEPENDENCY_MISSING` / `ADDON_PATH_UNTRUSTED` / `ADDON_SELECTION_INVALID`；
- 冻结计划带 `digest`：按已排序的 `{id, version, api, artifactDigest, configDigest,
  dependencies}` 取 sha256 前 32 hex，出现在 `session.status.active.addons.digest` 与
  `directory.snapshot.selection.digest`；它保证能追溯"当时实际用了哪些字节"，
  不是信任签名，也不防恶意代码；
- 真实路径必须留在安装根内（符号链接指到别处 → `ADDON_PATH_UNTRUSTED`）。

## 5. 安装 / 启用 / 卸载

运维 API 在 `addons/manage.ts`，CLI 为 `pnpm mc:addon -- <command>`（数据根：`--root` >
`UINA_MC_DATA_DIR` > `<cwd>/.uina/world-data/minecraft`）。

```bash
pnpm mc:addon -- list
pnpm mc:addon -- install .uina/worlds/minecraft/examples/addons/example-mod
pnpm mc:addon -- status --profile <64-hex>
pnpm mc:addon -- enable example-mod --profile <64-hex> --config '{"verifyTimeoutMs":4000}'
pnpm mc:addon -- disable example-mod --profile <64-hex>
pnpm mc:addon -- remove example-mod
pnpm mc:addon -- migrate   # 旧 addons/<id> 布局一次性迁入 store
pnpm mc:addon -- gc        # 所有会话停止后离线回收无引用 artifact
```

包存储是不可变的（`addons/store.ts`）：

```text
addons/artifacts/<id>/<完整内容摘要>/...   # 安装后不再改写
addons/installed.json                     # id -> 当前生效摘要，原子替换
```

- 安装 = 从来源构建暂存目录 → 校验 Manifest、入口与拒绝符号链接 → 计算全目录内容摘要
  → `rename` 成 artifact 目录 → 原子更新 `installed.json`。同 id 更新只替换映射，
  不覆盖仍可能被活动会话使用的旧内容；
- `remove` 只解除映射，不立即删除 artifact；`gc` 要求先停止所有会话再离线回收；
- 旧布局只用 `migrate` 一次性迁移，迁移后不保留双格式后备；
- 卸载时任何 Profile 仍启用则拒绝（`ADDON_IN_USE`），先 `disable`；
- Profile 选择文件的读-改-写经 `withFileLock` 串行，写入走同目录临时文件 + `rename`；
- 活动会话继续使用它**已加载**的确切 artifact 摘要；安装/卸载/启停都不热替换当前连接。

## 6. 装配

`addons/loader.ts` 是 Companion 侧唯一 import 第三方代码的地方：

1. 只接受 Parent 预检并冻结的 `AssemblyPlan`（`roots` + 依赖在前的 `ordered` + `digest`）；
   每个 `ResolvedAddon` 都是纯值，带 `artifactDigest` / `configDigest` / `dependencies` /
   `requestedBy` / `config`，加载按 `ordered` 顺序、释放按逆序；
2. 模块必须导出 `{ api: 1, id: <manifest id>, create(ctx) }`，否则 `ADDON_ENTRY_INVALID`；
3. `create()` 返回贡献对象；抛出的 `CallFailure.code` 原样保留（`ADDON_CONFIG_INVALID` 等）；
4. 贡献只映射为：`MinecraftCapabilityModule`、`ProtocolExtension`、`KnowledgeSet`；
5. `close()` 逆序执行，失败聚合为 `AggregateError`。

## 7. 能力目录

- 外部能力与内置能力走**同一次** `CapabilityCatalog.create/bind`；没有第二个 invoke/query 注册表；
- ref 必须命名空间化：`<namespace>.<name>@<version>`（建议 namespace 用 addon id，但不强制；
  规格示例 `example.machine@1` 合法）；
- 与内置 ref 重名在 Catalog 装配处显式失败（`duplicate capability ref`），不静默覆盖；
- 动作必须 `access: "act"`；查询必须 `access: "read"` 且有 `current` 或 `static` reader；
- 包状态携带**确切 ref 清单**（`contributed.refs`），目录投影不再靠 id 前缀猜能力归属。

## 8. 连接级协议扩展

一条连接只有一个由 Driver 创建、连接和释放的 minecraft-protocol Client。三个贡献时机（`contracts/protocol.ts`）：

- `install(boot)`：**预连接阶段**。Client 已构造、Socket 尚未连接，按依赖拓扑顺序同步装配
  包处理器、阶段回复与通道声明。`boot.claim(phase, resource)` 独占声明协议资源，第二个
  Owner 立即以 `ADDON_PROTOCOL_CONFLICT` 失败，不按装载顺序覆盖。全部装配完成并冻结后
  才放行真实网络连接。Addon 拿不到裸 Client，也不能覆盖协议版本——版本由
  `ExecutorConfig.connection.version` 固定给出（autoVersion 会抢先发 status ping）。
- `attach(port)`：放行连接之前挂接；登录/配置/Play 包都会到达；只读订阅 + 发布事实，
  返回的函数在连接退役时执行。
- `localScreen(event)`：**纯同步编码器**，把 Uina 自己的个人背包窗口事务起止翻译成
  Payload（见 §8.5）。不持有连接、没有发送能力、不参与订阅生命周期。

`ProtocolBootstrap` 只暴露 `minecraftVersion` / `connection`（只读）与 `onPacket` /
`onPayload` / `declareReceive` / `claim` / `installLowLevel`。Login 与 Configuration 的
握手回复经 `PhaseContext.replyPacket/replyPayload`，限定为当前阶段与当前连接，是连接级
协议动作，不是游戏 Effect；Play 阶段改变世界的 Payload 仍只走 Runtime BodyScope 的
`CallContext.protocol`。受信任底层插件可经 `installLowLevel` 在预连接阶段接触同一个
Client 的协议底座（隐含 `claim("preconnect", name)`），不成为 Play 任意写入捷径。

`ConnectionPort` 只暴露：`connection` / `incarnation` / `version` / `state()` /
`onPacket` / `onCustomPayload` / `onEvent` / `publishFact`。没有裸 bot、没有 socket、没有写入口。

`ProtocolBootstrap` 目前**不提供** `registerCodec`：需要扩展 codec 的加载器基础包走
`installLowLevel`（受信任、只在预连接阶段、隐含 `claim("preconnect", name)`），
配置阶段的 `installRegistry` 接受已核验的连接级注册表映射，填入同一个客户端的解码表。当前范围为夹具实测的物品与单状态实心方块。

### 8.1 通道注册（必须）

服务端**只向已声明可接收的通道投递** clientbound `custom_payload`。因此：

- `port.onCustomPayload(channel, handler)` 会先调用 `protocol.registerChannels([channel])`；
- `CallContext.protocol.send(channel, data)` 在发送业务负载前确保该通道已注册；
- 注册使用 1.13+ 的 `minecraft:register` 负载（NUL 分隔通道名），每连接每通道一次；
- `attach` 早于 login：登记会排队，`login` 进入 play 阶段后自动补发，不在错误协议阶段写入。

这是传输层订阅，不改变世界状态；真正的写入仍然只在 BodyScope 内。

### 8.2 写入（scoped ProtocolWritePort）

`ProtocolWritePort.send(channel, data)` 只在 `callCtx.withBody(async (scope) => …)` 的
`scope.protocol` 上存在；普通调用拿不到写端口。通道必须是合法 ResourceLocation，负载 ≤ 32767 字节，
否则发送前 `INVALID_INPUT`（不把"服务端静默丢弃"伪装成已生效）。

Runtime 不再把共享写对象交给 BodyScope：`runtime/scoped-protocol.ts` 在每个持 Lease 的
调用上下文里新建一份端口，绑定本次 Call / Lease / Body 与**建立时的** connection /
incarnation。每次 `send()` 都重新跑现有的 `assertLease`（内含 Call 活性与执行域闸门）、
再比对当前 Driver 身份；保存旧引用、Body 退出、子 Call 委托、停止或安全打断、死亡/跨维度、
断线重连一律以 `dispatch: "not_sent"` 失败，绝不碰真实网络。组合根只注入
`ProtocolWriteDispatcher`（`driver/protocol-dispatch.ts`）：Runtime 不接触 bot/socket，
Driver 在写 socket 前再复核一次自己的连接身份。

发送是同步提交，不凭空引入 Promise。真实写入成功后，派发事实记进**现有**
Effect Ledger（`RecordQueue` / `DriverExecutionSink`），合同名 `addon.protocol@1`，
`kind: "dispatch"` / `dispatch: "sent"` / `completion: "unknown"` / `evidence: []`。
没有 ACK 或观察证据就不能写成 `met`：网络提交成功不等于服务端动作成功。
不为自定义 Payload 另建一套效果数据库；写入失败不留"已派发"的假事实，
记录被拒收时如实以 `dispatch: "sent"` 失败并把该效果留作 unknown 结算。

`send()` 返回本次派发的 effect ref；`confirm(effect, evidence)` 是唯一的补证路径：
addon 拿到服务端 ACK 或真实观察证据（`world.read` 返回的 `evidence` ref）后，追加一条
同 effect 的 receipt 事实（`kind: "receipt"` / `dispatch: "sent"` / `completion: "met"`）。
只能确认本端口自己发出的 effect，且必须带证据；空证据或别的 effect 直接拒绝，
失败按 `dispatch: "sent"` + 该 effect 报。不调用 `confirm` 就保持 unknown——
没有证据不能给虚假 `met`。

### 8.3 事实（采集身份与作用域）

- `port.publishFact(key, value, publication)` → `FactsSource.publishAddonFact` →
  `ClientFactView.addonFact(addonId, key)`；
- `publication` 必须显式给出 `scope`（`connection` / `incarnation`）、`source`
  （`server` / `derived`）与可选 `unknown`。来源按原始证据确定，不给默认 `server`；
  例如解码服务端回包是 `server`，addon 自己置的未知占位是 `derived`。
- 采集事件来源身份在**事件到达时**由 `ConnectionPort` 捕获并经同步上下文带到
  回调（含异步续段），不是提交时临时读取当前身份；在事件回调之外发布直接拒绝。
  `FactsSource` 再用采集身份与当前身份逐项比对，旧异步结果不会误标成新事实。
- `incarnation` 域（身体相关）在换代/身体失效时清除，视图读取也判为不可见；
  `connection` 域（服务器范围状态）保留到本连接断开；跨连接任何域都不可见。
  `connecting` / `disconnected` 清空全部。
- 只接受纯 JSON；函数/循环引用显式抛错，不写半成品；
- 每次发布同时产生一条 `addon.fact@1` 采集证据（`ev:` ref），事实的 `evidence` 指向它；
  查询回读带着这个 ref，`scope.protocol.confirm` 才有可引用的观察证据，不是空口断言。
  因此发布要有节制：只在服务端真给了新状态时发，不要逐 tick 发——每条都会进证据流；
- `unknown` 非空时 `coverage: "partial"`；没有发布过的 key 返回 `null`，不返回零值对象。

### 8.4 生命周期

`isCurrent()` 按连接代次判定；`dispose()` 解除全部订阅与 attach 登记的释放函数；
单个 addon 监听器抛错被隔离（记录后继续），不打断底层订阅链上的其它订阅者。
连接退役后迟到的订阅与发布一律丢弃，不写进新连接的当前事实。

### 8.5 本地界面展示（`localScreen`）

Core 只表达一个 Minecraft 通用事实：**Uina 自己的个人背包窗口事务开始了/结束了**。

```ts
interface LocalScreenActivity {
  kind: "player_inventory";
  phase: "open" | "close";
  session: Ref;        // 同一次 withInventoryScope 的稳定引用
  connection: Ref;
  incarnation: Ref;
}
```

`ProtocolExtension.localScreen(event)` 是**纯同步编码器**：返回 `{ channel, data }` 或 `null`，
不持有连接对象、没有发送能力、不能返回 Promise。实际写入只由 Driver 完成。

- **身份**：ClientHost 先校验 `state === "ready"` 且 connection/incarnation 与事件一致，
  否则整条事件丢弃——旧事务的 close 绝不会写到新连接。
- **顺序**：同步编码、同步写入，与随后的原版窗口包保持确定顺序；不排队、不 `await`。
- **隔离**：单个包编码或发送失败只记诊断（`[mc-addon:<id>] localScreen(...)`），
  不影响同一次事件里的其它包，也不改变物品事务的真实结果。
- **语义**：`emitLocalScreen` 返回 `true` 只代表至少一个 Payload 已提交给协议层；
  没有服务端 ACK 时不能宣称观察者真的看到了界面。

边界只在 `withInventoryScope` 一处（`equip` / `toss` / `withInventory` 即 2×2 合成）：
一次事务最多一对 open/close，`close` 只在同一次事务的 `open` 真的提交过时才发。
`inventory@1` 读取、正常捡拾、快捷栏切换、`openContainer` 的原版容器窗口都不经过它——
后者由服务端自行镜像，Uina 再发一遍只会和上游互相覆盖。

## 9. 包内知识

`composeKnowledge(base, sets)` 的优先级固定：

1. 当前服务器注册表优先；addon 声明同名项 → 以注册表为准并记录 `reason: "registry"`；
2. 两个包声明同名项 → 该项不参与组合，记录 `reason: "addon"`（不按加载顺序覆盖）；
3. 包内物品只补身份字段；`sources: []` 且 `sourcesComplete: false`，掉落/碰撞/配方保持未知；
4. 裸名只在唯一时解析；歧义保持 `null`。

## 10. 目录

`directory.snapshot`（Executor RPC）返回纯 JSON：活动会话 descriptors、addon 状态、选择 digest。
`describe`：

- `{ kind: "addon", name: "<id>" }`：返回 `status`、`capabilities`（来自 `contributed.refs`）、
  `note`（声明了服务端依赖时明确写"声明不等于已安装"）；
- 活动会话拿不到快照时 `EXECUTOR_UNAVAILABLE`，**不回退**旧目录或内置全集；
- 离线只给内置 descriptor + 已安装包摘要（不 import 第三方代码）。

## 11. 包源码布局、示例与真服夹具

仓库内两类包，区别是**定位**而不是格式（同一套 Manifest / SDK，安装方式完全相同）：

- `packages/<id>/`：随仓库发布的正式包，按真实集成维护，改动需过测试与验收；
- `examples/addons/<id>/`：教学示例，可随时重写，不承诺兼容。

`packages/spectatorplus`（正式包，Fabric 服务端专用）：只实现 `client.localScreen`，
把个人背包的 open/close 编码成 `spectatorplus:opened_inventory_sync` 的 1 字节布尔
（`01` / `00`）。不贡献动作、查询、知识或事实，也不订阅任何包。

服务端是 **Fabric + SpectatorPlus 服务端 Mod**，由服主自行安装；本仓库不安装、不分发、
不探测。**不支持 Paper**：那里的 SpectatorPlus 是插件实现，同一通道读 0 字节、只当作
"打开"，Uina 发 `00` 会被它再当成一次打开。要支持 Paper 必须改服务端插件，属于上游范围。

`examples/addons/example-mod`（纯 ESM，无依赖）：

| 能力 | 类型 | 说明 |
|---|---|---|
| `example.machine@1` | current 查询 | 读连接级事实；未收到时为 null + partial |
| `example.recipes@1` | static 查询 | 包内工艺知识；明确不是原版合成，不能走 `craft@1` |
| `example.press@1` | 动作 | BodyScope 内发 `uina:example`，轮询到计数前进才返回；否则 `EFFECT_UNCONFIRMED` |

线协议（UTF-8 JSON）：`{"op":"press","times":N}` / `{"op":"state"}` →
`{"op":"state","counter":N,"item":"example:uina_token","serverTime":"…"}`。

服务端夹具：`dev-env/uina-plugin/`（Paper 1.21.11）。`node build.mjs` 用服务器 libraries 作
classpath 编译并安装到 `server/plugins/`；首次发放 `example:uina_token` 纸片（PersistentDataContainer
保存身份）。

## 12. 验收

确定性回归：

```bash
npx vitest run tests/mc/mc-addons.test.ts tests/mc/mc-addon-graph.test.ts \
  tests/mc/mc-addon-protocol.test.ts tests/mc/mc-client-lifecycle.test.ts \
  tests/mc/mc-protocol-bootstrap.test.ts tests/mc/mc-pending-client.test.ts \
  tests/mc/mc-scoped-protocol.test.ts tests/mc/mc-scoped-protocol-engine.test.ts \
  tests/mc/mc-local-screen.test.ts tests/mc/mc-client-screen.test.ts tests/mc/mc-protocol.test.ts
```

`mc-local-screen` 覆盖个人背包边界（equip/toss/2×2 各一对、失败与取消只收尾一次、
并发被拒时不产生事件、没有包接收时不补发 close、展示口抛出不改变物品结果）；
`mc-client-screen` 覆盖 ClientHost 的身份校验、通道声明顺序与单包失败隔离；
`mc-addon-graph` 覆盖依赖闭包、错误链、artifact 原子性与 IPC schema；
`mc-protocol-bootstrap` / `mc-pending-client` 覆盖首包前挂载、claim 冲突、阶段回复、
未连接 Client 构造与放行/回滚；`mc-scoped-protocol*` 覆盖过期写端口与 Effect Ledger 派发。

Fabric 真服的 `pnpm dev:mc:fabric --spectator` 分开核对出站的开关字节和真实 Java 客户端记录的界面。另有注册表握手、自定义物品与方块及切服失效的真服场景。 [组合版本与验收](archive/world-refactor-v2.md)

真服（先启动 dev-env Paper，含 `uina-example-plugin`）：

```bash
pnpm dev:mc:addons
```

`dev/addons-live.ts` 覆盖 8 步：安装≠启用、未启用不暴露、连接期间冻结、重连装配生效、
初始事实未知、纵向写入闭环、重复写入、连接期间 disable 不卸载。

## 13. 限制与未完成项

- **未做**：Addon 热重载/热替换（设计上不支持，重连才生效）；运行时卸载已加载包；
- **已验证**：固定 Fabric 组合的协商、注册表解码、公开动作和服务端复核。Forge 和 NeoForge 尚无纵向证据。
- **未做**：`serverRequirement` 的服务端探测（只做声明；`Compatible` 需要具体能力自己验证）；
- **已否决**：`/spectate` 方向的 SpectatorPlus 集成。这里有两个同名项目：Nahu 的 Spigot 插件提供
  `/spectate`；yzxoi 的 `SpectatorPlus`（1.21.11 分支）是 **Fabric 客户端 mod + Paper 插件**，只做
  观战数据同步（手持物/生命/快捷栏/饥饿/经验/打开的容器界面），**没有 `/spectate` 命令**。
  Bot 作为**观察者**既没有 GUI 可看，也没有客户端 mod 可装，这条方向不做。
- **已落地**：`packages/spectatorplus` 只做**被观察方向**的界面桥——个人背包是客户端视图，
  服务端不知道它开没开，上游留了 `opened_inventory_sync` 通道但 Fabric 端按 1 字节布尔解析，
  所以 Uina 只需要在窗口事务起止各发一个字节。见 §8.5 与 §11。
- **未覆盖**：Paper 端不支持。同一通道在 Paper 插件里读 0 字节、只当"打开"，没有关闭分支；
  支持它必须改服务端插件（上游范围），本仓库不改、也不发对端会误解的字节。
- **未覆盖**：非 1.21.11 协议（`registerChannels` 与 custom_payload 编解码按 1.21.11 窄口）；
- **已知**：Addon 事实的**当前值**不跨连接继承（连接级内存表，断线清空；`connection` 域
  保留到断线，`incarnation` 域换代即失效）。每次发布产生的 `addon.fact@1` 采集证据会进
  证据流与历史库用于追溯，但不会被当成下一次连接的当前状态；
- **已知**：`minecraft:register` 是 1.13+ 传统机制；若服务端实现不再支持，需要按版本适配。
