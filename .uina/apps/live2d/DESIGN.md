# Live2D 虚拟形象应用设计规范 (DESIGN.md)

状态：**应用实现设计规范 v3.6（三层动作合成器；含实现现状对照）**  
归属：`.uina/apps/live2d/` 独立应用  
定位：作为 Uina 数字主体在 2D 视觉领域的具身端点，实现 [`docs/proposals/embodiment-architecture.md`](../../docs/proposals/embodiment-architecture.md) 定义的极简 `BodyEndpoint` 接口。

> **v3.6 修订说明（2026-09-21，对照实现校正）**
>
> | 项 | 状态 |
> | :--- | :--- |
> | 四层动作合成器 | ⚠ **实为三层**：Layer 1「美术级关键帧剪辑」从无加载器、无 `motion3.json` 解析、无调用者，**已删除**（见 §3） |
> | Layer 0 生理底噪 | ✅ 实现（但"躯干重心游移"名不副实，见 §3.1 校正） |
> | Layer 2 动力学弹簧 | ✅ 实现（二阶欠阻尼解析解 + smootherstep + 软限速） |
> | Layer 3 声学微冲 | ✅ 已接线（电平经 `voice.levelSink:*` 接收端到达） |
> | 语义 Cue 与 `parameter-mapper` | ✅ 实现，且比本文档示例**更完整**（声明式映射表 + 别名表） |
> | 四维 `live2d.express` 门面工具 | ✅ 实现（含 `beats` 两步分镜） |
> | 内部 5 通道仲裁 + RAII | ✅ 实现 |
> | 端点登记 | ✅ 走宿主同进程共享表 `ctx.expose`（本文档原未涉及；用 `callService` 的旧写法是错的，已删除） |
> | 动作取消 | ✅ 实现（`ctx.signal` 透传进 `arbiter.claim`，`flip` 逐步可中断） |
>
> **路径基准**：本文档此前把文件写作 `src/xxx.ts`，易被误读为仓库 `src/`。实际全部位于本应用目录 `.uina/apps/live2d/`（§6 拓扑为准）。

---

## 1. 架构定位与职责边界 (Architecture Stance)

### 1.1 核心职责与零抽象泄露
Live2D 应用是 Uina 的一个具体 `BodyEndpoint` 实例（`bodyType: "avatar_2d"`）：
- **纯语义能力暴露**：对大模型与 Runtime 仅暴露身形描述与语义 Cue（`warm_smile`, `curious_tilt` 等），**严禁泄漏任何内部通道或参数细节**；
- **私有内部通道仲裁**：内部常驻 `ChannelArbiter`，私有管理 5 个通道（`mouth`, `eyes`, `gaze`, `head`, `torso`）；
- **三层动作合成系统**：融合生理底噪、动力学弹簧与声学冲击，打造具备呼吸感与灵魂的自然动效（原设计的第四层「美术关键帧剪辑」从未实现，已删除——见 §3）；
- **语义微节奏剧本器**：通过 `live2d.express` 工具支持 LLM 以极低认知代价（~30 Token）编排两步微表情小巧思；
- **门面工具与通道 RAII**：复用 Uina 原生 `AppDef.actions`，执行时通过 `arbiter.claim()` 锁定通道，`finally` 自动释放。

---

## 2. 具身能力与物理状态契约 (Affordance & State)

### 2.1 纯净能力清单 (`live2dAffordance`)
```typescript
import type { BodyAffordance } from "../../docs/proposals/embodiment-architecture";

export const live2dAffordance: BodyAffordance = {
  bodyId: "live2d_mo",
  bodyType: "avatar_2d",
  description: "你当前在屏幕上呈现为 Live2D 虚拟二次元立绘形象（Mo）。",
  cues: [
    { id: "warm_smile", description: "轻微、友善的微笑" },
    { id: "happy_laugh", description: "开心地眯眼大笑" },
    { id: "curious_tilt", description: "好奇或思考时轻微歪头" },
    { id: "affirmative_nod", description: "肯定或赞同地点头" },
    { id: "playful_pout", description: "轻微傲娇或假装生气嘟嘴" },
    { id: "surprised_gasp", description: "睁大眼睛表示意外和惊讶" }
  ]
};
```

