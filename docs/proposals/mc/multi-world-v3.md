# Uina MC World 多世界自治设计 v3

> **入库状态（2026-11-05，批25 收口时归档原文）**。本文是"方案 02"（多世界自治）的施工合同原文。**M1（数据根与全局所有权）、M2（长驻 World + 连接控制）、M3.1（离线 describe/library）已于批25 落地**——现行合同以 [public-api.md](public-api.md) 批25 实现说明与 [modules/executor.md](modules/executor.md) §3/§7 为准，落地差异（连接回执形态、迁移锚点、验收缩样）见 [development-plan.md](development-plan.md) §10.3 批25 条与 [changelog.md](changelog.md) 同日条。**批26 剩余：M3.2/M3.3（RuntimeArchiveReader、profile 查询参数、跨 Profile 离线 saveFromRun、DeliveryPump profile/visit envelope）与 M4（完整迁移仪式）**，测试矩阵剩余 T13/T14/T15/T17。正文保留原文，不作追改。

目标：Uina 自己选择服务器/离线玩家名/世界绑定，进入、退出、切换；同一 Minecraft World 始终可用，能够离线查询资料和历史、保存并迭代程序，任何旧游戏执行域不能跨世界控制新的客户端。本文定义实施合同，不声称当前源码已支持。基线 main@012243586。

## 1. 需求与不变量

能力：

1. 不预登记也能输入 Java 服务器地址、端口与离线名；能保存常用服务器别名；支持显式绑定世界 ID 与存档修订号。同一 World 启用后不自动入服。
2. 能查询会话状态、已访问 Profile，连接、断开、切换；同一时刻只有一个活跃 Minecraft 客户端。失联不移除 World。
3. Program、Blueprint、Experience 在所有服务器间共享。世界地点/建造记录按世界修订号隔离；Run/Call/Effect 和游戏会话结果按持久 Profile 隔离。
4. 同 Profile 再访问可读到原先执行记录，不自动恢复旧 JS 栈、未完成 Run 或物理动作。另一个 Profile 的 Run/事件可以离线只读，不要求为查看结果重新登录旧服务器。
5. 主脑决定做什么和何时重新连接；MC World 不制造专用 Agent、GoalManager 或自动任务迁移器。动作和学习仍经原有 Native Capability/Program。

硬不变量：

- I1：单活跃写源。一台 Uina Host 在同一 Minecraft 数据根下，任何时刻最多存在一个由该根授权的 MC Companion/游戏客户端；跨 Profile 也成立。主进程异常后也必须由 Native Job 所有权证明无旧写源。
- I2：执行域不热切换。`ExecutorConfig`、Runtime/World/Driver、Program guest 在单次 Executor 内保持不变。切服必须完整退役旧执行域，再新建。
- I3：事实归属不混淆。Run/Effect/Delivery 属于 Profile；事件证据属于 binding/world/revision；地点记录属于 world/revision；普通资产共享。所有通知携带 Profile/连接代次；跨 Session 的只读 API 不能改变旧状态。
- I4：不假装已验证。`Executor.phase=ready`、`ClientHost ready`、Owner Gate 开放、World History ready 各是独立事实。world/revision 是声明的本地关联，不是服务器存档身份证明。
- I5：Run 终态诚实。旧程序不重放，不用"关闭成功"推断服务端动作已经完成；遗留外部效果可为 unknown，Host Receipt 之外不冒充 Completion 已交付。
- I6：运行机制不重建。继续复用 Runtime/Owner/BodyLeaseQueue/Effect、QuickJS/Program、DriverProtocol、World 证据分区和当前 Host Delivery；仅改组合、所有权和有明确价值的接口。

## 2. 架构与依赖方向

```text
Uina 主体（决定是否连接、目标、程序、学习）
             │  World tool: minecraft
             ▼
Minecraft World activation（轻量常驻，不打开 Bot）
  ├─ CapabilityCatalog（静态 descriptor；无连接可 describe）
  ├─ SharedLibrary（对外写/更新；离线可用）
  ├─ ArchiveRead（历史/profile/Run 的只读查询）
  └─ SessionController（唯一会话生命周期拥有者）
         │ 串行的 connect/disconnect；并行当前会话 action
         ▼
  MinecraftExecutor（一个时刻最多一个）
    ├─ Windows Native Ownership（稳定 MC 根目录）
    ├─ Ledger + IPC（持久 Profile 的 Session 数据目录）
    ├─ DeliveryPump（按当前 Profile/visit 交付）
    └─ Companion（创建一次、关闭一次、只装配）
          ├─ ClientHost/Driver  ─> Mineflayer/DriverProtocol
          ├─ Facts ────────────> MinecraftWorld/HistoryIngest
          ├─ Runtime ──────────> PlayerPort, WorldPort, ProgramPort
          ├─ Program ──────────> QuickJS guest；只经 Host API 访问能力
          └─ BoundCapabilities -> 现有 Native Capability 及可信模块
```

数据根：

```text
稳定 MC 根 ─ world-history.db / library / settings / sessions
Profile 数据 ─ executor.db / runtime.db / runs / exports
```

依赖规则：

- SessionController 仅使用 Executor / Facade 的公开端口；不知道 Bot、RuntimeEngine、SQLite 表的内部细节。
- Executor 只控制受管进程/IPC/ledger，不理解服务器存档语义或玩家目标。`Companion` 读取单次不可变 Config，注入已有接口；它不决策是否切服。
- Runtime 只依赖 WorldPort、`PlayerPort`、`ProgramPort`、`NativeCallable`；`Driver` 不依赖 Uina 主脑或 SessionController。
- World 负责观察、证据和领域记录；不负责服务器地址列表。`Library` 负责可读写工作文件；不成为另一份全局记忆数据库。
- Capability 静态 descriptor 与运行时绑定实现同源（见 01-F4）；不能把 session.connect 注册为可被当前 QuickJS Guest 调用的 mc.call，它会销毁自己所在的执行域。只有顶层 World 工具允许连接管理。

