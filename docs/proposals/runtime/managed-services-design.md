# Managed Services 设计

状态：设计提案，尚未实现；共享 ServiceManager 的实施尚未获当前证据支持。先完成 M0 证据门并确认至少两个真实消费者需要共享启动/租约，再决定是否进入 M1。

日期：2026-09-30

本文定义 Uina 如何托管需要独立进程的本地服务，例如 `api-enhanced`、`broadcast-hud` 和未来可能出现的 `TTSService`。它是扩展层基础设施设计，不是 Core 设计，也不代表相关代码已经存在。

## 1. 决策摘要

保留一个进程级 `ServiceManager`，统一处理外部进程的连接、启动去重、租约和有界清理。业务协议仍由各自的 Gateway 或 Client 负责。

```text
World / Extension
    -> ServiceManager.acquire(id, ResourceScope)
    -> local external process
    -> Gateway / Client owns business protocol
```

第一版只公开一个管理概念：`ServiceManager`。`Registry`、`Supervisor`、`Provider` 是可选的内部实现名称，不形成独立公共 API。服务数量和复杂度尚未证明需要服务编排平台。

明确不做：

- 不把进程、端口、HTTP 或 Service 放入 `src/core`；
- 不用 `registerService/callService` 传递进程句柄或租约；
- 不统一网易云、HUD、TTS 的业务协议；
- 不递归发现任意 ThirdParty 项目，不自动安装或升级服务；
- 不把 HUD source arbitration、音频混音或媒体焦点交给 ServiceManager。

## 2. 当前现实

以下是当前源码已核实的事实：

| 事实 | 证据边界 |
| --- | --- |
| `ResourceScope` 提供 `signal`、`run`、`onDispose`、`close`，关闭时等待工作并逆序执行清理 | `src/extensions/lifecycle-scope.ts` 静态源码 |
| World 激活创建一个 scope；停止先关闭 scope，再调用 `onStop` | `src/extensions/world-framework/world-activation.ts` 静态源码 |
| `registerService/callService` 是结构化进程内 RPC | `src/extensions/services.ts` 与 Extension API |
| 点歌机目前分别管理 `api-enhanced` 和 `broadcast-hud` | `.uina/worlds/netease-jukebox` 当前实现 |
| HUD manager 没有跨消费者共享启动模型，两个 manager 也没有统一的实例身份 | 当前实现审查 |

因此，当前可证明的是局部 manager 存在，不能声称 Managed Services 已实现。真实 `api-enhanced`、mpv、OBS 和跨 World 复用仍未验证。

## 3. 设计边界

### 3.1 ServiceManager 的职责

- 注册一个已解析的服务定义；
- 连接已健康的外部实例，或按调用者选择启动一个实例；
- 保证同一服务 ID 同时只有一个启动任务；
- 记录本次启动的具体实例和 Uina 是否拥有该实例；
- 为每个消费者创建独立租约；
- 最后一个租约释放后，停止 Uina 自己启动且允许停止的实例；
- 提供进程级状态和最近错误。

### 3.2 ServiceManager 不负责

- 网易云登录、权限、播放 URL、评论结果；
- HUD 快照、Overlay 投影、歌词或音频状态；
- 业务级健康，例如登录过期或模型尚未加载；
- World 的业务启动策略和动作编排；
- 保存播放队列、账号 Cookie 或业务历史。

进程健康、服务基础就绪、业务可用是三层事实。ServiceManager 只负责前两层的最小边界；Gateway/Client 负责第三层。

## 4. 最小公共接口

建议代码落位：

```text
src/extensions/managed-services/
  types.ts
  service-manager.ts
  index.ts
```

对外只需要：