### 2.2 物理事实汇报 (`Live2DStateTracker`)
```typescript
import type { BodyState } from "../../docs/proposals/embodiment-architecture";

export class Live2DStateTracker {
  private online = false;
  private fault?: string;

  getState(): BodyState {
    return {
      online: this.online,
      fault: this.fault
    };
  }

  setVtsConnected(connected: boolean): void {
    this.online = connected;
    this.fault = connected ? undefined : "vts_disconnected";
  }
}
```

### 2.3 极简端点实现 (`Live2DEndpoint`)
```typescript
export class Live2DEndpoint implements BodyEndpoint {
  readonly bodyId = "live2d_mo";
  readonly bodyType = "avatar_2d";

  affordance(): BodyAffordance { return live2dAffordance; }
  state(): BodyState { return this.stateTracker.getState(); }

  emitCue(cueId: string): void {
    this.arbiter.dispatchCue(cueId);
  }

  async safeStop(): Promise<void> {
    // 打断急停：清空进行中的大幅动画，弹簧阻尼收敛回正
    this.motionComposer.abortAllMotions();
    this.bodyDirector.dampenToNeutral();
  }

  onFocus(isFocused: boolean): void {
    if (isFocused) {
      // 唤醒：睁眼，身体微前倾
      this.bodyDirector.transitionToActivePose();
    } else {
      // 退居辅助/休眠：视线微闭，进入待机立绘
      this.bodyDirector.transitionToParkedPose();
    }
  }
}
```

---

## 3. 三层动作合成器 (Layered Motion Composer)

> **原设计为四层，其中 Layer 1「美术级关键帧剪辑」已删除（2026-09-21）。** 该机制从无调用者、无 `motion3.json` 加载器，留着只会让人以为合成器有四层而实际三层。保留它的唯一理由是"设计文档这么写"——那正是本轮审查要消除的东西。若将来确实需要关键帧剪辑，应当连同 `motion3.json` 解析与资产管线作为独立批次立项，而不是留一个空壳。

为了彻底解决“纯数学弹簧过于呆滞”的矛盾，引入分层叠加合成机制：

```text
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: 声学瞬态冲击层 (Acoustic Impulse)                   │
│ - 播放侧电平超过瞬态阈值时，向下微冲头部 ParamAngleY (-1.5)  │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: 动力学滤波与次级物理 (Spring & Secondary Physics)   │
│ - 头发、呆毛、衣服飘带：交给 Live2D physics3.json 原生解算   │
│ - 身体躯干大动作：欠阻尼弹簧平滑过渡 (软限速 <= 90°/s)       │
├─────────────────────────────────────────────────────────────┤
│ Layer 0: 自发生理底噪层 (Physiological Noise - 纯代码自发)   │
│ - 正弦胸腹呼吸 (3.6s 周期)                                  │
│ - 头部多谐波低频微摆（倾角 + 左右微转）                      │
│ - 泊松分布随机眨眼 (带眼球微颤 Micro-saccades)               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        参数合成: Param = Clamp(Base + Spring + Noise + Impulse)
```

### 3.1 自发生理底噪 (`physiological-noise.ts`)

在 60Hz 渲染时钟中，即使无任何 LLM 输入，底噪层持续输出微小的活体扰动：

```typescript
export class PhysiologicalNoise {
  private phase = 0;

  tick(deltaMs: number): Record<string, number> {
    this.phase += deltaMs * 0.001;

    // 1. 呼吸：正弦波驱动胸腔微动 (3.6s 周期)
    const breath = (Math.sin(this.phase * 1.74) + 1) * 0.5;

    // 2. 头部低频微摆：多谐波复合正弦（倾角 + 左右微转）
    const headTiltZ = Math.cos(this.phase * 0.45) * 2.2 + Math.sin(this.phase * 0.18) * 1.2;
    const headGlanceX = Math.sin(this.phase * 0.3) * 1.8;

    return {
      ParamBreath: breath,
      ParamAngleX: headGlanceX,
      ParamAngleZ: headTiltZ,
      ParamBodyAngleX: 0,   // 躯干漂移恒为 0：本层不驱动躯干
    };
  }
}
```

> **校正**：原稿在此处声称"身体重心微小游移 (ParamBodyAngleX)"，但实现中 `ParamBodyAngleX` 恒为 0——低频晃动只作用于头部。**该能力未实现**（保留键位是为固定合成层参数集合）。若需要真实躯干游移，应作为表现力增强单独立项，而不是靠注释把 0 说成有。

### 3.2 动力学与姿态导向 (`body-director.ts`)

