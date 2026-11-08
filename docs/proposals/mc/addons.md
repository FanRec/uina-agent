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
- 冻结计划带 `digest`（id/version/api/config 的 sha256 前 32 hex），出现在
  `session.status.active.addons.digest` 与 `directory.snapshot.selection.digest`；
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
```

- 安装 = 复制已校验的包目录；同 id 已存在时拒绝覆盖（`ADDON_ALREADY_INSTALLED`）；
- 卸载时任何 Profile 仍启用则拒绝（`ADDON_IN_USE`），先 `disable`；
- 活动会话继续使用它**已加载**的版本；安装/卸载/启停都不热替换当前连接。

## 6. 装配

`addons/loader.ts` 是 Companion 侧唯一 import 第三方代码的地方：

1. 只接受 Parent 预检过的 `AddonSelection`（纯值：id/version/root/entry/config）；
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

两种时机是同一条连接的两个阶段（`contracts/protocol.ts`）：

- `prepare(ctx)`：客户端创建前；可覆盖协议版本或提供预构造的 minecraft-protocol client。
  版本冲突或同时给 client 与 version 时显式失败；
- `attach(port)`：客户端已创建、登录/配置/Play 包都会到达；只读订阅 + 发布事实；
  返回的函数在连接退役时执行。

`ConnectionPort` 只暴露：`connection` / `incarnation` / `version` / `state()` /
`onPacket` / `onCustomPayload` / `onEvent` / `publishFact`。没有裸 bot、没有 socket、没有写入口。

### 8.1 通道注册（必须）

服务端**只向已声明可接收的通道投递** clientbound `custom_payload`。因此：

- `port.onCustomPayload(channel, handler)` 会先调用 `protocol.registerChannels([channel])`；
- `CallContext.protocol.send(channel, data)` 在发送业务负载前确保该通道已注册；
- 注册使用 1.13+ 的 `minecraft:register` 负载（NUL 分隔通道名），每连接每通道一次；
- `attach` 早于 login：登记会排队，`login` 进入 play 阶段后自动补发，不在错误协议阶段写入。

这是传输层订阅，不改变世界状态；真正的写入仍然只在 BodyScope 内。

### 8.2 写入

`ProtocolWritePort.send(channel, data)` 只在 `callCtx.withBody(async (scope) => …)` 的
`scope.protocol` 上存在；普通调用拿不到写端口。通道必须是合法 ResourceLocation，负载 ≤ 32767 字节，
否则发送前 `INVALID_INPUT`（不把"服务端静默丢弃"伪装成已生效）。

### 8.3 事实

- `port.publishFact(key, value, unknown?)` → `FactsSource.publishAddonFact` →
  `ClientFactView.addonFact(addonId, key)`；
- 只接受纯 JSON；函数/循环引用显式抛错，不写半成品；
- 事实绑定 connection/incarnation；`connecting` / `disconnected` 清空，旧连接迟到的发布被丢弃；
- `unknown` 非空时 `coverage: "partial"`；没有发布过的 key 返回 `null`，不返回零值对象。

### 8.4 生命周期

`isCurrent()` 按连接代次判定；`dispose()` 解除全部订阅与 attach 登记的释放函数；
单个 addon 监听器抛错被隔离（记录后继续），不打断底层订阅链上的其它订阅者。

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
npx vitest run tests/mc/mc-addons.test.ts tests/mc/mc-addon-protocol.test.ts \
  tests/mc/mc-local-screen.test.ts tests/mc/mc-client-screen.test.ts tests/mc/mc-protocol.test.ts
```

`mc-local-screen` 覆盖个人背包边界（equip/toss/2×2 各一对、失败与取消只收尾一次、
并发被拒时不产生事件、没有包接收时不补发 close、展示口抛出不改变物品结果）；
`mc-client-screen` 覆盖 ClientHost 的身份校验、通道声明顺序与单包失败隔离。

**观察者画面验收没有自动化**：需要真服 + 真实 Fabric 客户端 + SpectatorPlus 客户端 Mod，
按 §11 的包配置人工确认。单测只证明"事件成对、字节正确"，不能替代肉眼/录屏。

真服（先启动 dev-env Paper，含 `uina-example-plugin`）：

```bash
pnpm dev:mc:addons
```

`dev/addons-live.ts` 覆盖 8 步：安装≠启用、未启用不暴露、连接期间冻结、重连装配生效、
初始事实未知、纵向写入闭环、重复写入、连接期间 disable 不卸载。

## 13. 限制与未完成项

- **未做**：Addon 热重载/热替换（设计上不支持，重连才生效）；运行时卸载已加载包；
- **未做**：`prepare` 的"提供预构造 client"分支没有真服示例（类型与失败路径已实现）；
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
- **未验证**：真实 Fabric 观察者客户端的画面验收。自动化只覆盖到"事件成对 + 字节正确"，
  "观察者真的看到了界面"必须在真服 + 真客户端上肉眼确认，不能用单测代替。
- **未覆盖**：非 1.21.11 协议（`registerChannels` 与 custom_payload 编解码按 1.21.11 窄口）；
- **已知**：Addon 事实不持久化，跨连接不继承（这是设计选择：模组状态属于连接）；
- **已知**：`minecraft:register` 是 1.13+ 传统机制；若服务端实现不再支持，需要按版本适配。
