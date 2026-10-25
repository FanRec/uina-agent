# Program（程序）详细设计

日期：2026-10-18（Asia/Shanghai）。状态：最简设计修订后的实施规格，**批 7 执行子集已实现；源码/产物与模型验收见 [实施记录](../program-implementation.md)**。源码中的旧 Program/Assets 类型不代表本规格已接线。

本文拥有 JS 入口、guest API、执行材料固定、QuickJS 执行与退役合同。库文件、元数据、CRUD 与检索由 [Library](library.md) 唯一维护。能力签名由 [能力面](capabilities.md) 拥有；运行、身体仲裁与效果结算由 [Runtime](runtime.md) 拥有；跨模块共享值与 Driver 方法由 [公开接口](../public-api.md) 拥有；蓝图与经验见 [Library](library.md)。每处只保留自己的权威定义。

批 7 当前支持 read/call/sleep/progress/withBody、console、已实现的 body/window 操作与只读程序材料；waitUntil、decide/checkpoint/continue、feedback/loop 和 Library 管理/发现仍是后续合同。下文是完整终态规格，不能把未来接口计作当前可用。QuickJS 固定 0.32.0，共享一个 Worker；WASM 宿主补丁和逐让出点实际堆检查见实施记录，堆策略不是 OS RSS 的硬上限。

## 0. 最终体验与验收目标

### 0.1 从试做到复用

下列是目标交互推演，不是已经发生的实录；`run`、`library` 是 minecraft 工具的 action 简写。

```text
run {code:"async function main(mc, input) { ... }", input:{count:8}}
→ 完成，或给出错误行、已发生的效果、进度与未知项
library {op:"save", name:"wood_pick", summary:"获得指定数量的橡木原木；需要附近有树",
         from:{run:"r1", segment:"s1", call:"c1"}}
→ programs/wood_pick.js 的路径与摘要
run {selector:"wood_pick", input:{count:24}}
→ 从当次捕获的文件字节执行；不需要重新提交源码
```

模型也能直接读普通文件、局部编辑后再运行。文件修改不影响本段已经解析过的名字；下一段按当前文件解析。复制变体使用 `get` + `save`，不要求先把程序参数化到完美。

### 0.2 一份程序用于三种组合

同一个 `wood_pick` 内部正常写 `mc.call("collect@1", input)`，可以独立执行、由另一个程序调用，也可以通过 `body.call` 接受身体委托。三种情况下不因调用位置改写它的内部调用。

```js
async function main(mc, input) {
  return await mc.call("wood_pick", { count: input.count ?? 16 });
}
```

```js
async function main(mc, input) {
  return await mc.withBody(async body => {
    return await body.call("wood_pick", { count: input.count ?? 16 });
  });
}
```

withBody 的回调结束前始终保留身体，包括子程序等待期间。需要其他任务使用身体时，应在作用域外等待。程序交还决策可以逐层传播；只有根未处理时才结束执行段。

### 0.3 需要得到的行为

1. 普通 JS 的条件、循环、局部函数、异常与 Promise 组合可以使用；不增加游戏 DSL。
2. 常见玩法一次能力调用完成，特殊玩法可用本地反馈控制；模型不参与逐 Tick 往返。
3. 一次保存能跨会话按名字复用，输入、返回、适用条件与示例能按需查到。
4. 失败、取消、正常返回与决策请求都关闭所属活动资源；已发生效果和未知项不丢失。
5. 多个合法等待不独占 worker，供料程序仍能运行；真正资源不足明确失败。
6. 运行记录可查确切调用源码，但不声称它等于依赖锁定或原世界重放。
7. 单个 guest 故障尽量局部隔离；worker 故障的影响范围和未知结果明确公开。

## 1. 设计裁决

| 问题 | 选择与实际边界 |
|---|---|
| 程序形态 | 合法 JS 脚本，入口 `async function main(mc, input)`；源码原样编译，行号对应执行快照 |
| 调用面 | 查询能力用 `mc.read`，动作与保存程序用 `mc.call`；暂不增加逐能力方法别名 |
| SDK | descriptor 生成的方法与按需发现可以兼容；当前两入口已经够用，是否增加糖由真实任务成本判断 |
| 对象 | body/window/stream 是有生命周期的句柄；不复制一棵 Bot 对象树 |
| 复用 | 文件内普通 helper；跨程序以 JSON 输入输出调用；不做 import/require/包管理 |
| 身体 | `body.call` 显式委托一次，委托沿子调用传播；外部捕获的上下文不自动升级 |
| 决策 | decide 同步抛出专用异常，沿错误桥传播；根未处理时才交还整个段 |
| 存储 | 库是普通文件；调用保存确切源码快照；没有发布、版本号或依赖锁 |
| 执行 | 少量共享 worker，每次程序调用独立 QuickJS runtime；Segment 不独占线程 |
| 预算 | 连续计算、内存与消息有界；没有默认累计 CPU 总量或游戏任务时长终止 |

跨程序调用并不等同于导入通用 JS 函数：函数、闭包和活句柄不能作为 input/返回值。几何辅助函数、控制器回调需要留在同一文件或复制修改。这是当前明确的复用范围，不是语言能力完全等价的承诺。

## 2. 程序 API 与组合

### 2.1 mc 表面

| API | 签名与语义 |
|---|---|
| call | `(selector, input?) => Promise<JsonValue>`；动作或程序，成功返回领域值，失败抛 Error |
| read | `(selector, input?) => Promise<{value, version, unknown?}>`；查询能力，version 为不透明游标或 null |
| waitUntil | `(targets, predicate, {timeoutMs?}?) => Promise<WaitResult>`；先读判定，再等失效并重读 |
| sleep | `(ms) => Promise<void>`；可取消；0 表示真正让出一次 worker 事件循环 |
| progress | `(value: Progress) => void`；覆盖式进度对象，最后值在调用结算前送达 Runtime |
| decide | `({reason, checkpoint?}) => never`；同步抛出专用 NEEDS_DECISION，可被本程序或父程序捕获 |
| withBody | `(work: (body) => Promise<T>) => Promise<T>`；独立申请或加入已委托 BodyScope，退出关闭所属资源 |
| checkpoint | 只读 `JsonValue \| null`；仅续段根程序取得上一段的程序检查点，子程序默认 null |
| console | log/info/warn/error；调用级有界缓冲，失败时可展开尾部 |