- **二阶欠阻尼弹簧解析解**（omega=15, zeta=0.45）：数学上无条件绝对稳定，杜绝大步长数值爆炸；
- **软限速**：基于 `tanh` 的连续软饱和（而非硬截断），既保留大步长精度又在高速时平滑饱和；
- **持久/限时基准姿态**：`applyBasePose(name, { holdMs })` 到期后 600ms smootherstep 自动回正，并回调同步 `currentBasePose`。


---

## 4. 门面工具与语义微节奏剧本器 (`AppDef.actions`)

> **校正**：`arbiter.claim` 的真实签名是 `claim(channels, { priority?, reason?, signal?, allowDegrade?, preemptSameReason? })`——取消信号在 options 内；`claimAllChannels(reason, signal?)` 才把 signal 放在第二参。本文档原先写作 `claim(channels, ctx.signal)`，形状不对。
>
> `ctx.signal` 是**必选**的：长动作必须把它透传进 `claim` 与分段等待，否则工具层回报 `cancelled` 时物理动作仍在继续（`flip` 已按此改为逐步可中断）。

对大模型暴露的 `live2d` 门面工具支持 **4 维自然语义与两步微节奏（Beats）**（各维度的**完整枚举与权重表以实现为准**，下列为该工具契约的骨架）：

```typescript
// 门面工具: live2d({ action, ...params })
actions: {
  express: {
    description: "控制形象进行细腻的即兴肢体表演与小巧思表达。注意：日常说话中的自然微笑、点头、歪头请直接在台词中使用 <cue id='...'/>（0 工具开销）；本工具仅在需要两步连贯分镜（beats）或强力即兴表演时调用。",
    parameters: {
      type: "object",
      properties: {
        // 单步即兴
        head: {
          type: "string",
          enum: ["tilt_left", "tilt_right", "nod", "shake", "lowered", "lifted"],
          description: "头部体态"
        },
        gaze: {
          type: "string",
          enum: ["user", "away_left", "away_right", "down", "side_peek"],
          description: "视线方向（user=注视用户, side_peek=斜向偷看, down=垂眸）"
        },
        face: {
          type: "string",
          enum: ["shy", "smug", "pout", "sparkle", "shocked", "tender_smile"],
          description: "面相微表情（shy=脸红, smug=得意坏笑, pout=嘟嘴傲娇）"
        },
        intensity: {
          type: "number",
          minimum: 0.1,
          maximum: 1.0,
          description: "情绪力度（0.2=轻微小心, 0.6=正常, 1.0=夸张强烈），默认 0.6"
        },
        // 高级小巧思：两步连贯微动作
        beats: {
          type: "array",
          maxItems: 2,
          description: "【高级小巧思】两步连续微动作（例如: 先扭头看旁边，再偷偷看一眼回来）",
          items: {
            type: "object",
            properties: {
              head: { type: "string" },
              gaze: { type: "string" },
              face: { type: "string" },
              hold_ms: { type: "number", description: "维持时间(毫秒)，建议 600~1500" }
            }
          }
        }
      }
    },
    run: async (params, ctx) => {
      const lease = await arbiter.claim(["head", "gaze", "eyes"], {
        reason: "action:express",
        preemptSameReason: true,
        signal: ctx.signal,
      });
      try {
        await motionComposer.playExpressiveBeats(params, ctx.signal);
        return "即兴表情动作已执行。";
      } finally {
        arbiter.release(lease);
      }
    }
  },
  costume: {
    description: "切换模型服装或发型配饰 (状态变更)",
    parameters: {
      type: "object",
      properties: { item: { type: "string" } },
      required: ["item"]
    },
    run: async ({ item }, ctx) => {
      const lease = await arbiter.claimAllChannels("costume", ctx.signal);
      try {
        await live2dController.changeCostume(item, ctx.signal);
        return `已成功更换装扮为: ${item}`;
      } finally {
        arbiter.release(lease);
      }
    }
  },
  pose: {
    description: "切换全身基准姿态 (relaxed, focused, playful)",
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: ["relaxed", "focused", "playful"] } },
      required: ["name"]
    },
    run: async ({ name }, ctx) => {
      const lease = await arbiter.claim(["head", "torso"], {
        reason: "action:pose",
        preemptSameReason: true,
        signal: ctx.signal,
      });
      try {
        live2dController.setBasePose(name);
        return `基准姿态已变更为: ${name}`;
      } finally {
        arbiter.release(lease);
      }
    }
  },
  flip: {
    description: "调皮式 360 度全身翻转动作",
    run: async (_params, ctx) => {
      const lease = await arbiter.claimAllChannels("flip", ctx.signal);
      try {
        await live2dController.executeFlip(ctx.signal);
        return "翻转动作已完成。";
      } finally {
        arbiter.release(lease);
      }
    }
  }
}
```