```ts
interface ManagedServiceDefinition {
  readonly id: string;
  readonly version: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly endpoint?: string;
  readonly healthCheck: (signal?: AbortSignal) => Promise<boolean>;
  readonly identityCheck?: (signal?: AbortSignal) => Promise<boolean>;
  readonly autoStartDefault: boolean;
  readonly sharing: "shared" | "exclusive";
  readonly stopWhenUnused: boolean;
}

interface ManagedServiceLease {
  readonly serviceId: string;
  readonly endpoint?: string;
  readonly ownedProcess: boolean;
  readonly status: "ready";
  release(): Promise<void>;
}

interface ServiceManager {
  register(definition: ManagedServiceDefinition): () => void;
  acquire(
    id: string,
    scope: ResourceScope,
    options?: { autoStart?: boolean },
  ): Promise<ManagedServiceLease>;
  status(id: string): ManagedServiceStatus | undefined;
  dispose(): Promise<void>;
}
```

`acquire` 成功后自动向传入的 `ResourceScope` 注册幂等 release。消费者正常路径不需要传入字符串 `ownerId` 或调用 `releaseOwner`。`release()` 只作为测试和内部收束的幂等句柄；`dispose()` 是进程级关闭，不是 World 的普通清理入口。

`acquire` 只表达资源获取，不理解 World 是否必须依赖该服务。它统一返回 ready 租约或抛出明确错误；可选服务由 World 自己捕获错误并决定降级，必需服务由 World 自己决定启动失败或进入不可用状态。

## 5. 启动、取消与所有权

### 5.1 两个独立维度

不要用一个 `manual/on_demand/on_owner_start` 枚举同时表达两个问题：

- `autoStart`：允许本次 acquire 由 Uina 启动服务；`false` 只连接已有健康实例；
- `acquireAt`：消费者决定在 World 启动时获取，还是第一次业务使用时获取。

`acquireAt` 属于消费者配置，不属于 ServiceManager 的全局服务状态。第一版可用普通 World 代码表达获取时机，不必建立声明解析系统。

`autoStart` 还决定连接权限，不能只当成启动偏好：

- `autoStart: false`：只接受 acquire 调用时已经处于 `ready` 的实例；如果服务正在启动或停止，返回 `not_ready`/`stopping`，不等待其他消费者替它启动；
- `autoStart: true`：可以连接当前 ready 实例，也可以加入当前共享启动任务，必要时创建新实例。

这样 A（只连接）不会因为 B（允许启动）正在启动而隐式获得启动权限。若未来确实需要“只允许连接但可以等待外部启动完成”，应增加单独的 `waitForReady` 语义并定义超时；第一版不引入该第三种模式。

### 5.2 并发启动语义

每个服务的运行实例按状态串行变更，且每个服务记录最多一个共享 `startTask`：

- 多个 acquire 共享同一个启动结果；
- 每个消费者只等待自己的 Promise，可独立取消；
- 一个消费者取消不得取消仍有等待者的启动；
- 没有等待者且没有租约时，才可取消尚未 ready 的启动；
- spawn 后必须保存本次 `processInstanceId` 与具体 `ChildProcess`；
- ready 检查通过后仍需执行可用的 identity/version 校验；
- 连接到外部实例时 `ownedProcess=false`，释放租约不能终止它。

不能用简单的 `spawnedByUs` 布尔值决定清理对象。清理只能作用于当前 ServiceManager 保存的具体启动实例，且不能因为端口后来出现了响应者就 kill 新实例。

运行实例至少经过以下顺序：

```text
stopped -> starting -> ready -> stopping -> stopped
                    \-> failed
```

`stopping` 是不可复用状态。最后一个租约释放后开始停止时，新 acquire 不能指向该实例：

- `autoStart:false` 立即返回 `stopping`；
- `autoStart:true` 等待停止完成，再重新连接或创建下一代实例；
- 每代实例拥有独立 `instanceToken` 和退出处理器；
- 退出事件只有在 token 仍匹配当前记录时才能更新状态或触发清理；
- 旧实例的退出、health 结果和异步 cleanup 不得覆盖新实例状态。

停止操作本身也必须串行化；同一服务不能同时执行两个 stop，也不能在 stop 未完成时执行下一次 spawn。

### 5.3 服务状态

第一版只保留进程级状态：

```ts
type ManagedServiceState = "stopped" | "starting" | "ready" | "failed";
```

