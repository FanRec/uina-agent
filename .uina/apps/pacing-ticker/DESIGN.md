# 自主节拍器 (Pacing Ticker) 架构设计文档 (终极标准版)

---

## 1. 核心定位与三大边界

### 1.1 定位：自主认知机会源 (Wake Opportunity Source)
自主节拍器不是 Uina 的“意识本体”，也不是传统的任务调度器 (Cron)，它只是一个**稀疏、可避让、可丢弃的自主认知机会发生器 (Wake Opportunity Source)**。

Uina 的生命连续性来自 Session 历史、记忆投影、环境状态与长期活动，而不是“每隔几分钟调一次大模型”。  
节拍器的唯一物理事实是：**“物理世界的时间已经过去了一段，现在提供一次重新观察环境并自主决策的机会。”**

### 1.2 三大不可逾越的边界
1. **Ticker 管时间，不管心理**：
   * 严禁在代码中模拟好奇心、无聊度、思念感等伪心理状态；
   * 节拍器只基于客观物理事实（真实时间流速与外部活动空闲期）计算退避。
2. **Ticker 提供机会，不制造任务**：
   * 节拍器发出的不是必须完成的“任务 (Task)”，而是一个“可忽略的机会 (Opportunity)”；
   * 主体在收到机会后，可以选择行动 (Act)、说话 (Speak) 或自然静默 (Silence)；静默是合法的最高级状态。
3. **Ticker 不冒充外部世界，更不反向耦合具体 App**：
   * 节拍器不理解弹幕、邮件或系统指标，那是其他 App 的职责；
   * 外部 App 绝不需要主动调用 Ticker；Ticker 仅在宿主事件总线上监听通用活动接缝 (`origin: "human" | "external"`)。

---

## 2. 状态分层与权限纪律 (State Hierarchy & Authority)

> **黄金法则：配置资源护栏，状态表达主体选择，常量表达架构纪律。**

系统严格划分为五层状态与职责边界，杜绝职责越界与配置膨胀：

| 层次 | 包含内容 | 治理法则 |
| :--- | :--- | :--- |
| **代码不变量<br>(Architecture Invariants)** | - `performance.now()` 单调时基<br>- Busy 忙碌不插队、Wake 机会不堆叠<br>- 30s 人机礼貌避让 (`HUMAN_COOLDOWN_MS`)<br>- 退避曲线 (`BACKOFF_RULES`)<br>- Opportunity $\neq$ Human Input | 固化在代码中作为架构公理，零配置 |
| **人类资源护栏<br>(Human Guardrails)** | - `maxDailyWakes: number \| null` (每日唤醒硬上限，null = 无限制) | 创造者配置文件 (`config.json`)，作为经济安全网 |
| **主体持久状态<br>(Durable App State)** | - `baseIntervalMs` (主体自选基准节拍，默认 3m)<br>- `pausedUntilEpochMs: number \| null` (主体自选入睡/挂起截止时间)<br>- `dailyWakeUsage: { date: string, count: number }` (跨重启用量) | App 持久化存储 (`state.json`)，跨重启保留主体选择 |
| **运行时瞬态<br>(Ephemeral Runtime State)** | - `timer: NodeJS.Timeout \| null` (唯一定时器句柄)<br>- `nextWakeMonoMs: number` (下次唤醒单调时间戳)<br>- `lastExternalActivityMonoMs: number`<br>- `lastHumanInteractionMonoMs: number` | 内存瞬态，按需读取与调度 |
| **其他专业系统管辖** | - 启用/停用 $\rightarrow$ App Framework 原生生命周期管理<br>- 免打扰/物理静音 $\rightarrow$ Output / Presentation / TTS 策略 | 彻底移出 Ticker，保持极简高内聚 |

---

## 3. 极简时基与自适应退避模型

```text
                  Monotonic Clock (performance.now)
                                │
                                ▼
                       ┌─────────────────┐
  activity event ─────►│   Next Wake     │
  (origin: external)   │     Timer       │
  human interaction ──►│                 │
  (origin: human)      │   Courtesy &    │
                       │   Backoff Gate  │
                       └────────┬────────┘
                                │
                         wake opportunity
                                │
                                ▼
                             Subject
                          /     |      \
                        act   speak   silence
```

### 3.1 物理时间连续，只有稀疏的 Cognition Timer
* 彻底废除任何“内部每 30 秒 step 一次”的无意义轮询；
* 时间是连续物理量，按需通过 `performance.now() - lastExternalActivityMonoMs` 读取；
* 整个系统在底层**只有一个负责下一次唤醒的稀疏定时器 (`timer`)**。