只新增一位会话生命周期所有者 SessionController。`ArchiveRead` 是只读存储访问函数集；`SharedLibrary` 是已有 Library 的常驻装配；`CapabilityCatalog` 是静态定义索引，不是 Manager/Agent。

## 3. 名称：五个不能混淆的身份

| 标识 | 定义与寿命 | 作用 |
|---|---|---|
| world + worldRevision | 本地稳定的逻辑存档绑定；Uina 可显式选择或根据 endpoint 建默认别名 | 世界级 places/records 分区；换档必须换 revision |
| profileId | 持久的 endpoint + auth principal + 离线用户名（保留大小写）+ world/revision + slot 的摘要 | Run/Effect/Ledger/Program 快照分区；重访同一 Profile 复用 |
| binding | 当前 Profile 的持久 worldOwner，从 executor.db 身份读出（如 binding:<worldOwner>） | Event 证据分区；同一 world 的不同玩家事件不无意合并 |
| visitId | 每次执行 session.connect 创建的新 UUID；结束后永不复用 | 顶层 action/通知防陈旧交付；与 Profile 可多次访问对应 |
| launch / Driver conn,inc | 伴生进程启动代次 / 连接与角色化身代次 | 原生 Job、IPC、身体撤销与旧端点隔离 |

不要把 Native accountKey() 当成 profileId、worldId 或玩家 UUID：它目前将 host 和 username 小写化，只适合进程独占标识。同一个离线名在不同服务器不等于同一个 Minecraft 账户；实际 UUID 可能受代理/插件影响，不能通过离线名计算后声称得到服务器认证。

profileId 计算示意（实际使用规范编码和 SHA-256，不用未定义 JSON 序列化顺序）：

```typescript
type ProfileIdentity = {
  endpoint: { host: string; port: number };
  principal: { kind: 'offline'; username: string; slot: string };
  world: string;
  worldRevision: string;
};

function profileId(identity: ProfileIdentity): string {
  const { endpoint, principal, world, worldRevision } = identity;
  return sha256(JSON.stringify([
    'mc-profile-v1', canonicalHost(endpoint.host), endpoint.port,
    principal.kind, principal.username, principal.slot,
    world, worldRevision,
  ]));
}
```

- canonicalHost 对 DNS 做统一大小写/尾点/IDNA 规范化，对 IP 采用规范形式；不 DNS 查询后把两个地址合并。host 仅允许主机/IP，不含 URL 路径；默认端口 25565。
- username 大小写原样存入 Profile；`slot` 默认 default，仅在需要区分同 endpoint/用户名但实际身份不同的情形显式提供。`slot` 不是另一个账户管理系统。
- 首次连接未给 world 时，生成 endpoint:<canonicalHost>:<port> 对应的默认本地 world 关联，revision 初始为 default，并在状态里标为 source:'endpoint_default'（不是已证实相同世界）。用户显式选择 {id,revision} 时 source:'explicit'。
- 重访时观测到的 actualUsername/actualUuid 能拿到多少记录多少；已保存非空值发生矛盾时拒绝继续使用旧 Profile，不得已打开该 Runtime 后在连接中途把 DB 改绑。Uina 可选择新的 slot 或修订世界关联；不猜 UUID。若服务器根本未提供权威 UUID，仅报告未知而不是填推断值。
- 网络代理在不重连时更换实际存档、地图被服主重置等情况，当前协议没有一般性的可靠世界身份证明；要求由 Uina 明确重新绑定/revision，不能凭坐标和维度自动确认。

## 4. 存储布局和写入所有权

```text
<worldDataDir>/                   # 稳定 MC 根（现有 Host 提供）
  settings.json                   # 可选默认用户名/服务器别名；可手工编辑
  world-history.db                # **共享**，当前 SQL schema v4
  library/                        # 普通共享工作文件，唯一 MC Library API 写入入口
    programs/
    blueprints/
    experiences/
  sessions/
    <profileId>/
      identity.json               # 不可变的 ProfileIdentity，另记首次观察到的登录身份
      executor.db                 # 原始 worldOwner/storageId、launch、门、请求、delivery attempts
      runtime.db                  # Run/Segment/Call/Effect、决策及完成记录
      runs/                       # 程序源码固定快照（当前 Program 已使用）
      exports/images/             # 派生图片缓存（引用可能仍由上层持有，不任意过早删除）
```

不要按 world 再分多个历史数据库。当前 SQLite evidence/streams 已按 (binding, world, world_revision) 分区，`records` 已按 (world,world_revision,ref) 分区；一份历史库即可容纳多世界。历史库共享并不意味着所有记录对所有玩家透明：`events@1` 保留 binding 边界；`places@1` 在同一 world/revision 下跨 Profile 共享。

数据库打开者：在线 HistoryIngest 作为共享 world-history.db 的唯一写方；World 常驻的 ArchiveRead 使用 SQLite 只读连接进行离线/跨 Profile 查询，短事务并及时关闭；`runtime.db` 只有当前 Profile 的 Runtime 是写方，其他 Profile 可通过 ArchiveRead 只读访问。SQLite WAL 本机使用；不把 DB 放在 SMB/跨机器共享目录，不用两个写方并行迁移 schema。历史库原 storage_id 保留，避免使旧 event tokens 虚假有效/全部重写。

Library 写入者：World 常驻层持有正式 Library API（即使 disconnected），`list/get/save/update/delete` 走一个 createLibrary 及统一程序校验入口；Companion 仅直接从 library/ 读取程序和蓝图，程序进入 Run 时照旧 writeSnapshot() 固定源码。删除 Companion 的 library 写 RPC/双写入口。Uina 通过通用文件工具直接修改工作文件仍然允许，但这不由 MC Library API 序列化；读取时必须重新按 digest 验证，不能假定缓存不会过期。

