# Uina 通用具身系统架构规范 (Embodiment Architecture Specification)

状态：**系统架构规范提案 (Proposal / Architecture Spec v3.5 - 奥卡姆剃刀极简版，含实现现状对照)**  
归属：`docs/proposals/embodiment/embodiment-architecture.md`  
定位：**为数字主体（Subject）提供统一的身体意图接口，而允许每种身体拥有自己的物理现实。** 彻底杜绝抽象泄露，保持内核绝对极简。

> **v3.5 修订说明（2026-09-21，对照实现校正）**
>
> | 项 | 状态 |
> | :--- | :--- |
> | 五大正交概念（Affordance/State/Cue/Action/Arbiter） | ✅ 成立，无冗余 |
> | `BodyEndpoint` 四方法 + `onFocus` | ✅ 成立（但 `emitCue` 无 `payload` 参数，已在 §6 校正） |
> | 对等消费者拓扑、无中央仲裁 | ✅ 成立 |
> | 局部通道仲裁与可降级表达 | ✅ Live2D 已实现（5 通道 + RAII 租约 + 允许降级） |
> | 多端点并发与焦点切换 | ✅ 已实现（首个注册者为主焦点，注销时焦点后移） |
> | 单身体暂停/恢复 | ✅ 已实现（暂停即 `safeStop()`，恢复恢复投递） |
> | `body` 门面工具（list/switch_focus/pause/resume/stop_all） | ✅ 已实现 |
| cue 契约含 `aliases`（声明的响应集合） | ✅ 已实现（2026-09-21 补）：路由器按「id + 声明别名」匹配，派发**传原始 cueId**，归一化归端点。修复了"描述文本向模型承诺别名、路由器只认精确 id"导致的静默丢弃 |
> | **端点登记方式** | ⚠ **原规范未定义**，实现为同进程共享表 + 结构校验（见 §7）。曾用服务注册的写法是错的，已删除 |
>
> **新增 §7「端点登记与发现」**：原规范只说"端点暴露 4 个方法"，没有说端点**如何到达路由器**。这个空缺曾经导致整条 cue 链路静默失效——详见 §7。

---

## 1. 核心哲学与五大概念 (Core Philosophy)

### 1.1 认知与具身的第一性原理
> **Agent 不直接控制身体参数。**  
> Subject 产生意图，身体暴露可能性，Runtime 负责路由与协调，具体身体决定如何实现。

在生物学与认知科学中，大脑皮层不会发送“左侧斜方肌收缩 31%、眼球 X 偏转 -0.18”这种底层信号，而是产生“看过去”、“笑一下”、“拿杯子”、“走过去”的高层意图。随后由脑干、小脑与神经肌肉系统完成闭环控制。

### 1.2 五大正交概念

```text
1. Affordance (长期能力) ─── "我能做什么"（外壳静态声明的纯语义能力空间）
2. State      (物理事实) ─── "我是否在线可用"（在线、硬件故障）
3. Cue        (伴随线索) ─── "我想自然流露什么"（短暂、best-effort、可降级、不承诺完成）
4. Action     (托管作业) ─── "我要让世界发生确定变化"（可观察生命周期、结果、取消、reconcile）
5. Arbiter    (局部仲裁) ─── "内部通道由谁占有"（端点内部私有调度、租约、策略仲裁）
```

---

## 2. 极简拓扑与对等消费者 (Architecture Topology)

系统彻底拒绝庞大的中央仲裁锁表与任何中间人代理包装，采用 **对等独立消费者（Peer Consumers）+ Endpoint 局部仲裁** 的扁平拓扑：

```text
                         Uina Agent / Subject
                                  │
           ┌──────────────────────┼──────────────────────┐
           ▼ (HostEvent 事实单流)   ▼ (HostEvent 事实单流)   ▼ (Tool Calls)
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│ [Extension] Voice     │ │ [Extension] Embodiment│ │ Tool Broker           │
│ (独立语音消费者)      │ │ (独立具身路由器)      │ │ (原生 App Tool 执行)   │
├───────────────────────┤ ├───────────────────────┤ ├───────────────────────┤
│ 1. TextSanitizer 清洗 │ │ 1. 提取 <cue id="..."/>│ │ 1. 校验参数           │
│ 2. TTS 语音合成 & 播放 │ │ 2. 路由分发至对应端点 │ │ 2. 下发具体 App Action│
│ 3. 广播 audio:pcm 旁路│ │ 3. 焦点管理 & 上下文  │ │ 3. App 内部调用 Arbiter│
└───────────┬───────────┘ └───────────┬───────────┘ └───────────┬───────────┘
            │                         │                         │
            │ 音频 PCM 旁路事件       │ emitCue()               │ 原生工具调用
            └─────────────────────────┼─────────────────────────┘
                                      ▼
                            ┌───────────────────┐
                            │   BodyEndpoint    │
                            │ ┌───────────────┐ │
                            │ │ChannelArbiter │ │ (端点私有内部通道仲裁)
                            │ └───────┬───────┘ │
                            │         ▼         │
                            │    Controller     │
                            │         ▼         │
                            │   Driver (硬件)   │
                            └───────────────────┘
```