### 3.2 真实的退避逻辑 (Backoff 绝不覆盖更慢的主动设置)
当外部世界长期没有新活动时，认知机会逐渐稀疏，以降低不必要的 Token 消耗：
* **基准唤醒间隔**：`baseIntervalMs`（默认 3 分钟，主体可随时通过 `set_interval` 修改并持久化）；
* **外部空闲 > 15 分钟**：间隔退避至 `Math.max(baseIntervalMs, 10 分钟)`；
* **外部空闲 > 1 小时**：间隔退避至 `Math.max(baseIntervalMs, 30 分钟)`；
* **原则**：退避只能降低采样率，若主体主动设置了更长的间隔（如 60 分钟），退避机制**绝不反向加速**。

### 3.3 外部活动精确捕获与即时重置
* **外部活动定义**：宿主总线必须明确事件来源 (`origin: "human" | "external" | "runtime"`)。Ticker **仅消费 `origin === "human" || origin === "external"`**，主体自身的 Tool 调用、Journal 落盘等 `runtime` 内部事件绝不误计为外部活动。
* **即时生效与防抖防饿死**：当真实外部活动到达时，系统**不仅更新时间戳，而且在当前排定的唤醒时间晚于基准周期（处于长退避中）时立即提前重置 Timer**，确保“外部活动到达恢复敏感度”物理生效；同时若已在基准周期之内，绝不无休止向后推迟，彻底防范高频事件风暴导致的 Timer 抖动与饥饿（Starvation）。

### 3.4 精准的 Pause 截止时间语义 (Deadline Semantics)
* 主体调用 `pause(minutes)` 时，计算绝对截止时间并**立即重新调度 Timer 瞄准该 Deadline**；
* 彻底杜绝“暂停 5 分钟却因旧 Timer 重新排队导致睡了 31 分钟”的计时 Bug；
* 持久化采用 Wall-Clock（`pausedUntilEpochMs`），跨进程重启后通过 `Math.max(0, pausedUntilEpochMs - Date.now())` 恢复，运行期继续使用单调时钟计算。

---

## 4. 认知学视口与 Journal 语义

### 4.1 视口位置规定 (Prompt Cache 保护)
* 动态时间戳**严禁**注入到不可变的 System Prompt 前缀中；
* 视口内容必须挂载于**动态 Context 视口区末尾**，确保核心系统提示词字节级稳定，最大化复用 LLM 的 Prefix Caching。

### 4.2 环境态视口 (Ambient Viewport · ~15 Tokens)
位于动态视口区末尾：
```text
[时间感知: 2026-09-20 16:00 (周日) | 节拍: 运行中 | 外部静默: 25m]
```

### 4.3 机会脉冲投递 (Opportunity Envelope)
通过宿主输入接口投递，语义是 **Opportunity** 而非常规人类 Input：
```typescript
const opportunityInput: AgentInput = {
  id: `pacing-opportunity-${Date.now()}`,
  mode: "followUp",
  source: {
    kind: "runtime",
    type: "pacing-opportunity"
  },
  text: `[时钟节拍: 2026-09-20 16:00 | 距上个外部活动已过去 25m]`
};
```
* `source.kind = "runtime"`：明确标识为运行时自发事件，防止人类对话历史将其误认为用户发出的文本。

### 4.4 运行时 Journal 与人类 Session 的分离原则
* **对人类可见的会话 (Human-visible Conversation)**：若主体在本次机会中决定保持静默，不记录无意义的节拍文本与空回复；
* **宿主运行时与持久日志 (Runtime / Durable Journal)**：若主体在本次机会中**调用了工具、产生了副作用、修改了状态**，哪怕它最终没有对人说话（`no committed output`），底层的 Tool Call 与状态变更**必须忠实落盘记录**，以保证 Crash Recovery、Rewind 和审计的完整性；
* **完全静默 (Pure Silence)**：只有当既没调用工具、也没改变状态、也没外显输出时，这次 Turn 才在主线历史中不留痕迹。

---

## 5. 门面工具与操作契约 (Facade Tool: `ticker`)

只暴露真实的物理控制动作，诚实反映内部真实状态：

| 动作 (Action) | 参数 | 描述 |
| :--- | :--- | :--- |
| `set_interval` | `minutes: number` | 调节基准唤醒间隔（1 ~ 120 分钟），持久化并立即重新调度 |
| `pause` | `minutes: number` | 临时挂起自主唤醒（精准 Deadline，跨重启保留） |
| `resume` | 无 | 提前解除挂起，恢复节拍 |
| `status` | 无 | 诚实返回基准周期、外部静默时长、当前实际退避周期、预计下次唤醒倒计时与今日用量 |

---

## 6. 极简源码实现骨架 (`ticker-service.ts`)