---

## 5. 内部语义解算权重矩阵 (`parameter-mapper.ts`)

App 内部维护静态权重矩阵，将大模型的语义组合瞬间解算为 Live2D Cubism 参数，杜绝大模型直接面对参数引发的幻觉：

> **校正**：实现已把下述 if-链升级为**声明式映射表**（`GAZE_TABLE` / `HEAD_TABLE` / `FACE_TABLE` / `CUE_BEAT_TABLE`），并附 `CUE_ALIASES` 别名表与去下划线归一化匹配。下表仅为解算思路示意，**以 `parameter-mapper.ts` 为准**。


```typescript
export function resolveBeatToParams(beat: ExpressBeat, intensity = 0.6): Live2DParamTarget[] {
  const targets: Live2DParamTarget[] = [];

  // 1. 视线解算 (Gaze)
  if (beat.gaze === "side_peek") {
    targets.push({ name: "ParamEyeBallX", value: 0.75 * intensity });
    targets.push({ name: "ParamEyeBallY", value: -0.2 * intensity });
  } else if (beat.gaze === "away_right") {
    targets.push({ name: "ParamEyeBallX", value: 0.9 });
  }

  // 2. 头部姿态解算 (Head)
  if (beat.head === "tilt_right") {
    targets.push({ name: "ParamAngleZ", value: -6.0 * intensity });
  } else if (beat.head === "lifted") {
    targets.push({ name: "ParamAngleY", value: 8.0 * intensity });
  }

  // 3. 面部表情解算 (Face)
  if (beat.face === "shy") {
    targets.push({ name: "ParamCheek", value: 0.85 * intensity });
    targets.push({ name: "ParamMouthForm", value: 0.2 });
  } else if (beat.face === "smug") {
    targets.push({ name: "ParamMouthForm", value: 1.0 * intensity });
    targets.push({ name: "ParamEyeRSmile", value: 0.8 * intensity });
  }

  return targets;
}
```

---

## 6. 代码组织拓扑 (`.uina/apps/live2d/`)

```text
.uina/apps/live2d/
  ├── DESIGN.md                 # 本规范文档
  ├── package.json              # App 声明
  ├── index.ts                  # AppDef 组合根 + 门面 actions + setVtsClientForTest
  ├── runtime.ts                # Live2DRuntime 聚合根：装配全部子模块、两处 ctx.expose、
  │                             #   宿主事件订阅、生命周期清理与状态（VTS 客户端在此自建）
  ├── types.ts                  # 领域类型与语义枚举、通道优先级、参数-通道映射
  ├── channel-arbiter.ts        # 内部私有 5 通道仲裁器（优先级抢占、降级、RAII 租约）
  ├── motion-composer.ts        # 三层动作合成器（底噪、弹簧、声学冲击）+ beats 编排
  ├── physiological-noise.ts    # 生理底噪生成器（呼吸、头部微摆、眨眼状态机）
  ├── parameter-mapper.ts       # 语义维度 -> Cubism 参数：声明式映射表 + Cue 别名表
  ├── audio-observer.ts         # 声学包络：接收 voice.levelSink 电平，驱动口型与瞬态微冲
  ├── reflex-director.ts        # 宿主回合级反射策略（turn_start / thinking / turn_end / aborted）
  ├── body-director.ts          # 欠阻尼弹簧解析解与 smootherstep 动力学引擎
  ├── companion.ts              # 60Hz tick 时钟、VTS 状态跟踪、参数注入
  └── vts-client.ts             # VTS WebSocket 协议封装（鉴权、热键、参数注入）
```

**两处对外暴露（均经宿主同进程共享表 `ctx.expose`，不是 `callService`）**：
1. `body.endpoint:live2d_mo` —— 具身端点本体，由 embodiment 扩展拉取并注册进 `BodyRouter`；
2. `voice.levelSink:live2d_mo` —— 声学电平接收端，由 tts 扩展按前缀筛出后推送电平。

两者都在 `Live2DRuntime.stop()` 的清理链里回收；`render("expanded")` 会如实呈现「具身注册」与「口型通道」的接线状态。