不知道能力时，在主脑工具层 describe；guest 不持有 describe/library 工具。查询用了 call 报 `USE_MC_READ`；动作/程序用了 read 报 `USE_MC_CALL`。调用参数在入口序列化时捕获，解析后的默认值、能力版本在派发前冻结；路径与目标选择继续根据实际世界更新。

### 2.2 身体委托

控制归属是调用谱系中的 BodyScope，Driver 同一时刻只有一个有效身体。Runtime 验证当前真实 CallFrame、祖先约束与委托，guest 的字段不授予权限。

1. 未取得身体的程序正常 mc.call；需要身体的能力在内部申请，用完释放。
2. 显式 withBody 的外层调用拥有身体；通过 body.call 把控制委托给子调用。该子调用的上下文绑定此 scope，内部 mc.call/原生 ctx.call 继续传播委托；它自己的 withBody 是重入，不二次排队。
3. 传播委托的 call 逐层挂起上层写句柄，返回并完成子范围清理后恢复；子退出不关闭祖先 Body。一次同一 scope 只允许一个控制委托路径，竞争委托报 BODY_BUSY；mc.read 不属于控制委托。
4. 原调用者捕获的外部 mc/ctx 没有因进入回调而自动获得委托。用它创建独立子调用不继承身体；后代实际申请身体时发现自等待，报 BODY_SCOPE_ACTIVE。纯计算/无身体调用可执行。
5. 委托期间旧句柄的写操作报 BODY_SUSPENDED；窗口/反馈流也不得成为旁路。返回后重新核验仍存活的窗口、维度与帧，不能把世界当成未改变。
6. withBody 回调结束前保留身体。waitUntil/sleep 不释放、续租或重新申请身体；等待不延长反馈帧和持续输入的有效期。物理控制时序使用 body.drive/loop，sleep(0) 只让出计算。
7. 只有已获委托的 mc/ctx 调用 withBody 才加入已有 scope。同一 guest 捕获的未委托原 mc 再调 withBody 仍是独立申请，报 BODY_SCOPE_ACTIVE；不承诺识别 JS 的词法嵌套或任意 Promise 分支。无关兄弟调用的身体队列不构成当前调用的自等待。

普通 helper 不创建 Call。原生能力内部可直接组合实现函数；需要公共子调用时使用当前上下文，服从同一委托规则。Runtime 不检测任意 Promise 等待环。持身体等待依赖其他身体任务的条件可能自锁；需要并行供料、收割等工作时，应在作用域外等待。停止始终可用。

原生能力自行取得身体时，应把装料、取物等身体阶段分开，在长期世界等待前退出自己创建的作用域；已接受祖先委托时，内部 withBody 只重入，退出不释放祖先。以下调用在两种位置使用相同能力源码；第二种显式保留身体到成品取得：

```js
async function main(mc, input) {
  const args = {item:"iron_ingot", count:input.count ?? 8};
  if (input.exclusive) {
    return await mc.withBody(body => body.call("smelt@1", args));
  }
  return await mc.call("smelt@1", args);
}
```

等待时查询按各自的游标继续工作，取消会关闭所属等待和控制。身体归属不等于输入一直有效；反馈流超期仍撤销其输入，显式 useItem 会话按 Driver 的所属资源合同清理。

### 2.3 body、window 与 stream

| API | 签名与返回 |
|---|---|
| body.call | `(selector, input?) => Promise<JsonValue>`；显式委托并沿子调用传播 |
| body.drive | `(input: ControlInput, opts?: {ticks?: number})`，ticks 缺省 1；返回 `{receipt, actualTicks, end}` |
| body.dig | `(at: BlockPos, opts?: {aim?: "target"\|"preserve"}) => Promise<EffectReceipt>` |
| body.attack | `(target: EntityRef) => Promise<EffectReceipt>`；尝试不等于命中/击杀 |
| body.useItem / endUse | `(opts?: {hand?: "main"\|"off"})` / `()`，均返回 EffectReceipt |
| body.interact | `(target: BlockPos\|EntityRef, opts?: {hand?, face?, cursor?}) => Promise<EffectReceipt>` |
| body.equip | `(item: ItemSelector\|null, hand?) => Promise<EffectReceipt>`；null 腾空指定手，不隐式丢弃 |
| body.lookAt | `(target: PointTarget\|EntityRef) => Promise<EffectReceipt>`；Driver 计算角度 |
| body.writeSign | `(at: BlockPos, {side:"front"\|"back", lines:SignText}) => Promise<EffectReceipt>`；只提交本面四行，编辑资格与确认见 Driver |
| body.openContainer | `(target: BlockPos\|EntityRef) => Promise<Window>` |
| body.feedback | `(sensors: Sensors) => Promise<Stream>`；next/apply/close |
| body.loop | `(step, sensors?) => Promise<void>`；同步 step 返回 ControlInput 或 `{done:true}` |

PointTarget 是连续坐标或 `{position, dimension}`；BlockPos 同形但各坐标须为整数。底层共享目标还包含 Place，由 Driver 在派发时用当前会话补齐。连接代次失效拒绝；进入身体以来维度变过而坐标未显式给维度时拒绝。实体使用 Driver 稳定引用，不能把网络编号当永久身份。

ControlInput 继续包含 keys、look/yaw/pitch、lookAt、use、attack。省略 keys 中的键表示本次控制不按下，不继承旧流按键；look/ lookAt 不同时提供。持续输入与物品使用的归属、释放后果由 Driver 合同决定，清理弓等物品可能产生真实效果。