```typescript
// 架构不变量 (常量表达架构纪律，零配置)
const HUMAN_COOLDOWN_MS = 30_000;
const BACKOFF_RULES = [
  { idleAfterMs: 15 * 60_000, minIntervalMs: 10 * 60_000 },
  { idleAfterMs: 60 * 60_000, minIntervalMs: 30 * 60_000 },
] as const;

// 人类资源护栏 (物理安全网)
export interface TickerGuardrails {
  maxDailyWakes?: number | null; // null 或 undefined 表示不设上限
}

// 主体持久状态 (跨重启保留)
export interface TickerDurableState {
  baseIntervalMs: number;
  pausedUntilEpochMs: number | null;
  dailyWakeUsage: {
    date: string;
    count: number;
  };
}

export class TickerService {
  private readonly guardrails: TickerGuardrails;
  private readonly durableState: TickerDurableState;
  private timer: NodeJS.Timeout | null = null;

  // 运行时瞬态 (单调毫秒)
  private lastExternalActivityMonoMs: number = performance.now();
  private lastHumanInteractionMonoMs: number = 0;
  private nextWakeMonoMs: number = 0;
  private pauseUntilMonoMs: number = 0;

  constructor(
    private readonly host: {
      isBusy: () => boolean;
      submitOpportunity: (text: string) => Promise<void>;
      saveDurableState: (state: TickerDurableState) => Promise<void>;
    },
    initialDurableState?: Partial<TickerDurableState>,
    guardrails?: TickerGuardrails
  ) {
    this.guardrails = {
      maxDailyWakes: guardrails?.maxDailyWakes ?? null,
    };

    const today = new Date().toDateString();
    this.durableState = {
      baseIntervalMs: initialDurableState?.baseIntervalMs ?? 180_000,
      pausedUntilEpochMs: initialDurableState?.pausedUntilEpochMs ?? null,
      dailyWakeUsage: initialDurableState?.dailyWakeUsage?.date === today
        ? initialDurableState.dailyWakeUsage
        : { date: today, count: 0 },
    };

    // 跨重启恢复 pause 状态
    if (this.durableState.pausedUntilEpochMs) {
      const remainingWallMs = this.durableState.pausedUntilEpochMs - Date.now();
      if (remainingWallMs > 0) {
        this.pauseUntilMonoMs = performance.now() + remainingWallMs;
      } else {
        this.durableState.pausedUntilEpochMs = null;
      }
    }
  }

  start(): void {
    const initialDelay = this.pauseUntilMonoMs > performance.now()
      ? this.pauseUntilMonoMs - performance.now()
      : this.calculateNextInterval();
    this.scheduleNext(initialDelay);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 宿主通用活动事件到达 (仅消费 origin 为 human 或 external 的真实外部事实)
   */
  notifyActivity(event: { origin: "human" | "external" | "runtime" }): void {
    if (event.origin === "runtime") return; // 忽略主体内部活动 (Tool调用、Journal等)

    const now = performance.now();
    this.lastExternalActivityMonoMs = now;
    if (event.origin === "human") {
      this.lastHumanInteractionMonoMs = now;
    }

    // 外部活动到达，若未处于 pause：
    // 只有当已排定的唤醒时间比基准周期还晚（处于长退避中）时才提前重置；
    // 若已在基准周期之内，绝不往后推迟（防范高频事件风暴导致的 Timer 抖动与饥饿饿死）
    if (now >= this.pauseUntilMonoMs) {
      const remainingMs = this.nextWakeMonoMs - now;
      if (remainingMs > this.durableState.baseIntervalMs) {
        this.scheduleNext(this.durableState.baseIntervalMs);
      }
    }
  }

  async setInterval(minutes: number): Promise<void> {
    this.durableState.baseIntervalMs = Math.max(1, Math.min(120, minutes)) * 60_000;
    await this.persist();
    if (performance.now() >= this.pauseUntilMonoMs) {
      this.scheduleNext(this.calculateNextInterval());
    }
  }

  async pause(minutes: number): Promise<void> {
    const durationMs = Math.max(1, minutes) * 60_000;
    this.pauseUntilMonoMs = performance.now() + durationMs;
    this.durableState.pausedUntilEpochMs = Date.now() + durationMs;
    await this.persist();
    // 立即重新调度瞄准 pause deadline
    this.scheduleNext(durationMs);
  }

  async resume(): Promise<void> {
    this.pauseUntilMonoMs = 0;
    this.durableState.pausedUntilEpochMs = null;
    await this.persist();
    this.scheduleNext(1000);
  }

  /**
   * 基于外部空闲时长的自适应唤醒间隔计算 (退避只能降频，绝不覆盖更慢的主动设置)
   */
  private calculateNextInterval(): number {
    const idleDuration = performance.now() - this.lastExternalActivityMonoMs;
    let minInterval = this.durableState.baseIntervalMs;

    for (const rule of BACKOFF_RULES) {
      if (idleDuration > rule.idleAfterMs) {
        minInterval = Math.max(minInterval, rule.minIntervalMs);
      }
    }
    return minInterval;
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextWakeMonoMs = performance.now() + delayMs;
    this.timer = setTimeout(() => void this.onTick(), delayMs);
  }

  private async onTick(): Promise<void> {
    const nowMono = performance.now();

    // 1. 精确 Deadline 检查
    if (nowMono < this.pauseUntilMonoMs) {
      this.scheduleNext(this.pauseUntilMonoMs - nowMono);
      return;
    }
    if (this.durableState.pausedUntilEpochMs) {
      this.durableState.pausedUntilEpochMs = null;
      void this.persist();
    }

    // 2. 物理资源熔断护栏检查 (日唤醒限额，跨重启持久计数)
    const today = new Date().toDateString();
    if (today !== this.durableState.dailyWakeUsage.date) {
      this.durableState.dailyWakeUsage = { date: today, count: 0 };
      void this.persist();
    }
    if (
      this.guardrails.maxDailyWakes !== null &&
      this.durableState.dailyWakeUsage.count >= this.guardrails.maxDailyWakes
    ) {
      // 达到人类设定的物理硬限额，退避至 1 小时后再次探测
      this.scheduleNext(3600_000);
      return;
    }

    // 3. 礼貌避让检查：主脑忙碌 或 人类刚交互不久
    const isBusy = this.host.isBusy();
    const isHumanRecent = (nowMono - this.lastHumanInteractionMonoMs) < HUMAN_COOLDOWN_MS;

    if (isBusy || isHumanRecent) {
      // 避让退后，15 秒后重试探测
      this.scheduleNext(15_000);
      return;
    }

    // 4. 投递唤醒机会 (Opportunity)
    const idleMinutes = Math.round((nowMono - this.lastExternalActivityMonoMs) / 60_000);
    const timeStr = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const opportunityText = `[时钟节拍: ${timeStr} | 距上个外部活动已过去 ${idleMinutes > 0 ? `${idleMinutes}m` : "片刻"}]`;

    this.durableState.dailyWakeUsage.count++;
    void this.persist();

    try {
      await this.host.submitOpportunity(opportunityText);
    } catch {
      // 容错：投递失败不崩溃
    }

    // 5. 调度下一次自适应节拍
    this.scheduleNext(this.calculateNextInterval());
  }

  private async persist(): Promise<void> {
    try {
      await this.host.saveDurableState(this.durableState);
    } catch {
      // 容错：落盘失败不阻断运行
    }
  }

  getStatus(): {
    baseIntervalMinutes: number;
    idleMinutes: number;
    effectiveIntervalMinutes: number;
    remainingSeconds: number;
    isPaused: boolean;
    dailyWakesUsed: number;
    dailyWakesLimit: number | null;
  } {
    const now = performance.now();
    return {
      baseIntervalMinutes: Math.round(this.durableState.baseIntervalMs / 60_000),
      idleMinutes: Math.round((now - this.lastExternalActivityMonoMs) / 60_000),
      effectiveIntervalMinutes: Math.round(this.calculateNextInterval() / 60_000),
      remainingSeconds: Math.max(0, Math.round((this.nextWakeMonoMs - now) / 1000)),
      isPaused: now < this.pauseUntilMonoMs,
      dailyWakesUsed: this.durableState.dailyWakeUsage.count,
      dailyWakesLimit: this.guardrails.maxDailyWakes,
    };
  }
}
```