save from run 是可信来源核验而非普通 copy：把现有 library/origin.ts 的 readRun/readRecord/readSnapshot 依赖接到只读的 Profile Archive（或当前活动 Executor），核对原 Run/Segment/Call 和 SHA，才发布到共享 Library。这样 Uina 即使离开服务器 A 也能把 A 的已执行程序保存为复用资产。程序编译校验从现有 Program.validate 提取独立的无 Bot 校验入口，在线和离线共用规则，不重复写两个编译器。Host 通过正式 Library API 发布 program 保存/更新/删除后，向当前 Companion 发送窄的 runtime.programChanged 通知，使其撤销过期的 program 目录/缓存；通过通用文件工具直接编辑时，后续 Program 解析必须重新读取并校验 digest，不能假定必有此通知。

所有 identity.json 与用户配置以普通文件写入；不能通过编辑 executor.db/runtime.db 伪造状态。`identity.json` 创建在第一次 Executor 启动前，且后续重访必须先比较内容；登录观测信息可另写 observed.json，避免把"不可变身份"和"可更新观测"混为一文件。

### 4.1 必须额外拆分：所有权根 ≠ 持久化根

这是旧 v2 最容易造成真实事故的地方。当前 MinecraftExecutor.open() 调用 acquireOwnership(root, accountKey(config))；Windows Native directoryName 基于该目录的 Windows FileId 创建命名 Job，使用 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE。如果简单把 root 改成 sessions/<profileId>，跨 Profile 就失去了统一的目录 Job，另一个进程可能同时启动不同 Profile 的客户端。

因此 Executor 必须明确两类根：

```typescript
MinecraftExecutor.open({
  ownershipDir: minecraftRoot, // 所有 Profile 共用；Native 目录 Job 唯一
  sessionDataDir: join(minecraftRoot,'sessions',profileId), // ledger/runtime/snapshot
  sharedDataDir: minecraftRoot, // world-history/library
  config: immutableExecutorConfig,
  policy: { autoRecover: false },
  signal,
});
```

- acquireOwnership(realpath(ownershipDir), accountKey(config)) 先取得跨 Profile 目录 Job；任一新会话必须等旧 Executor 释放 Job，不能只检查旧 PID。
- ExecutorLedger.open()、`runtime.db`、`runs/` 使用 sessionDataDir；Companion 的 World History/Library 分别读取 sharedDataDir/world-history.db、`sharedDataDir/library`。
- accountKey 仍用于账号附加锁；它不能取代共享的目录 Job。内核锁的事实不由 SessionController 自建 lock-file 模拟。
- Host 进程崩溃时，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 使受管子进程退出；旧 Job 真正释放前，新 Host 不能获取同一 ownershipDir。此保证需要对应原生集成测试验证。

## 5. 外部 API（在现有 minecraft World Tool 内）

不添加第二个工具或独立 ServerManager。已有 observe/describe/run/runs/chat/library 保持，新增 session；仅扩展有真实跨 Profile 需要的只读参数。

```typescript
type SessionAction =
  | { op: 'status' }
  | { op: 'list' } // 从 sessions/*/identity.json 列出已访问 Profile
  | { op: 'connect'; target:
        | { host: string; port?: number; username?: string; slot?: string;
            world?: { id: string; revision?: string } }
        | { server: string; username?: string; slot?: string;
            world?: { id: string; revision?: string } } }
  | { op: 'disconnect' };

// 其他动作：
// describe：任意时刻可用；从静态 catalog 取得
// library：任意时刻可用；普通文件管理 + 从旧 Profile Run 存入程序
// observe：无 profile 时当前 Session；带 profile 时仅历史查询
// tasks：操作归属当前活动 Profile，历史任务需重连原 Profile 查证
```

具体样例：

```text
{"action":"session","params":{"op":"connect","target":{"host":"mc.example.net","username":"Uina","world":{"id":"survival","revision":"r1"}}}}
{"action":"session","params":{"op":"connect","target":{"server":"home"}}}
{"action":"session","params":{"op":"list"}}
{"action":"session","params":{"op":"disconnect"}}
{"action":"tasks","params":{"op":"trace","task":"<task>","record":"<recordRef>"}}
{"action":"observe","params":{"selector":"places@1","profile":"<profileId>","input":{}}}
```

- server 仅从普通 settings.json.servers 解析，不是数据库注册要求；host 任意输入即连接。`username` 默认读取 settings 的 defaultUsername，缺失则 INVALID_INPUT，不擅自选一个身份。
- connect 已包含切换。与当前目标相同且客户端 ready，幂等返回；同一 visit 正处于重生 syncing，也直接返回当前状态，不把正常重生误作重连。同 Profile 已真正掉线才关闭旧 Executor 并创建新 visit。Owner Gate 关闭但客户端在线时不重新连接、不清 gate。
- version 暂不开放自由字符串或 auto；初版唯一合同为 offline+1.21.11。以后协议能力矩阵验收完成，再扩展 ConnectInput 版本字段。登录凭证不出现在 settings、LLM 参数或 Program。
- observe 离线带 profile 只允许 events@1、`places@1`，不允许会话当前值、`near`（没有实时玩家位置）、`route.plan` 等。复用当前事件 token/过滤逻辑，并把 profile 的真实 binding/worldRevision 用作 scope；默认不跨玩家合并聊天。Library/Archive 不制造"当前游戏观察值"。
- 已交付的 `tasks` 只查证当前活动 Profile。原任务句柄自带归属。跨 Profile Archive 查询仍是后续设计。
- run/observe(current)/chat 在无活动连接时返回 NOT_CONNECTED。`tasks` 在无活动会话时返回 NOT_CONNECTED；重连原 Profile 后可查询过去的任务。

### 5.1 Status 不混淆状态层