```js
async function main(mc, input) {
  let outcome = "stopped";
  await mc.withBody(async body => {
    await body.loop(frame => {
      const me = frame.self.value;
      if (me.health < 8) { outcome = "low_health"; return { done: true }; }
      const p = me.place.position;
      if (Math.hypot(input.to.x - p.x, input.to.z - p.z) < 1) {
        outcome = "arrived"; return { done: true };
      }
      return { keys: { forward: true }, lookAt: input.to };
    });
  });
  return { outcome };
}
```

loop 正常结束只表示回调决定停；是否到达由程序判断。self 恒有；额外 sensors 使用查询 descriptor 声明的反馈采样能力。帧绑定已完成物理步、有效期与流身份；只接受本流已交付且仍有效的帧，每帧最多 apply 一次，不补播，超期撤销本流持续输入。step 不支持 await；异步逻辑可用 feedback 手写循环，但仍受帧有效期约束。

**窗口参照视图。** snapshot 建立调用方当前选择接受的视图。click 接收 `{slot, mode?, button?, expect?}`，mode 缺省 click、button 缺省 0；quick_move/swap 等合法模式由 Driver 描述。expect 若提供必须是明确 StackExpectation，不以 null 关闭驱动校验；没有 snapshot 时先取一次。

句柄从参照视图生成受影响槽位与光标预期（含模式可能触及的目标槽），派发前使用 Driver 实时 revision 作版本戳，Driver 仍原子核对预期后派发。外部改变相关槽位/光标时冲突，不取最新内容静默改变意图。

WindowClickReceipt 的共享形状见 [公开接口](../public-api.md)：只将本次操作已确认的槽位/光标变化用于推进参照；未受影响槽位继续保留原预期。完整的相关后态无法确认时标记 needsSnapshot，下次 click 必须先显式 snapshot，不能把任意最新快照认作自身操作结果。这样连续“拿起 → 放下 → 再点原格”能够组合，外部改动仍可检测。多次点击不构成服务端事务。

下面用同一个槽位连续拿起再放回，展示自身确认变化推进参照；不是物品转移目标的完成认证：

```js
async function main(mc, input) {
  return await mc.withBody(async body => {
    const win = await body.openContainer(input.chest);
    await win.snapshot();
    const first = await win.click({slot:input.slot});
    if (first.needsSnapshot) await win.snapshot();
    const second = await win.click({slot:input.slot});
    const after = await win.snapshot();
    await win.close();
    return {clicks:[first, second], after};
  });
}
```

窗口在所属调用与身体存活期间有效；退出 body 关闭未关窗口，释放光标/蓄力等固有后果照记。Stream.next 的帧保存在句柄中，apply 自动携带该帧引用，程序无需填写授权字段。

### 2.4 等待、未知与观察版本

```js
async function main(mc, input) {
  const r = await mc.waitUntil(
    { inv: { ref: "inventory@1" } },
    (s, { unknown }) => !unknown.inv?.length && (s.inv.counts.oak_log ?? 0) >= 8,
    { timeoutMs: 5000 },
  );
  if (r.kind === "invalidated") return { reason: r.reason };
  if (r.kind === "timeout") return { reason: "材料仍不足", inventory: r.values.inv };
  return r.values.inv;
}
```

只允许有观察游标的查询等待。静态知识、尚无失效流的派生规划和历史容器快照 version=null，waitUntil 在建立 watch 前报 INVALID_INPUT；不能为任意派生计算暗建依赖图。feedback 采样与可等待性是不同承诺，具体查询由 descriptor 声明，不能从名称推断。

每个 target 有自己的不透明 version，关联确切查询、参数、来源与代次。多目标结果使用 `versions: {[key]: cursor}`，不把不同流序号相加或取 max；单目标 read 仍使用 version。宿主 read 返回后，watch 原子比较各自游标：已经推进立即返回 changed，否则建立订阅，避免读后订阅间漏失效。不能把读/判定/后续动作说成原子事务；多查询不承诺联合快照，瞬时状态可能被合并错过。

value 或可观察性发生变化都推进对应版本：known↔unknown 同样唤醒，unknown 不等于空气、实体死亡或目标完成。epoch/来源重建返回 invalidated，且不带旧值/游标。返回 Promise 或非布尔 predicate 报 PREDICATE_INVALID。

期限从进入 waitUntil 开始，包含读取、判定和等待；worker 使用单调时间计算剩余 timeoutMs。changed 后重读重判；到期后最后重读并判定，满足则 met，否则 timeout 携带最后读到的 values/versions/unknown。无期限则不建超时器。调用取消关闭全部 watch；建立任一 watch 失败清理其他项并保留原错误，不让输家的取消错误覆盖结果。