`degraded` 不作为 Supervisor 状态。HUD stale、登录失效、TTS 模型未加载等业务状态由对应 Client/Gateway 表达。

### 5.4 租约与 World reload

租约身份来自 `ResourceScope` 的激活实例，而不是 World 名称。当前 scope 的 `id` 不是稳定的跨激活 owner key，因此实现需要为每个激活生成唯一 scope token，或直接以 scope 对象作为内部键。

旧 World 的延迟 cleanup 只能释放自己的 lease，不能释放重新加载后的新 World lease。若 `ResourceScope` 已经关闭，不能再创建新 lease。

### 5.5 ResourceScope 关闭竞态

`ResourceScope` 是租约清理的唯一正常入口，但 `acquire` 是异步的，必须处理获取与关闭同时发生：

- acquire 开始前检查 `scope.active`；
- 等待 ready 后再次检查 scope 是否仍 active；如果已关闭，不创建可见租约，直接 release/取消本次等待；
- 注册 `onDispose` 与 scope 关闭存在竞态时，若注册失败，立即执行同一个幂等 release；
- release 不调用 `scope.close()`，也不等待 scope 的 pending work；
- ServiceManager 停止子进程只等待子进程自身的退出，不反向等待持有该租约的 scope；
- scope 关闭必须最终满足：租约计数归零，且不会遗留属于该 scope 的 lease。

因此依赖关系只有一个方向：`scope.close()` 触发 `lease.release()`，而 `lease.release()` 只能改变 ServiceManager 状态，不能回调关闭 scope。

## 6. 服务定义来源

第一版使用显式装配的 `ManagedServiceDefinition`。Manifest 可以作为静态配置来源，但不建立独立 Provider 生命周期，也不实现任意目录自动发现。

建议来源顺序：

```text
内置定义
  < 明确的 .uina/services 配置覆盖
  < World/Extension 本次 acquire 的选项
```

服务定义必须在启动时完成 schema 校验。重复 ID、非 loopback endpoint、不可解析的 cwd 或未声明的启动目录直接失败。配置不得改变服务 ID、业务类型或安全边界。

服务实现继续位于：

```text
E:\Uina\ThirdParty\api-enhanced
E:\Uina\ThirdParty\broadcast-hud
```

它们可以独立运行；Uina 只连接或托管已注册定义允许的进程。

## 7. 首批服务绑定

### `netease-api`

- `sharing: "shared"`；
- 默认 `autoStart: true`，`acquireAt: "first_use"`；
- 点歌 World 通过 `NeteaseGateway` 负责 API、登录和业务错误；
- ServiceManager 只负责 api-enhanced 进程和基础健康。

### `broadcast-hud`

- `sharing: "shared"`；
- 默认 `autoStart: false`，便于用户手动运行 OBS HUD；
- 用户明确开启跟随时，点歌或演唱 World 在自身 scope 中 acquire，并将 `autoStart` 设为 true；
- `BroadcastHudClient` 负责快照发布、重试和 stale；
- 外部已运行 HUD 不因 World 停止而被关闭。

### `tts`

暂不实现。文本队列、音频输出和取消属于 TTS 业务模块，届时只复用进程租约机制。

## 8. 失败语义

- `autoStart=false` 且没有当前 ready 外部实例：acquire 失败；
- 服务无法 ready：由消费者捕获错误并决定失败或降级；
- 进程退出：只更新服务状态，不推断业务操作成功；
- 外部副作用已发出但无法验证：业务模块返回 `unknown`；
- scope 关闭期间的新 acquire：`not_started`；
- 启动取消、超时和端口被非目标进程占用：返回明确失败，并保证不留下 Uina 自己启动的孤儿进程。

## 9. 实施顺序与验收

### M0：基线核实

沿两个现有 manager 的真实调用链运行 focused tests，记录启动、ready、停止、端口冲突和服务不可用行为。若没有可复用的真实场景，不先抽象公共管理器。

### M1：最小 ServiceManager

只实现 Node 子进程、loopback health、shared/exclusive、实例 token、租约和 `ResourceScope` 自动释放。必须先通过：