```typescript
interface SessionStatus {
  state: 'disconnected'|'connecting'|'syncing'|'connected'|'disconnecting'|'faulted';
  active: null | {
    profileId: string;
    visitId: string;
    target: ProfileIdentity;
    connection: 'connecting'|'syncing'|'ready'|'disconnected'|'faulted';
    actualUsername: string | null;
    actualUuid: string | null;
    worldAssociation: 'explicit'|'endpoint_default';
    executorPhase: 'starting'|'ready'|'faulted'|'closing'|'closed';
    actionsAllowed: boolean;
    ownerGates: string[];  // 来自现有 Owner，不造另一份状态
    history: 'opening'|'ready'|'unavailable';
  };
  operation: null | { kind: 'connect'|'disconnect'|'close'; id: string };
  lastError: { code: string; message: string } | null;
  settingsPath: string;
  libraryPath: string;
}
```

state=connected 仅表示该 Profile 的客户端实际 ready 且身份核对通过。`syncing` 表示同一个访问中的死亡重生/换化身等暂不可行动状态，不是断线，不可据此自动重建 Executor；第一次登录到首次 spawn 仍记 connecting。Owner Gate 关闭时仍是 connected，但 actionsAllowed=false。顶层 actionsAllowed 至少要求 state=connected、当前 Executor 允许受理、且没有正在进行的管理切换；它表示可以受理运行请求，不保证每个 Native Capability 都具备所需环境。`Executor.phase=ready` 只代表 IPC/Runtime 可通信，不代表客户端在线。历史库不可用也不伪装成断线（相应历史操作失败）。

actualUuid 必须来自已核实的 Mineflayer/协议来源；如果当前实现不提供，先返回 null，同时做用户名与当前 Bot 身份核对。状态不要假装验证了服务器真实存档 ID。

## 6. SessionController：唯一管理操作的生命周期拥有者

```typescript
interface ActiveSession {
  profileId: string; visitId: string;
  identity: ProfileIdentity;
  executor: MinecraftExecutor;
  facade: MinecraftFacade;
  removeBody: () => void;
  // 外部通知只从这次 visit 的 delivery 拓扑派发
}

class SessionController {
  status(): Promise<SessionStatus>;
  list(): Promise<ReadonlyArray<ProfileSummary>>;
  connect(input: ConnectInput, toolSignal: AbortSignal): Promise<SessionStatus>;
  disconnect(toolSignal: AbortSignal): Promise<SessionStatus>;
  execute(action: string, params: object, toolSignal: AbortSignal): Promise<ToolExecutionResult>;
  close(): Promise<void>; // World onStop 的最终所有权收口
}
```

不要新增 ServerManager / RuntimeManager / BodyManager / SessionPool。Controller 只保存 active、`transition`、`closing`、`lastError`；Run/Owner/ClientHost 的实际状态依然由对应模块拥有。`settings.json` 由普通文件函数读取。`session.list` 扫 identity.json，无需 Profiles DB。外部传入的 profile 只能是由本系统生成的固定格式摘要（例如 64 位 hex）；用于拼磁盘路径前验证，不允许任意相对路径。

### 6.1 串行管理操作与并行游戏操作

- WorldDef.executionMode='parallel' 保留，`run/observe/chat` 继续按原 Broker/Runtime 并发模型运行。
- connect / disconnect 使用 Controller 内的单一 transition slot。同时来的第二个管理请求返回 SESSION_BUSY，不排队持有陈旧目标；`status` 始终可读。若旧进程未能退役，Controller 保留旧 Executor 引用与失败状态，不能清空指针后让下一次 connect 误以为没有旧客户端。
- 切换开始即封闭旧 facade 新受理并使 visitId 失效。已经受理的 Run 由旧 Runtime/Owner 停止；旧发起的工具等待不会被重新定向到新 Executor。返回值即使晚到也标旧 profile/visit。
- World.onStop 有更高的最终关闭优先权：标记 closing，取消尚未接入的新连接，等待当前管理操作收口，确认所有已创建执行域退役后才结束；不因为 SESSION_BUSY 而跳过停机。
- 顶层工具等待取消不等于停止已执行的切换：取消在管理操作开始前则无副作用；开始关闭旧域后，Controller 必须继续完成退役或报告停机未知，调用方随后以 status 查证。绝不能把工具取消回执当成旧客户端已退出的事实。

### 6.1.1 管理操作的最小编码骨架

以下是控制流伪代码，不是可直接编译的现有类型；关键是先收旧域、再启动新域，不复制 Runtime 内部状态：

```typescript
async function connect(input: ConnectInput, signal: AbortSignal) {
  const tx = controller.beginTransition('connect'); // 同步抢占一个管理槽
  let candidate: MinecraftExecutor | null = null;
  try {
    const target = await resolveTarget(input); // settings + canonical host + profileId
    if (controller.isSameReadyProfile(target)) return controller.status();
    if (signal.aborted) throw cancelledBeforeEffects();

    const old = controller.active;
    controller.blockNewGameAdmissions(); // 同步置换代次；新请求不再指向 old
    if (old) {
      old.facade.stopDeliveryAndAdmissions(); // 不等待主脑完整 turn
      old.removeBody();
      const closed = await old.executor.close();
      if (closed.process !== 'retired' || closed.ownership !== 'released') {
        controller.retainBlockedOwner(old); // 不能丢掉未退役对象引用
        throw sessionBlocked(closed);
      }
      controller.clearActive(old);
    }

    if (signal.aborted || controller.closing) return controller.disconnectedStatus();
    candidate = await MinecraftExecutor.open({
      ownershipDir: minecraftRoot,
      sessionDataDir: target.profileDir,
      sharedDataDir: minecraftRoot,
      config: target.executorConfig,
      policy: { autoRecover: false },
      signal: controller.lifetimeSignal, // World disable 可收口新建中的 Companion；不是工具等待信号
    });
    const ready = await candidate.waitGameConnection(); // 真实 ready/失败回执
    if (ready.state !== 'ready') throw connectFailed(ready);
    await verifyObservedIdentity(target, ready);

    controller.publishVisit(candidate, target); // 只有这里开始注册新 Body/Delivery
    candidate = null; // ownership 已转移给 active
    return controller.status();
  } finally {
    if (candidate) await controller.retireFailedCandidate(candidate);
    controller.endTransition(tx);
  }
}
```