---

## 3. 核心抽象契约 (Generic Contracts)

### 3.1 纯净能力清单 (BodyAffordance)
能力清单是端点向外暴露的公共静态契约。**严禁泄漏任何内部电机、通道、骨骼等驱动细节**：

```typescript
export interface ExpressiveCueDef {
  /** 纯语义标识，如 "warm_smile", "curious_tilt", "wave_hand", "wag_tail" */
  id: string;
  /** 给大模型的语义说明，指导在何种情境下自发流露 */
  description: string;
}

export interface BodyAffordance {
  bodyId: string;
  bodyType: "avatar_2d" | "avatar_3d" | "robotic_arm" | "quadruped" | "humanoid" | "custom";
  description: string;
  cues: ExpressiveCueDef[];
}
```

---

### 3.2 极简物理事实 (BodyState)

```typescript
export interface BodyState {
  /** 硬件/伴生进程是否在线 */
  online: boolean;
  /** 故障告警信息 (如 "low_battery", "vts_disconnected") */
  fault?: string;
}
```

---

### 3.3 双轨执行语义 (Dual-Track Semantics)

1. **Track A：伴随线索 (Expression Cue)**
   - **传输形式**：大模型自然流露 `<cue id="warm_smile"/>` 或定向 `<cue id="wave_hand" target="desktop_arm"/>`；
   - **特性**：短暂、尽力而为（Best-effort）、可降级、不承诺完成、TTL 自动衰减。
2. **Track B：托管作业 (Managed Action)**
   - **实现载体**：直接作为 Uina 原生 `WorldDef.actions` 暴露；
   - **特性**：有明确生命周期（`started` $\to$ `progress` $\to$ `succeeded` / `failed` / `cancelled`），支持取消，执行时由 Action 内部向本地 Arbiter 申请通道，`finally` 自动释放。

---

## 4. 端点内部局部仲裁 (Local Channel Arbiter)

通道（`mouth`, `eyes`, `gaze`, `head`, `torso`, `arm` 等）是**端点内部私有的资源划分**，外部无感知：
- 端点收到 `emitCue("warm_smile")` 时，由内部 Arbiter 检查通道占用；
- **可降级表达**：若 `mouth` 正被语音占用，端点内部自动降级仅驱动 `eyes`，嘴巴继续说话，眼睛弯弯微笑；
- **防死锁 RAII**：Action 执行时通过 `try...finally` 保证通道无条件释放。

---

## 5. 多端点并发与焦点切换 (Multi-Embodiment & Focal Shift)

- **并发操作**：多个端点的 Action（如机械臂递物 + 机器狗巡检）完全物理并发；
- **焦点切换**：
  - Runtime 维护 `primaryBodyId`；
  - 切换时通知原端点 `onFocus?(false)`（可选转入待机/休眠），通知新端点 `onFocus?(true)`（接管主导音频与倾听反射）；
  - 下一轮通过 `turn.prepare` 重新向大模型注入当前主导身形。

### 5.3 独立感知与控制启停 (Pause & Resume)
- 支持在运行时单独暂停/恢复特定身体的控制与感知（无需卸载 App）：
  - 暂停时目标端点调用 `safeStop()` 进入就地保持态，Runtime 屏蔽发往该端点的 Cue、宿主反射与音频能量；其他端点完全不受影响，继续正常运转。

### 5.4 具身管理门面工具 (`body`)
由 Embodiment Runtime 扩展向大模型暴露的单一门面工具：
```typescript
{
  name: "body",
  description: "管理数字主体的多具身端点（查看挂载的身体、切换主导焦点、单独暂停或恢复特定身体的控制）。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "switch_focus", "pause", "resume", "stop_all"],
        description: "子操作名称"
      },
      target: {
        type: "string",
        description: "目标端点 bodyId（switch_focus, pause, resume 专用）"
      }
    },
    required: ["action"]
  }
}
```

