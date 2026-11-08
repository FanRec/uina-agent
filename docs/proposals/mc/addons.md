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
pnpm mc:addon -- install .uina/worlds/minecraft/packages/spectatorplus
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

`packages/spectatorplus`（正式包）：只用既有 `chat@1` 发 `/spectate <target>`，再读 `world@1`
的 `gameMode`；没有插件时如实 `EFFECT_UNCONFIRMED`（dispatch `sent`），不假装成功。
HUD/GUI/附身界面属于真实 Java 客户端 Mod，Bot 侧不覆盖。**SpectatorPlus 服务端插件是外部
依赖，不由本仓库分发**；`serverRequirement` 只是声明，装没装由运维确认。

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
npx vitest run tests/mc/mc-addons.test.ts tests/mc/mc-addon-protocol.test.ts tests/mc/mc-protocol.test.ts
```

真服（先启动 dev-env Paper，含 `uina-example-plugin`）：

```bash
pnpm dev:mc:addons
```

`dev/addons-live.ts` 覆盖 9 步：安装≠启用、未启用不暴露、连接期间冻结、重连装配生效、
初始事实未知、纵向写入闭环、重复写入、SpectatorPlus 诚实失败、连接期间 disable 不卸载。

## 13. 限制与未完成项

- **未做**：Addon 热重载/热替换（设计上不支持，重连才生效）；运行时卸载已加载包；
- **未做**：`prepare` 的"提供预构造 client"分支没有真服示例（类型与失败路径已实现）；
- **未做**：`serverRequirement` 的服务端探测（只做声明；`Compatible` 需要具体能力自己验证）；
- **未覆盖**：真实 SpectatorPlus 插件未安装——只验证了 `/spectate` 命令路径与无插件时的诚实失败；
  HUD/GUI/附身界面属真实 Java 客户端 Mod 职责；
- **未覆盖**：非 1.21.11 协议（`registerChannels` 与 custom_payload 编解码按 1.21.11 窄口）；
- **已知**：Addon 事实不持久化，跨连接不继承（这是设计选择：模组状态属于连接）；
- **已知**：`minecraft:register` 是 1.13+ 传统机制；若服务端实现不再支持，需要按版本适配。