上述 retireFailedCandidate 不能吞掉所有权退役失败：若 Executor.open() 初始化失败（尚未返回实例），Executor 自身必须在抛错前确认进程/Job 已收口；无法确认则抛带所有权不确定事实的结构化错误，Controller 转 faulted/blocked。下一次尝试受相同的 Native 根目录 Job 约束，不能用另一个 Profile 根绕过。

disconnected/connected/faulted 由当前 ClientHost/Executor 的真实状态推导。具体地：管理操作进行中显示 connecting/disconnecting；否则有 ClientHost ready 且身份核对通过才是 connected；同 visit 的死亡重生/新 incarnation 同步显示 syncing；IPC 正常但 Bot 已失联显示 disconnected，Executor 故障/全局退役未确认显示 faulted。`lastError` 独立保存，不用它冒充连接状态。

### 6.2 退役三事实，而不靠异常文字猜测

当前 Executor.close() 可能在子进程已退出但 Runtime 非干净关闭时抛 EXECUTION_DOMAIN_UNRETIRED。v3 将执行域退役合同收敛为：

```typescript
interface ExecutorCloseResult {
  process: 'retired'|'unknown';        // 所有受管进程是否确认退出
  ownership: 'released'|'held';       // 目录 Native Job 是否释放
  runtime: 'clean'|'unclean'|'unknown';// 只决定旧记录如何恢复/审计
}
```

允许新 Executor 的必要条件：`process='retired' && ownership='released'`。runtime='unclean' 仅影响旧 Run 的 cancelled/unknown 恢复语义，不自动导致不能切服；进程/锁未确认则禁止启动第二个客户端。关闭结果可由 Executor 内部状态或结构化错误产生，绝不从 String(error) 猜判定。

该合同本身足够，不必新增分布式事务、独立 lock-file 和自研心跳租约。Windows Native Job 已经具备目录和账号独占及进程退出等待能力。

### 6.3 新连接就绪、失败与身份核对

当前 openExecutionSide() 异步启动 host.connect()，`Executor.open()` 成功可能仅表示 Runtime 已 attach；`ClientHost.connect()` 在失败时也会正常 resolve。必须新增窄的 connection.wait RPC 或同等明确的连接终态回执，等待 Driver 实际 ready/faulted/disconnected。不得靠 await Executor.open() 判断入服成功。

操作顺序：

1. 解析 target/defaultUsername/world 关联，规范化并算 profileId
2. 检查 slot 与身份文件；选择 sessionRoot；声明本次 visitId
3. 若旧会话存在：撤销旧 facade 新受理 → 停止旧通知入主脑 → Runtime Owner Gate 收口 + 旧 Executor close → 确认 process retired / Job released
4. ownershipDir 仍是**稳定 MC 根**；获取全局 Native Job
5. 初始化/校验该 Profile identity.json；读取既有 ledger/runtime
6. 新建 Executor（autoRecover=false），Runtime/World/Program/Driver 绑定本 Profile
7. 等待真正的 ClientHost ready，连接超时/被踢/协议不符均失败
8. 核对 observed username；UUID 有可靠来源时与既有观测比较
9. publish ActiveSession、注册当次 Body Endpoint，启动 DeliveryPump
10. 返回状态；不自动运行旧 Program

步骤 (5) 实际应由锁持有期间的 Executor.open 受控初始化完成，Controller 不直接篡改 Ledger。首次写 identity.json 在连接前，避免失败重连变成无身份遗留目录。运行时绝不迁移/改写已经打开的 Profile 根。

失败：

- 连 B 失败：A 已退出，不自动切回 A；关闭 B 的半初始化 Executor，返回 disconnected/faulted + lastError；B 的失败尝试可以留下可校验的持久 Profile 记录。
- 切 A 时无法证明 A 进程退役或所有权释放：B 不得启动，保留 blocked/faulted 状态及错误，提供再次查看/人工恢复渠道；不设"时间到了就假定安全"的兜底。
- 只断开 Bot 但 IPC/Runtime 尚好：`status.connection='disconnected'`，不是 executor.phase='faulted' 的同义词；下次 connect 仍先退役整个旧 Executor。
- 相同 Profile 且 Bot 在线但 owner_lost/emergency 关闭：`connect` 直接返回现状，不以重连绕过 Gate。恢复原 Gate 必须经既有 CAS 明确操作。
- 无 actualUuid：不宣称已经核对 UUID；若出现可证实的身份矛盾，则拒用旧 Profile，要求新 slot 或显式选择新世界绑定。

### 6.4 Body 和通知

bodyId = 'minecraft:' + visitId，不能再以当前 accountKey().slice(0,16) 当作同一个长期身体实例。先摘除旧端点注册（对旧端点引用也需把 state().online 置 false 或保证方法拒绝），再暴露新端点；`safeStop` 仍使用旧 Executor 的真实 Owner Gate 语义，不靠卸载 endpoint 来停止身体。

GameNotice/Host Event 添加 {profileId,visitId} envelope；只有仍属于当前 visit 的一般游戏事件能进入当前推送。跨服务器的自动化由 Uina 主体或现有通用 Activity/Skill 顺序调用顶层 session 工具完成，不能在即将销毁的 Minecraft guest 里直接调用 mc.call("session")。已提交 Host Receipt 的旧 Completion 不能撤销；未确认投递留在旧 Profile Runtime/ledger 里。`DeliveryPump.close()` 停止新投递、收口本地正在执行的轮询，不能等待一个可能涵盖完整主脑回合的 emitEvent 返回。旧 render callback 不能在切换后调用新 Executor。