- 两个并发 acquire 只 spawn 一次；
- `autoStart:false` 的 acquire 不会加入其他消费者的启动任务；
- 一个 waiter 取消不影响另一个 waiter；
- 所有 waiter 取消不会留下进程；
- 外部实例不被停止；
- 最后一个 lease 释放才停止自有实例；
- stopping 实例不会被新 lease 复用，停止完成后才允许下一代连接或启动；
- 旧实例退出事件不会覆盖新实例状态；
- World 快速 reload 的旧 cleanup 不影响新 lease；
- scope 在 acquire 过程中关闭不会留下 lease，且不产生 scope 与 manager 的循环等待；
- 进程意外退出和端口被非目标进程占用有明确结果。

### M2：迁移点歌机

只替换 `CompanionManager` 和 `HudCompanionManager` 的进程生命周期来源，保留 `NeteaseGateway`、`BroadcastHudClient` 和现有业务错误语义。没有真实服务时，simulation/fake 测试只能证明组合逻辑，不能证明音频、OBS 或真实 API。

### M3：第二个真实消费者

演唱 World 复用 `broadcast-hud`，验证一个 World 停止后另一个仍可使用，所有 lease 释放后只停止 Uina 自己启动的实例。

只有 M3 证明共享需求后，才考虑把静态定义外置为 Manifest。只有出现重复且复杂的协议初始化，才考虑提取 Provider；不为概念本身增加层次。

## 10. 测试分层

### 纯单元

- 启动任务去重、独立取消、最后 waiter 取消；
- lease 幂等、scope cleanup 和 reload 身份；
- 实例 token、owned/external 清理规则；
- 状态转移和错误分类。

### 子进程/协议

- fake service health 和 identity；
- ready 超时、进程提前退出、端口冲突；
- 外部已运行服务连接后释放不 kill；
- ServiceManager dispose 的逆序清理。

### World 组合

- jukebox 和 singing 同时 acquire HUD 只产生一个进程；
- 一个 World 停止后另一个仍能发布；
- HUD 不可用不阻止播放；
- World stop 后不再 publish 新快照。

### 真实验收

- 本地 `api-enhanced` 搜索、登录和播放 URL；
- mpv IPC 的播放、暂停、结束和错误；
- broadcast-hud HTTP/WS 与 OBS Browser Source；
- clean start、重启、端口冲突和用户手动启动服务。

## 11. 删除标准与未决项

如果迁移后只有一个消费者，且并发启动、共享租约和外部实例管理没有真实需求，应删除公共 ServiceManager，保留局部 manager。若 M1 不能用确定性测试证明共享启动和所有权边界，也不能以“未来可扩展”为理由继续增加 Manifest、Provider 或依赖图。

以下仍是未决或未验证事项：

- `ResourceScope.id` 是否在现有所有 World 激活路径中唯一；实现前需要生成独立激活 token；
- 第三方服务是否提供可校验的 identity/version 响应；
- api-enhanced、mpv、OBS 的真实启动命令、ready 条件和跨平台行为；
- 用户配置是否需要持久化服务启用策略；
- 第二个真实 producer 出现前，不实现 source arbitration、混音和媒体焦点。

## 12. 最终判断

外部审查指出的六个 P0 问题成立，尤其是并发启动、实例所有权、scope 身份和健康层次。其“合并为一个 ServiceManager、复用 ResourceScope”的方向也正确。

需要修正的是：不必现在删除所有内部职责，也不必把 Manifest 完全否定。合理的第一步是对外一个 `ServiceManager`，内部保持少量私有状态和方法；Manifest 只作为以后可能采用的静态定义格式；Provider、Registry、Supervisor、依赖发现和复杂状态机都以真实重复需求为前提。

当前决策：先修正文档并完成 M0 基线核实。M1 尚未批准；只有 M0 证明第二个真实消费者需要共享启动/租约后，才拆最小可测试垂直切片。没有通过并发、取消、实例所有权和 reload 测试前，不迁移现有局部 manager。