---

## 6. 极简 Core 接口收敛 (Minimal Core Boundary)

具身端点在通用 Core 中彻底收敛为 **4 个核心必选方法 + 1 个可选钩子**：

```typescript
export interface BodyEndpoint {
  readonly bodyId: string;
  readonly bodyType: string;
  
  /** 1. 静态纯语义能力 */
  affordance(): BodyAffordance;
  /** 2. 硬件物理在线状态 */
  state(): BodyState;
  /** 3. 投递伴随线索 (Track A) */
  emitCue(cueId: string): void;
  /** 4. 响应打断，安全受控急停 */
  safeStop(): Promise<void>;
  
  /** 可选: 焦点切换通知 (成为主导或退居辅助) */
  onFocus?(isFocused: boolean): void;
}
```

> **总结**：
> - 彻底切除 `channels` 向公共层的泄露；
> - 彻底切除 `park/wake` 的样板代码负担；
> - 概念高度正交，无任何冗余实体。
>
> **校正（2026-09-21）**：原稿写作 `emitCue(cueId: string, payload?: Record<string, unknown>)`，实现中**不存在 `payload`**，且不应存在——线索是纯语义的，允许附加任意载荷会把通道细节重新泄回公共层。已删除该参数。

---

## 7. 端点登记与发现 (Endpoint Registration & Discovery)

**原规范的空缺**：只定义了端点的四个方法，没有定义端点如何被路由器发现。这个空缺在实践中造成了整条 cue 链路的静默失效（见 §7.3）。

### 7.1 登记方式：同进程共享表，而非服务

端点由**应用侧**用宿主提供的活引用出口暴露自己：

```typescript
// 身体外壳（如 Live2D App）
ctx.expose(BODY_ENDPOINT_EXPOSED_PREFIX + endpoint.bodyId, endpoint);
// 前缀 = "body.endpoint:"，定义方为 embodiment 扩展（契约拥有方）
```

路由器在**激活时拉取 + 之后订阅**共享表变化：

```typescript
// embodiment 扩展
const feed = pi.shared(APP_EXPOSED_SHARED_NAME) as AppExposedRegistry | undefined;
for (const name of feed.names()) if (name.startsWith(PREFIX)) router.registerEndpoint(validate(feed.get(name)));
feed.subscribe(() => sync());   // 外壳可能被 world_store 停用/重新启用
```

**为什么是拉取 + 订阅，而不是应用启动时推送**：应用由 world-framework 作为内置 capability 装载，**先于 `.uina/extensions` 激活**。推送式注册在应用先跑的情况下必然落空（消费方还不存在）。拉取对激活顺序免疫，订阅负责后续变化。

**为什么不能走服务**：`BodyEndpoint` 是**行为契约**（带原型方法与闭包），而 `callService` 对入参与返回值双向 `structuredClone`，克隆这类对象必然抛 `DataCloneError`。参见扩展开发指南的铁律：纯数据走 `callService`，活引用走 `share`。

### 7.2 结构校验不可省

共享表是开放命名空间，任何扩展都能往里写。路由器消费前**必须**做结构校验（`affordance`/`state`/`emitCue`/`safeStop` 均为函数），不合格值 `reportError` 并拒绝注册，**绝不污染路由表**。校验通过后才是 §3.1 声明的"纯语义能力空间"。

### 7.3 曾经的真实缺陷（保留为教训）

初版实现试图用 `callService("embodiment:register_endpoint", endpoint)` 注册端点。后果是三重静默：

1. `structuredClone(endpoint)` 抛错（`PhysiologicalNoise.randomFn` 是自有属性上的函数引用）；
2. 异常被 `try/catch` 吞成一条 `console.warn`；
3. 端点从未进入路由表，于是 `<cue>` 词汇注入、cue 派发、`body` 工具**全部静默失效**——而当时的测试全部在边界内侧打桩（用 mock 冒充 `callService`），100 例绿灯掩盖了它。

**由此固化的两条纪律**：
- 用数据通道传行为，失败是必然的，而且往往不被发现；
- 跨越真实边界的测试不可用 mock 替代——`tests/embodiment-endpoint-wiring.test.ts` 全程使用真实 Runner/world-framework/共享表/路由器，就是为了让这类缺陷无处藏身。