session.connect 的返回值应包含旧 Profile 的收口摘要（停止/未知 Run 数、未确认 Completion 数，如可得）和新 Profile 状态。需要详细结果时使用 runs.record({profile:old})。数据保存与通知确实送达是两种不同结果；不要把持久 DB 写入等同于用户已经看到消息。

## 7. 无连接时的资产、目录和历史读取

这是长期自治所需的正常业务能力，不是运行时兜底。

1. describe：01-F4 静态 descriptor catalog，永远无须连接；动态可用性只声明 offline/unknown/ready，不伪造游戏观察。
2. library：正式 list/get/save/update/delete 常驻。Program 校验复用独立 ProgramValidator，`saveFromRun` 按 profile 查 Run/Call/固定源码快照，不能按名字猜原文件或重放程序。
3. session.list：遍历每个 Profile 的 identity.json/observed.json，给出 profileId、endpoint、用户名、world/revision、最近访问状态（未持久化可用 null）。不建登记数据库、不要求连接时先 list。
4. runs.{list,record,calls,request}：抽取当前 Runtime 查询到纯只读 RuntimeArchiveReader（复用 storage-queries 与行格式）；不能通过新建 Executor/启动 Bot 查询旧 Profile；不提供离线 stop/retry/recover/continue。
5. observe({profile,...})：仅 places@1/events@1。从共享历史库按该 Profile 已保存的 world/revision/binding 读取；既有 cursor 的 storage/partition 校验与缺口语义维持原样。`near` 因无实时自我位置显式失败。
6. Program 读取共享资产直接从 library/programs；运行中的 Run 继续固定自己的源码快照，修改同名 Program 仅影响后续 Run。

### 7.1 不重新打开 Runtime 的离线结果如何表示

当前 Runtime 的非正常停机恢复是在 MinecraftRuntime.open() 中结算的。不能因为 Profile 已离线，就把 runtime.db 里最后持久化的 running/stopping 行直接展示成"仍在运行"或"已经取消成功"。

- 归档读到完整已提交终态：按原始终态返回。
- 归档读到非终态且该 Profile 不是当前可直接查询的 Runtime：返回 recordedPhase + outcome:'unknown' + recoveryPending:true 的只读投影；若已证明旧执行域退役，再返回 execution:'not_running'，否则 execution:'unknown'。不修改数据库、不重放程序。
- 当前活跃 Profile 的 runs 查询走现有 Runtime RPC，不能用可能滞后的 SQLite Archive 代替实时状态。
- 重新进入该 Profile 时，由现有 Runtime 恢复程序写回合法的 cancelled/unknown 终态，此后归档反映新结果。`Completion` 只有在持久恢复完成后才能按真实生成/投递，不能预先虚构一个通知。

归档层只做状态解释，不拥有 Stop/Recover/Delivery 写权限。

只读实现边界：将 world/sqlite-worker.ts 中的历史查询 SQL 和 runtime/storage-queries.ts 中的只读访问分别抽成复用函数，Host Archive 与 Companion Writer 使用同一 SQL/值解释，不复制一套"简化数据库模型"。连接由短生命周期的只读 worker/DatabaseSync 负责；只读打开必须能读取仍在 WAL 中的已提交内容，不能在在线写方存在时随意使用忽略 WAL 的 immutable=1 模式；短事务避免阻塞 checkpoint。查询归档时禁止写 schema/触发恢复结算。只有实际 Owner 所在的 Runtime 可以改变执行状态。

## 8. Settings 与 Profile 建档

settings.json 为普通文件，每次 session.connect 重新读取；不用监听变更/动态订阅配置：

```json
{
  "defaultUsername": "Uina",
  "servers": {
    "home": {
      "host": "127.0.0.1",
      "port": 25565,
      "world": {"id": "home-save", "revision": "r1"}
    },
    "friend": {"host": "example.net", "port": 25565}
  }
}
```

- Uina 通过通用文件工具可以直接编辑这份设置，也可以不保存任何主机名而直接 session.connect(host, ...)。
- worldRevision 由 Uina 对存档重置明确更新；同 IP 重开地图默认无法自动识别，需要状态显示关联来源。
- identity.json 不可变：只包含 ProfileIdentity 和 schemaVersion，world/revision 即由 ProfileIdentity 指定；`observed.json` 保存可验证登录信息及更新时间。已有 worldOwner 只以 executor.db 为权威，事件 binding 由此派生，不在 identity.json 复制 Owner 身份。
- 账号凭据未来应从 Host 的已授权安全存储注入，不出现在 settings、program source、LLM 工具参数。首版只支持 offline。
- 修改源码或可信 Native Module 后在下一个 Companion 启动/World 重新加载时生效，不尝试热替换已有物理控制域。

## 9. 代码与文件改造图（最重要的落点）