---

## 7. 终极标准版演进总结

| 审查缺陷 | 终极修复方案 | 核心系统价值 |
| :--- | :--- | :--- |
| **配置哲学言行不一** | 拆分为架构常量、人类 Guardrails、主体 Durable State、Runtime State | 权责极度清晰，配置文件薄到极致 |
| **`quietHours` & `enabled` 越界** | 彻底移出 Ticker；`enabled` 归 App 生命周期，`quietHours` 归输出呈现层 | 维持 Ticker 极高内聚，只管“何时给机会” |
| **`pause()` 计时严重失真** | 引入准确的 Deadline 调度 (`scheduleNext(pauseUntil - now)`) | 彻底杜绝“暂停 5 分钟却睡了 31 分钟”的 Bug |
| **内部活动误刷外部时钟** | 宿主总线只消费 `origin: "human" \| "external"`，忽略 `runtime` | 防止主体自身 Tool 调用导致退避完全失效 |
| **安全网与主体选择易失** | 拆分 Durable 与 Ephemeral 状态，Wall-Clock 跨进程恢复，单调时钟运行 | 保证主体的生活选择与人类的安全网跨重启真正有效 |
| **JSON 不友好的 Infinity** | `maxDailyWakes: number \| null`，null 代表无限制 | 规范序列化契约 |
| **高频事件风暴致饥饿** | 仅在 `remainingMs > baseIntervalMs` 时提前，基准期内绝不延后 | 彻底防范高频事件不断重置 Timer 导致的饿死 |