events@1 通过 World 历史/游标进入相同 read/watch 路径。EventAfter 是应用的增量位置，version 是本次查询的失效版本，两者不能互换；分页 next 也不能当观察游标。最近窗口、分页或尚有 next 的结果不可等待，先读完页取得最终 after。具体合同见 [events](capabilities.md#events)。

```js
async function main(mc, input) {
  const baseline = await mc.read("events@1", {kinds:["chat"]});
  const after = baseline.value.after;
  await mc.call("chat@1", {text:input.text ?? "/list"});
  const changed = await mc.waitUntil(
    {messages:{ref:"events@1", input:{kinds:["chat"], after, limit:200}}},
    (s, {unknown}) => s.messages.gaps.length > 0 ||
      (!unknown.messages?.length && s.messages.events.length > 0),
    {timeoutMs:5000},
  );
  return changed; // 只是读到新消息/缺口；不认定其中某条就是本命令的成功回应。
}
```

若增量超过一页，waitUntil 的版本检查报 INVALID_INPUT 并提示分页；用 mc.read 的 next 读完后继续，不静默漏掉后页。需要处理每条记录的程序保存事件 ref 与 after，由自身逻辑决定是否已处理；Runtime 不替它维护消费位。

### 2.5 决策请求与新段

```js
async function main(mc, input) {
  try {
    return await mc.call("mine_iron", input);
  } catch (e) {
    if (e.code !== "NEEDS_DECISION") throw e;
    if (input.canReturnHome) {
      await mc.call("goto@1", { at: input.home });
      return { ended: "returned_home", reason: e.reason };
    }
    throw e; // 保留原请求，交给更外层处理
  }
}
```

decide 在 guest 内同步校验并捕获非空 reason 和 JSON checkpoint，然后抛出 shim 创建的专用异常，不发宿主 RPC、不关闭调用。它可在本程序捕获；未处理时由 invoke 的决策分支交给宿主，宿主按真实 Call、程序名和摘要补 origin，忽略 guest 自填来源。跨 guest/native 复用已有错误桥，保留专用类别和原请求关联，不压成 PROGRAM_ERROR。普通 Error.code 或返回 `{code:"NEEDS_DECISION"}` 不能建立该关联。

抛出时捕获的请求内容不随原 checkpoint 对象或可见 Error 字段修改而改变。父程序要改原因或检查点时重新调用 mc.decide，来源为父调用；原样 throw 则保留原请求。

未处理请求逐层关闭返回的子范围，途中父程序可 catch/改策略/throw 原请求。仅根未处理时，Runtime 封闭段新准入，取消仍在途后代，撤销控制、退役 guest、结算效果并持久写 decision；body 的 finally 只释放所属资源，不负责决定段生命周期。取消/记录故障优先，不因决策请求覆盖显式停止。

程序检查点内部保存 `{kind:"program", value, origin}`，对应公开 Checkpoint 的程序分支；没有提供时为 null。根续段 mc.checkpoint 只暴露 value，来源在 runs/decision 可查。子调用不隐式接收祖先检查点，需要时显式传 input。原生领域分支继续携带 schema/value/evidence；程序检查点不隐式注入原生调用，显式转交数据仍受该能力输入/领域 schema 校验。

continue 核验 decision 未消费，创建新段和新活引用，保留 Run 关联与各段记录。新段按自身入口合同结算，不认证此前目标已经完成；累计业务量由程序检查点或领域对象维护。不恢复栈、不自动重发未知效果。

### 2.6 失败与结果真实性

成功 await 返回领域值。CallError 携带 code/source/message/hint/dispatch/effects/progress/recoverable；dispatch 与 effects 由 Runtime 填。source 是报错来源，不是责任裁定；hint 仅是建议，不靠错误文本分支，也不凭模板假装分析了任意源码。

查询失败与 unknown 分开。目标型能力未满足合同抛领域错误并保留真实进度；会话型能力声明允许的 ended 原因。程序默认 completion.scope=execution，输入输出校验和 return 都不成为游戏目标证明。取消停止已确认可以 cancelled，同时仍有 unknownEffects；正常返回也不能清空未解决的效果。

错误文本包含执行快照路径与行号、来源、已完成工作、未知效果和简短建议。原生能力与 guest 错误在对方域还原为 Error；返回值不是错误载体。已结算错误仍留在调用树中，父程序 catch 后可成功走替代路径。未处理的原始宿主 CallFailureData 保留领域 code/source/dispatch/effects/progress 进入 InvokeResult.failed，不能一概改成 PROGRAM_ERROR；只有普通 JS 异常才按程序错误分类。

## 3. 文件、元数据与执行材料

### 3.1 单文件与入口

```js
// uina {"summary":"获得指定数量的橡木原木；需要附近有树","tags":["木","开局"],"input":{"type":"object","properties":{"count":{"type":"integer","minimum":1}}},"output":{"type":"object"},"examples":[{"input":{"count":8}}]}
async function main(mc, input) {
  return await mc.call("collect@1", { item: "oak_log", count: input.count ?? 8 });
}
```

执行时求值脚本，再调用全局 main。main 可返回 Promise；缺省 input 是 `{}`，main 正常返回的顶层 `undefined` 规范为 `null`。没有 wrapper、exports 或 ESM，错误行号取确切快照，不追求编辑前后的行号稳定。

顶层应只放声明与常量。求值用户脚本时尚未注入宿主桥；提取 main 后才注入 mc/body/console 所需 shim。顶层死循环、异常和内存错误仍受执行边界约束。顶层不能到达句柄只是局部防护，真实动作准入始终由 Runtime 当前调用身份决定，不能以语法约定代替授权。

不暴露 process、require、fs、net、fetch、原始 Bot 或数据库。静态模块语法不作为脚本接受；动态 import 的模块加载器明确拒绝，不能将不支持的导入变成永不结算的等待。

### 3.2 文件头

程序使用一个可选的首行 `// uina {…}` 头。头字段、schema、坏头诊断和完整源码修复由 [Library §5.1](library.md#51-程序文件与头) 唯一定义。Program 只消费已经解析的材料；头非法时运行报 PROGRAM_INVALID(reason=header)，不忽略输入输出合同。

### 3.3 选择子与源码读取

Library 按 [文件规则](library.md#2-目录命名与分工) 解析程序名，返回确切原文、头及摘要；同名冲突报 PROGRAM_CONFLICT。临时代码复用同一头解析函数，不扫描文件。

不含 `@` 的合法选择子是程序名；含 `@` 的是能力精确引用，如 `collect@1`。因此 `craft` 也是合法程序选择子，文件不存在时报 `PROGRAM_NOT_FOUND` 并可建议能力 `craft@1`，不能同时把它判为语法非法。非法选择子报 `SELECTOR_INVALID`，建议只提供候选，不自动替换。

Program 不另做库路径解析；读取错误与冲突保留 Library 诊断，不回退到其他名字或来源。

worldDataDir 继续使用既有激活约定：无 profile 时 `<cwd>/.uina/world-data/<worldName>`，有 profile 时 `<cwd>/profiles/<id>/state/world-data/<worldName>`。程序、蓝图、经验、Runtime 记录和 World 历史是同根下的邻居，见 [Library](library.md)。

### 3.4 解析、校验、快照

```text
resolve({name}|{code}) → 完整读取确切字节、头与 digest（不执行）
validate(program)    → 同一 QuickJS 在 worker 中 compileOnly（异步）
writeSnapshot       → runs/<run>/sources/<sha256>.js
openSegment         → 建立逻辑调用范围（不执行源码、不预占 guest）
scope.invoke        → guest 准入、求值、调用 main
```

Runtime 在受理前准备入口材料，先落快照再提交记录；程序根的 openSegment 用这份材料种入名字缓存，不能重读；原生根也可建立空逻辑范围，首次子程序按相同 singleflight 解析。子程序在段内第一次解析时固定字节，缓存解析 Promise（singleflight）；并发同名调用得到同一份材料，解析失败驱逐条目，成功后不再重读。临时代码直接按内容摘要固定。

每次程序 Call 记录 `{name/origin, digest, snapshot}`；同一 run 同摘要复用快照文件，不是每调用复制一份。写临时文件后 rename；已存在时核对字节。子程序同样走快照路径。语法/头/大小错误在调用 guest 准入前返回；编译请求可在 worker 轮转等待，但不等待其他 guest 结束、不占常驻 guest 名额。

### 3.5 追溯、更新与版本边界

接口 major 仍由能力作者维护；每次能力调用记录 descriptor 摘要。程序在段内同名固定，下一个段读取当前文件；环境记录 `{serverVersion, protocol}`，未知信息保持未知。

快照保证“曾经执行了哪些字节”可查，save from 能恢复某一次调用的源码。它不保证下次仍使用旧依赖：`A → B → native` 中只保存 A 不会保存 B，历史记录也不自动成为依赖锁。需要变体就复制命名；破坏公共输入输出时同步修调用者或另存程序。记录被清理则来源明确断链，不从当前文件补造旧源码。

## 4. 保存与复用

Library 唯一管理 programs/blueprints/experiences 的文件和元数据，五种文件操作见 [Library §5](library.md#5-library-表面)。ProgramPort 不提供 CRUD、列表或另一份检索。

试做后用 `library.save {name,summary,from:{run,segment,call}}` 精确保存调用源码；查看、完整源码替换、metadata 补丁和坏头修复均走同一 Library。普通文件工具也可编辑库文件。保存不冻结依赖、不认证玩法有效。

模型通过“试做 → 查看结果 → 修改 → 保存 → 换场景复用”迭代。方法和默认值进入代码，适用条件与反例进入经验文件。执行时仍按 §3 固定源码，改工作文件不改变在途材料。

发现规则与 describe 的唯一合同见 [Library §8](library.md#8-发现)。guest 不持有目录或库写代理，主脑按需发现后用 mc.read/call。

## 5. QuickJS 执行与关闭

### 5.1 结构与所有权

```text
Runtime → ProgramPort → 逻辑 SegmentScope（名字缓存、调用归组、关闭）
                    └→ 共享 worker 池 → 每 Call 独立 QuickJS runtime
```

Program 在 Minecraft 伴生进程内运行；Executor 唯一监管该进程树。worker 内多个段各有独立 guest，等待一个宿主操作不会独占线程。默认 workerCount=1，可配置；新 guest 分配到常驻 guest 最少的 worker，同数按 worker id。调用存活期间固定线程，不迁移语言栈；逻辑段可以跨 worker，不强求同树共享线程。

worker 故障可能影响多个段；QuickJS guest 的局部超时/内存错误尽量只关闭该调用。这是明确的故障边界，不承诺所有 guest 永不互相影响。QuickJS/WASM 限额不是进程 RSS 或 OS 故障隔离；主进程、宿主消息和外部内存仍需实测。

### 5.2 准入与初始策略

| 策略 | 初始值 | 生效范围 |
|---|---|---|
| workerCount | 1 | 共享执行线程；不是同时活动段数 |
| maxResidentGuests | 32 | 全 Program 服务的常驻 guest，含正常等待者 |
| maxPendingRpcsPerGuest | 16 | 每 guest 在途宿主 Promise RPC |
| guestMemoryBytes | 32 MiB | 每个 QuickJS runtime 的受管堆，不是 RSS |
| computeBurstMs | 20 | 一次未真正让出 worker 的连续解释计算 |
| maxSourceBytes / maxValueBytes | 64 KiB / 1 MiB | 源码与每个 JSON 边界值 |
| consoleBytes | 16 KiB | 每调用控制台环形缓冲 |
| retireGraceMs | 1000 | guest 退役或强杀 worker 的证明窗口 |

这些是待测初值，不是已证明的玩法上限。无默认墙钟任务上限，也无默认累计 CPU 终止。CPU 累计量可以观察；若任务显式给总预算则按该预算失败，不能偷偷把长任务换成定时终止。

逻辑 openSegment 不占 guest 名额；每次 invoke 原子检查全局常驻 guest 名额，满即 PROGRAM_CAPACITY，不排队等待其他 guest 结束。RPC 表满同样在派发前拒绝，不排队等槽；拒绝的新调用无效果，父调用已有的效果照记。32 个合法等待者耗尽实际预算时，新调用明确失败而非永久 queued；多个等待者少于上限时不挡供料程序。

只在 guest 已确认销毁或其 worker 已退出时释放名额；退役不明保持占用。capacity 直接报告线程健康、常驻 guest/在途 RPC 的占用、所属 run/segment/call 与 waiting 原因；Runtime 不维护第二份容量账。

### 5.3 pump、计算与消息

每个 runtime 独立计量。执行用户顶层/main、同步回调、JSON 值转换与 pending jobs 时，使用 QuickJS 中断及内存/栈上限。worker 在 guest 间轮转，每次 pending-job pump 最多执行一个 job，随后返回 worker 事件循环；同步 job 超过连续预算则终止该调用。停止与反馈消息优先处理，但不声称 worker 提供硬实时调度。

发出 __post、console 或 progress 不重置 burst；只有真的返回 worker 事件循环才重置。`await Promise.resolve()` 可以产生无限微任务，按上述限量 pump 逐次轮转；仍可取消，累计 CPU 可见。显式 `await mc.sleep(0)` 是程序切分长同步循环的出口。取消标志在 SharedArrayBuffer 中由宿主 Atomics 写入，中断回调检查；同步死循环不能依赖 worker 收到 cancel 消息。

progress 是调用级最后值，console 是有界环形缓冲；worker 在让出/结算时批量上送，不逐日志创建无界消息。每个 JSON 值的字节上限在跨边界前检查；循环/函数/bigint/非有限数等报 PROGRAM_VALUE。对象 undefined 属性省略、数组 undefined 转 null，只有程序 main 顶层 undefined 规范为 null。

guest 等待但无在途宿主项时显示 waiting.kind=idle 与 idleMs；host_call/world_change/sleep 各自显示方法与开始时间。合法等待不自动杀，悬挂 Promise 仍可显式停止。日志环与进度缓存不算在途 Promise RPC，也不能变成无界队列。

### 5.4 正常关闭、取消与 worker 故障

Runtime 首先封闭本范围 RPC/动作准入，撤销有关控制并取消在途子调用；Program 根据调用身份中断/销毁所属 guest，不依赖 guest 的 catch/finally 合作。晚到回复不重开 guest，但必须进入 Runtime 效果记录。

只有 main/invoke 的返回 Promise 最终正常完成，或未处理的异常/NEEDS_DECISION 跨出本调用边界时，才在该同步边界封闭 CallScope。decide 只同步抛出专用异常；在本程序内捕获的请求不关闭当前调用。此时仍在途且因父关闭被中断的子调用，记录 `closedByParent`；根结果的 interruptedChildren 从该记录读取，不从当前“尚未结束”状态重建。已经结束的未处理 Promise 不由 parent/outcome 推测“是否 await”。父正常返回只声明本执行合同结束，正文必须保留被关闭子调用及未知效果。

单段关闭逐个退役自己的 guest，得到每个 runtime 已 dispose 的确认；正常关闭不要求共享 worker exit。确认同时覆盖其本地 promise 表、缓存进度与消息序列尾部；宿主动作关闭/效果屏障由 Runtime 另行完成，guest 销毁不是世界效果结算。

取消标志 50ms 仍未生效或 guest 销毁无法证明时升级到 worker 故障：Program 通知 Runtime 封闭该 worker 全部在册调用准入，撤销所属控制，再 terminate worker 并等待 exit。只有已收到 exit 才释放该 worker 的 guest 名额；在册调用分别记录 PROGRAM_CRASH 或原取消原因，保留效果与 unknownEffects。退出无证明返回 unknown，由 Executor 按既有隔离合同处理，不宣称已经停止或安全替换。

确认 worker 退出后可以补建替代线程，但不自动重跑受影响程序。未受影响 worker/原生调用按自身有效性继续，不能把故障概括成所有游戏效果都失败。

### 5.5 控制时延的证据边界

反馈路径是 Driver 采样 → worker/QuickJS step → Driver 检查并应用到后续实际物理步。测 sampledAt 到应用时刻、appliedStep 与采样 step 的差、过期拒绝、丢帧和真实落点/战斗结果；对照不含 guest 的控制路径。单次 RPC/JSON 微基准不能推出实际帧时延，20ms burst 也不能推出帧间隔 p95<50ms。

## 6. 模块边界与修订落点

Program 拥有语言隔离、shim、逻辑段与 guest 退役；Runtime 拥有真实 CallFrame、Body 委托、根决策转换、记录屏障和结果；Driver 拥有实际输入、窗口操作与反馈有效期；Library 拥有文件及元数据；World 拥有观察游标、历史与证据。这些游戏侧职责不向 Uina Core 引入游戏概念；可靠交付消费批 5 已实现的 [Host 通用持久回执](../../runtime/delivery-receipts.md)。

对应正文同步在 [Runtime](runtime.md)、[能力面](capabilities.md)、[Library](library.md)、[公开接口](../public-api.md)、[行为契约](../contracts.md) 与 [概要](../design.md)。历史取舍只在 [changelog](../changelog.md)，不作为第二套当前规则。

## 7. Program 公开类型与端口

ProgramHeader/ProgramSummary/ProgramDetail 由 [Library §5.4](library.md#54-公开类型与端口) 定义。以下是执行端口；JsonValue/JsonSchema/Ref/Checkpoint/DecisionRequest/CallFailureData/WindowClickReceipt 等共享值引用 [public-api](../public-api.md)，不在这里复制领域结构。

```ts
type SourceRequest = { name: string } | { code: string };
interface SnapshotRef { digest: string; path: string }
interface HandleRef { handle: Ref; kind: "body" | "window" | "stream" } // 宿主登记；数据本身不授权
interface ResolvedProgram {
  name: string | null; origin: "library" | "code";
  source: string; digest: string; header: ProgramHeader;
}
type ProgramValidation =
  | { ok: true; digest: string }
  | { ok: false; code: "PROGRAM_INVALID"; reason: "syntax"|"encoding"|"size"|"header";
      message: string; line?: number; column?: number };
interface ProgramPort {
  resolve(source: SourceRequest): Promise<ResolvedProgram>;
  validate(program: ResolvedProgram): Promise<ProgramValidation>;
  writeSnapshot(request: { run: Ref; program: ResolvedProgram }): Promise<SnapshotRef>;
  readSnapshot(request: { run: Ref; digest: string }): Promise<{source: string; path: string} | null>;
  openSegment(request: {run: Ref; segment: Ref; entry?: ResolvedProgram; signal: AbortSignal}): ProgramSegmentScope;
  capacity(): ProgramCapacity;
}
interface ProgramSegmentScope {
  resolve(name: string): Promise<ResolvedProgram>; // 段内 singleflight；失败驱逐
  invoke(request: {call: Ref; program: ResolvedProgram; input: JsonValue;
    checkpoint: JsonValue | null; host: ProgramHostApi; signal: AbortSignal}): Promise<InvokeResult>;
  close(reason: "finished"|"decide"|"stop"|"failed"): Promise<ProgramRetirement>;
}
type InvokeResult =
  | {kind: "returned"; value: JsonValue}
  | {kind: "decision"; request: DecisionRequest}
  | {kind: "failed"; failure: ProgramFailure | CallFailureData};
type ProgramRetirement = {state: "retired"; stoppedAt: string} | {state: "unknown"; detail: string};
type FailureSource = "program"|"capability"|"world"|"input"|"environment";
type ProgramFailureCode = "PROGRAM_NOT_FOUND"|"SELECTOR_INVALID"|"PROGRAM_INVALID"
  |"PROGRAM_INPUT_INVALID"|"PROGRAM_CONFLICT"|"PROGRAM_RETIRED"|"PROGRAM_CAPACITY"
  |"PROGRAM_ERROR"|"PROGRAM_VALUE"|"PROGRAM_MEMORY"|"PROGRAM_TIMEOUT"
  |"PROGRAM_CRASH"|"CANCELLED";
interface ProgramFailure {
  code: ProgramFailureCode; scope: "call"|"worker"; source: FailureSource;
  message: string; line?: number; column?: number; guestStack?: string[];
  consoleTail?: string[]; hint?: string;
}
interface ProgramCapacity {
  observedAt: string; workerCount: number; maxResidentGuests: number;
  residentGuests: number; maxPendingRpcsPerGuest: number;
  workers: {id: string; state: "active"|"stopping"|"unknown"; guests: number}[];
  calls: {run: Ref; segment: Ref; call: Ref; worker: string;
    state: "running"|"waiting"|"retiring"|"unknown"; pendingRpcs: number;
    waiting?: {kind: "host_call"|"world_change"|"sleep"|"idle"; method?: string; sinceMs: number};
    idleMs: number; computeTotalMs: number}[];
}
type Targets = Record<string, {ref: string; input?: JsonValue}>;
interface ReadValues {
  values: Record<string, JsonValue>;
  versions: Record<string, string | null>;
  unknown: Record<string, string[]>;
}
type WaitResult =
  | ({kind: "met"|"timeout"} & ReadValues)
  | {kind: "invalidated"; reason: string};
type WatchResult = {status: "changed"|"timeout"} | {status: "invalidated"; reason: string};
interface ProgramHostApi {
  call(input: {selector: string; args: JsonValue; delegateBody?: boolean}): Promise<JsonValue>;
  read(input: {targets: Targets}): Promise<ReadValues>;
  watch(input: {targets: Targets; after: Record<string, string>; timeoutMs?: number}): Promise<WatchResult>;
  sleep(input: {ms: number}): Promise<null>;
  progress(input: {value: Progress}): Promise<null>; // shim 对外同步，本地覆盖合并后上送
  acquireBody(input: {}): Promise<HandleRef>;
  releaseBody(input: {handle: string}): Promise<null>;
  handleOp(input: {handle: string; op: string; args: JsonValue}): Promise<JsonValue | HandleRef>;
  closeHandle(input: {handle: string}): Promise<null>;
  log(input: {level: "log"|"info"|"warn"|"error"; text: string}): Promise<null>;
}
```

mc.read 是单目标 read RPC 的薄包装；waitUntil 的 predicate 留在 guest，watch 只搬运失效事实。ProgramHostApi 由 Runtime 绑定真实调用及委托，消息内 call id、delegateBody 只表示请求，不授权。

首次未处理的 guest 决策由宿主在 invoke 边界关联当前 Call；传入父 guest 的原请求由错误桥保留关联，原样上抛不重写来源。shim 用内部标记区分决策异常，宿主不从任意用户字段接受 origin。ProgramPort.invoke 的 decision 分支对外始终带宿主关联的 origin；worker 内部的本地异常不要求自带可信来源。NEEDS_DECISION 是独立的控制请求结果，不混入 ProgramFailureCode。普通调用错误码另含 USE_MC_READ/USE_MC_CALL、BODY_SCOPE_ACTIVE/BODY_BUSY/BODY_SUSPENDED、STEP_ASYNC、WINDOW_CLOSED、ACCESS_DENIED、PREDICATE_INVALID；按当前调用局部处理，隔离失守才升级。

## 8. 实施与验收

Program 通过注入的只读库入口解析名字，拥有执行快照、逻辑段/共享池与 QuickJS 桥；Runtime 不 import QuickJS 类型。当前源码已清理，具体文件布局留给实现按职责收敛，不预建 Manager 或新的插件生命周期。

### 8.1 跨模块验收

| 场景 | 必须观察到什么 |
|---|---|
| 同源三用 | 同一采集程序独立、嵌套、body 委托均可运行，内部不改调用写法；外部捕获上下文仍不升级 |
| 熔炼与身体等待 | 独立熔炼自行释放身体等待；受委托时保留祖先身体。phase=waiting/control=active 可并存；反馈输入按期过期，其他身体申请排队，stop 清理等待与控制 |
| 三层交还 | 中间层可处理 NEEDS_DECISION；原请求未处理到根才生成 decision；新根 mc.checkpoint 得到原 JSON |
| 多等待与供料 | 至少四个合法等待 guest 存在时第五个供料程序执行；耗尽 32 时明确容量失败而非互等 |
| 更新与保存 | 活段同名固定，新段读新文件；完整 source 替换不继承头，metadata 补丁不改脚本体，坏头只用完整源码修复；save from 对到 call，依赖不声称锁定 |
| 部分完成 | 挖掘数与入包数不同、部分施工、未知效果都不能被包装成目标完成；父子/跨段进度不重复累计，新段不认证旧目标 |
| 结果交付 | 真实 Host 持久回执才确认交付，崩溃后核对/补投可重复；原报告可查询，不重放动作，见 Executor §8 |
| 窗口连续操作 | 同一槽位反复拿放可组合；外部相关槽/光标变化拒绝；后态未知要求重新 snapshot |
| 隔离与故障 | 单段 stop 不终止共享 worker 的其他段；worker 强杀前封准入，影响范围/未知效果/容量均可查 |
| 模型学习闭环 | 只给短指南和发现入口，完成试做、保存、调用、局部修改；统计查阅次数、错误恢复轮数与真实任务结果 |

这是完整终态验收表；批 7 执行子集已运行，结果见实施记录，其余场景仍待后续批次。所有例子需以冻结 descriptor 和真实桥接复核，不能因本文有代码块就写成“已进 tests 全绿”。

### 8.2 分层验证

下列是不同承诺的验证归属，不是每个功能都重复跑五层的流程。环境选择、结果复用与检查频率统一见 [开发规范](../development-guide.md#5-验证选择)。

1. 文件层：头/schema/示例、损坏修复、来源快照、并发修改、路径与 digest；compileOnly 不执行顶层。
2. guest/桥：同步死循环、微任务循环、内存/栈、JSON 边界、缺省参数、来源错误、晚消息与取消；同引擎诊断。
3. Runtime/Driver：委托谱系、父关闭记录、决定传播、窗口前后态、实际控制撤销与在途效果结算。
4. 真实服务器：从零木镐、采矿回基地、蓝图小屋、容器熔炼、探索遇险；记录协议版本、运行调用树、效果证据与人类观察。fake bot 与微基准不代替这一层。
5. 资源/实时性：共享线程同时服务等待与控制，测完整帧路径、真实控制效果、满载 RSS 与消息峰值；调初值必须同时记录正常任务通过率，不用更严限额掩盖接口缺陷。

## 9. 未验证项与扩展边界

共享 Worker/独立 guest、窗口确认参照、已有 body 操作与执行材料已在批 7 实现；决策异常桥和完整反馈控制仍待后续批次。QuickJS 已固定 0.32.0，真实编译/销毁证据见实施记录；WASM 峰值 RSS 与长期负载仍需另行测量；个别调用的摘要固定不代表 native 实现或世界状态可重放。

聊天等事件由 events@1 的历史/增量合同接入；其具体查询、分页、缺口和条件可等待性见能力面，不增第二套事件 API。跨 World 的库共享不在当前设计内，复制普通文件可作为人工复用；不增加隐式上层库或名称回退。

## 附录 A：模型的最小指南

以下是生成指南的内容要求，不是独立维护的第二份签名表。常驻内容只说明入口、能力类别与展开位置；body/window/反馈等详细说明按需 describe。

```text
程序是普通 .js：async function main(mc, input) { ... }。input 缺省 {}，return 是程序结果。
查询能力：const {value, unknown} = await mc.read("inventory@1");
动作/程序：await mc.call("collect@1", {item:"oak_log", count:8}); await mc.call("wood_pick", {count:8});
聊天/服务器指令：await mc.call("chat@1", {text:"/list"}); 首字符 / 表示指令，sent 只确认发送。
读回应/事故用 events@1：先读最近窗口取得 after，再用同 kinds 的 after 增量读；next 翻页，version 只用于等待。
找动物用 explore@1 的 until:{entity:"cow"}；来源查 item，在线公告名单查 players；名单不等于当前实体。
看地图用主脑 observe(map@1) 得到图片，无需图片时 image:false；写牌用 use@1 的 at/text/side，读回用 block。
物品转移：transfer@1 的 from/to 恰一，另一端为自身库存；容器可填 "nearest"。drop@1 可 toward 玩家，只证明丢出。
@major 是能力引用；裸名是保存程序。签名不确定先用工具 describe，包含完整可复制示例。
工具 observe 查事实，run 执行，runs 查进度/停止/继续，library 管文件，chat 发消息或 /指令。
accepted 尚未完成；unknown 先按返回的 request 查证；工具取消只结束等待，要停游戏任务用 runs.stop。
unknown 表示没看清；找不到只说明查询覆盖内没找到。动作不足/失败看 e.code/e.progress/effects。
mc.progress({summary:"正在采集", acquired:6}) 报告结构化进度；Runtime 不替程序累计数量。
需要精细操作：mc.withBody(async body => ...)，body.call 委托，子程序普通 call 继承；回调等待也保留身体。
控制 API、窗口与反馈的详细合同按需展开；loop 停止不自动表示目标完成。
await mc.waitUntil(targets, (values, {unknown}) => 布尔值, {timeoutMs:5000});
结果 met/timeout 有 values，invalidated 只有 reason；只有有游标的查询能等。需让其他任务用身体时在 withBody 外等待。
mc.decide({reason, checkpoint}) 同步抛 NEEDS_DECISION；本程序或父程序可处理，否则根交还主脑。
continue 新段的根程序通过 mc.checkpoint 取得 JSON；不恢复旧栈或旧身体。
跑通后 library save {name, summary, from:{run,segment,call}}；get 查看源码，文件工具可局部改写。
程序/经验/蓝图都能发现；动作/程序用 call，查询用 read。保存只保存本程序，不冻结依赖。
无 import/require/fs/net/跨调用共享全局。长同步计算显式 await mc.sleep(0) 分片；超限有明确错误。
程序正常返回只表示执行完成，世界目标与未知效果以记录和观察为准。
```

## 附录 B：继承的微基准与适用范围

下列数字保留原稿记录（Node v24.13.1 / Windows / quickjs-emscripten@0.32.0），本轮未复跑；它们不是共享池、真实服务器或故障隔离的验收。

| 原记录项 | 原记录结果 |
|---|---|
| 空 worker 启动 / 含 QuickJS 就绪 | 17.2–19.6ms / 37.1–41.0ms |
| 主线程 worker 往返 | p50 0.026ms / p95 0.085ms |
| worker 终止 / QuickJS 同步中断探针 | 0.8ms / 37.4ms（2001 次回调） |
| runtime + context / compileOnly | 0.16ms / 0.4–0.5ms |
| 15KB JSON 解析 | 0.37ms |
| QuickJS 32MiB 堆膨胀 | 原探针观察到 out of memory，之后新上下文可用 |
| V8 worker 堆限额探针 | 原探针曾观察到整个进程 abort；不能概括成所有 worker 超限都如此 |
| 单 worker + QuickJS RSS | 约 62MB；不外推 32 guest 的总 RSS |

动态 import 在原探针中悬挂的观察不作为本设计行为；本设计要求模块加载器明确拒绝。上述原始探针未随本次修订重新交付，完整复现与共享池测量列入 §8。