| 文件 | 改造/新增 | 责任与接口 |
|---|---|---|
| worlddef/index.ts | 重构 | onStart 创建长驻 Controller/静态 Catalog/Library；不读取固定 config 并启动 Bot；`onStop` 调 Controller.close |
| worlddef/schema.ts | 重构 | 增 session；`observe`/只读 runs 支持 profile；短指南，具体能力用 describe |
| worlddef/session-controller.ts | 新增 | 唯一活跃 Executor、串行 connect/disconnect、visit、开关门、stop 与状态聚合 |
| worlddef/session-identity.ts | 新增纯函数 | 规范化 host、计算 profileId、处理默认 world、identity.json 的校验；不握活 Executor |
| worlddef/body-endpoint.ts | 改造 | 端点绑定 visitId；关闭旧端点并拒旧控制 |
| executor/index.ts | 关键重构 | 分 ownershipDir/sessionDataDir/sharedDataDir；close 返回 process/Job/runtime 三事实；默认无后台自动重进服 |
| executor/platform/index.ts | 尽量保留 | acquireOwnership 接稳定 MC root；Native 退役仍是权威，不另写文件锁 |
| contracts/executor.ts | 改造 | CompanionInit 接 sharedRoot、sessionRoot；连接等待结果、可观测身份（不重复 config.binding） |
| executor/protocol.ts | 小改 | connection.wait 或等价终态 RPC；Library 变更给 Runtime 的窄通知；沿用现有 IPC 错误合同 |
| companion/side.ts | 重构组合根 | World History 指 sharedRoot，Runtime/Program 指 sessionRoot；Loader 从共享 Library 只读；不自行决定服务器切换 |
| executor/facade.ts | 改造 | 依旧执行当前 Session 的 game actions；每个结果附 profile/visit；移走通用 Library 写入 |
| executor/delivery.ts | 改造 | 通知归属、切换时停止与未确认回执、避免旧 render 使用新 Executor |
| capabilities/index.ts, companion/directory.ts | 按 01-F4 重构 | 静态 descriptor 与动态 bind，同一来源供离线 describe |
| library/index.ts, library/origin.ts | 重构装配，不换存储形态 | Host 常驻 MC Library API、从 Run Archive 验证来源；Companion 只读资产 |
| program/index.ts | 小改 | Snapshot 仍在 sessionRoot；提取独立 validator 给离线 Library 使用 |
| world/index.ts, world/history-store.ts | 改根 | shared history DB，保留 binding 和分区；`places@1` 没有 near 时不需要 self 原点 |
| runtime/storage-queries.ts 等 | 复用抽取 | 归档 Run 查询使用只读路径；不复制 Runtime 引擎、不用 Executor 跨 Profile 查库 |
| world/sqlite-worker.ts | 复用抽取 | 只读 archive 重用 events/places SQL，保留已有 evidence/record 分区 |

源码类型和行为改变应直接更新 docs/proposals/mc/public-api.md、`modules/executor.md`、`modules/world.md`、`modules/library.md` 及开发计划。不要只新增一个 v3 文档却让旧规范仍声称固定配置/固定生命周期。

## 10. 实施顺序与可交付门

### M0. 重构前置（来自 01）

完成 F4（静态 Catalog）并确保连接状态来源可用；F1（断线证据）推荐先修。F2（生存状态）、F3（Watch）及其他独立优化可以并行，不构成切服的架构前置。不先实现短命的"在同一 Companion 换 Bot"重连方案。

### M1. 数据根与全局所有权（第一硬前置）

1. Executor.open 改为 共享 ownershipDir + 独立 sessionDataDir；更新 CompanionInit，先不开放动态切服。所有访问仍固定 config，但写入新 profile 根。
2. 拆开 world-history.db、Library 与 Runtime/Ledger/Snapshot 根。使旧数据新布局下单服开关、OwnerLost 恢复、Run 快照、Library 读取、World 记录保持正确。
3. 修改 close 为三事实结果；测试脏退出但作业进程确实已退出时能换目录重开；未确认或 Job 未释放时绝不开新 Companion。

放行：同一 stable root，两个不同 profileKey 的并发 Executor.open 只能一个取得 Native Job；原先单服所有 Run/控制/来源不变量仍成立。

### M2. 长驻 World + 连接控制

1. onStart 不再读取固定连接并开 Executor；创建 Controller + Catalog/SharedLibrary。World 启用默认不入服；`world_store` 仍负责启停，用户选择保持原有 enabled 偏好。
2. session.status/list/connect/disconnect，区分客户端 ready、Executor ready、Owner Gate、History ready。
3. connection.wait、身份文件、Profile 与 visitId；切换时安全退役并注册新 Body Endpoint；连接失败无自动旧服回滚。
4. ExecutorPolicy.autoRecover=false 用于本 Controller 创建的会话，避免伴生错误自动重入原服务器；如果 Uina 要恢复，调用 session.connect 走显式路径。

放行：A → B → A、同服务器不同 offline username、离线/失败连接、正在 Build/Goto 时切换、启动/停用并发、两次 connect 并发的真实测试。

### M3. 离线资料与交付归属

1. 静态 describe、常驻 library 与离线 validator；无连接可新增 Program 和 Experience。
2. session.list、只读 runs Archive、历史 places/events 的 profile query；`saveFromRun` 能从非活动 Profile 验证旧源码。
3. DeliveryPump 添加 profile/visit envelope 和关闭屏障；等待中的 Host Receipt 不假称已经提交，旧 Session 的 nextCall 可定向离线 runs.record。

放行：在 B 服务器能检索 A 的旧 Run/地点、从 A 的 Run 保存 Program 并在 B 执行；无需连接 A；旧 Completion 不被误标 B。

### M4. 迁移与终态清理

1. 迁移前停用 World、关闭全部 SQLite worker、确认旧 Native Job 退役。备份原 MC 根与 SQLite 数据（不能在 WAL 活跃时只移动裸 .db 文件）。
2. 读取旧 config.json + executor.db 的真实 worldOwner/storageId；将旧 executor/runtime/runs/exports 原样迁入一个 legacy profile，保持 ledger 身份和 Run/Effect 原始 ref。共享 world-history.db 保留原 storage_id、schema 与分区，Library 三类文件移动到 library/ 下。
3. 原配置转成 settings 默认服务器/默认 username，但不因为 World enabled 自动入服。旧 binding 非空：映射到相同 world/revision；旧 binding:null：保留历史原分区，明确显示 unbound，不伪造与新 worldId 的关联。若旧历史中有多个 launch 的 unbound 分区，归档按原有 (binding,world,worldRevision) 分别列出只读 scope；不能用一个新 ProfileIdentity 覆盖这些原分区。
4. 若 Profile 身份无法从旧配置确认，则保留旧数据作为只读 legacy archive，不强行生成可复用登录身份；让 Uina 显式选择新绑定。
5. 每一步完成前有备份、迁移记录及可重试检查；避免同时保留两份写时都声称是权威，迁移完成后只启用新布局。

放行：旧 Run 的查证与 program snapshot SHA 不变；原 places/events 可按原分区读到；迁移后再次关闭重开稳定；异常迁移不损坏原根。

## 11. 必需的测试矩阵

| 编号 | 场景 | 必须证明的性质 |
|---|---|---|
| T01 | World enabled，未调用 connect | status/list/describe/library 可用；没有 Bot/Companion 进程；游戏动作 NOT_CONNECTED |
| T02 | 任意 host/port/offline username 连 1.21.11 服务器 | 真实 Bot ready 才报告 connected；失败不返回假成功 |
| T03 | A→B→A（不同目标） | 同时最多一个进程树；A/B Run/Effect 不混淆；A 的 Profile 可重访 |
| T04 | A 同服更换离线用户名 | 新 Player/Runtime Profile；world/revision 相同的 places 可共享，事件 binding 仍隔离 |
| T05 | 同 IP 存档重置显式换 revision | 旧地点不出现在新 worldRevision；旧 archive 原样保存 |
| T06 | 旧 Run 在 goto/collect/build/fight/feedback/wait 中切服 | 不产生任何跨 Session 身体写入；旧结果不得错误变 succeeded |
| T07 | 旧进程未确认退役、Native Job 仍持有 | 拒绝启动新客户端；显示真实 fault；不会靠超时放行 |
| T08 | 旧进程已退出但 Runtime 脏关闭 | 可在 Job 释放后启动新客户端；旧 Run 依恢复证据归 cancelled/unknown |
| T09 | 双 connect、connect 与 disable 并发 | 管理操作串行；disable 最终停机；状态/错误无双执行域 |
| T10 | Bot 踢出/协议不符/超时、Executor IPC 仍正常 | 状态区分客户端掉线和 IPC；连接失败不自动连回旧服 |
| T11 | OwnerLost/emergency Gate 关闭且 Bot 仍在线 | state 仍 connected，actionsAllowed=false；connect 同 profile 不绕 Gate |
| T12 | Body endpoint 切换、旧事件/通知延迟到达 | 旧 endpoint 失效；旧通知的 profile/visit 保留，不能进入 B 的当前状态 |
| T13 | 通过未来独立的归档入口离线查询旧 Profile 的任务、记录、事件和地点 | SQLite read-only，无建 Bot、无 Run 恢复/写库；游标按原 partition 校验 |
| T14 | 旧 Profile 的 Completion 未取得 Host Receipt 后切服 | 保留未确认事实；重访正确 reconcile；不伪造已通知/不重复物理动作 |
| T15 | 离线 library.saveFromRun(A) 再在 B 执行 | Call 身份与 SHA 校验通过，Program 新 Run 用已确认内容，旧 Run snapshot 不变 |
| T16 | 同一 world 不同域名、同域名不同真实存档 | 只有显式关联决定记录是否共享；默认仅是 endpoint 约定，不做"自动识别" |
| T17 | Migration：旧 binding 非空及 null、旧 WAL/Runtime/History | worldOwner/storage_id/Run ref 保持，未绑定历史不误归属；备份与重复执行正确 |
| T18 | 30 分钟真实模型自主游戏，包含掉线/重连/切服 | 主脑能自行选择连接、复用程序、查询错误、处理 Owner Gate；常驻世界无死会话 |
| T19 | 角色死亡导致 syncing、旧 Profile 进程异常退出后只读查询 | syncing 不重连；离线未结算 Run 显式 unknown/recoveryPending；只有确认旧进程退出才说 not_running |

测试层级：纯函数/文件系统/SQLite/IPC/原生 Native Job → 真实 1.21.11 服务器 → 完整 Host+模型。`pnpm typecheck`、指定 MC VMThreads 测试、`pnpm build` 与产物入口都要通过。历史真服测试只用于对照，不替代改造后的新事实。

## 12. 明确不实现的东西

- 无 MinecraftAgent、MC 内部 GoalManager、自动训练/学习线程、SessionPool、多 Bot 同时在线、跨服 Run 自动迁移。
- 不把 Tool 取消转译成"服务端动作一定停止"；不恢复 JS 调用栈、不重放不明的物理效果。
- 不增加另一套应用任务数据库来管理 Profile、服务器和世界；文件身份 + 当前 Ledger + 原 SQL 分区已经够用。
- 不因为 Mineflayer 可自动猜版本就宣称支持全部协议；不自动替模型登录 Microsoft；Forge/Fabric 客户端模组协议需要具体适配。
- 不把 Uina 可编辑的 settings.json 当授权凭证或运行状态。无需预先保存服务器、也无需给任意服务器创建白名单。
- 不为了"容错"自动切回旧服、自动绕开 Owner Gate、跨 Session 读取实时当前值、丢弃未确认 Completion。

## 13. 发布判定

只有 T01–T17、T19 的对应确定性/真服层次通过，且至少一次 T18 全链路验收，才称"单活跃多世界自治 v3"交付。第一阶段只声称 Windows x64、Java 1.21.11、offline 连接；跨平台、更多版本和授权在线账户分别立项。若无法通过 T07/T08 的全局进程独占和退役实证，应阻止发布，而不是弱化保证。

## 14. 源码参考（同一提交）

- WorldDef：静态连接入口
- Executor：进程所有权与 close
- Windows Job：目录 FileId / KILL_ON_JOB_CLOSE
- Companion：当前组合根
- World 历史/记录分区
- LibraryFiles 原子文件
- Host Delivery 收据
- 本机 SQLite WAL 并发边界
