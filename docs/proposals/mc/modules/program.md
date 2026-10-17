# Program（程序）详细设计

状态：详细设计，待实施。本文是 Minecraft Program 的终态设计。

本文取代：`public-api.md` §6、§6.3、§7.1 中程序 API 与执行端口的部分；`assets.md`（已改为 Library）中 Program 作为资产、`publishFromRun` 的部分；`runtime.md` §9、§10 中程序执行域的实现建议与 `mc.wait` 条件注册。本文未覆盖的部分（身体仲裁、调用与效果记录、World 查询语义、能力实现）仍归 Runtime / Driver / World；蓝图与经验归 [Library](assets.md)。

---

## 0. 终态

### 0.1 一段实录

下文的 `mc` 指 Minecraft 工具（action：`observe` / `describe` / `run` / `runs` / `library` / `say`），`library list` 是 `mc library {op:"list"}` 的简写。

新世界，第一晚。

```text
Uina: mc run { code: "…砍 8 个原木…", input: {} }
      失败：program.js:14 · 程序错误 · TypeError …   （临时代码的文件名就叫 program.js）
Uina: 改两行，重跑。
      mc run { code: "…" }  → ok { logs: 8 }
Uina: library save { name: "wood_pick", summary: "砍够原木；附近需要橡树",
                     from: { run: "r-3f", segment: "s1", call: "c2" } }
```

第二天要盖房子：

```text
Uina: library list                          → wood_pick（砍够原木…）、craft_basic（工作台与木棍…）
Uina: library get { name: "wood_pick" }     → 源码 + 头部说明 + lesson
Uina: mc run { ref: "wood_pick", input: { count: 24 } }
Uina: mc run { code: "… 按蓝图放方块 …", input: { blueprint: "hut_7x5" } }
```

密林里发现半径 24 太慢，改一行：

```text
Uina: library update { name: "wood_pick", source: "…", addLesson: "密林用半径 12" }
```

同一个下午，它把三个阶段串成一个程序：

```js
// shelter.js
async function main(mc, input) {
  await mc.call("wood_pick", { count: 32 });
  await mc.call("craft_basic");
  return await mc.call("build_hut", { at: input.at });
}
```

再往后，遇到需要 tick 级控制的事（搭桥、战斗），它不写能力，也不改引擎，只写程序里的反馈循环（§3.7）。

### 0.2 终态清单

这些是本文要保证的可验收效果：

1. 一次运行后，一条命令把它存成程序；下次会话按名字直接调用。
2. 程序是单个 `.js` 文件，本身是合法 JavaScript（入口 `async function main(mc, input)`），放在固定目录里；没有清单、没有发布、没有版本号。
3. 程序里可以调用能力，也可以调用别的程序；没有 `import`。
4. 程序可以显式接管身体做 tick 级操作（`withBody` + `body.loop`），也可以只调用能力（能力自己处理身体）。
5. 失败能说清楚：哪一行、错误从哪一层来（事实）、已经发生了什么、建议下一步（明确标注为建议）。
6. 程序可以在中途把决定权交回（`decide`），下次从新段继续。
7. 多个程序并发时各自隔离，互不抢身体、互相拖不垮。
8. 死循环、内存爆炸、worker 崩溃都不会带走 Uina 的进程。
9. 改文件不影响正在跑的段；每一次程序调用都有当时的源码快照与摘要。
10. 模型要学的固定表面积只有一页（附录 A）；每个能力的具体参数用 `describe` 现取，不占着上下文。

### 0.3 本文不做

- 不做模块系统、不做 `import`/`require`、不做包管理器。
- 不做程序版本号、发布流水线、依赖图、绑定表。
- 不做第二套能力 API（不为每个能力生成方法）。
- 不做完成条件的 DSL 或完成校验子系统：程序默认只承诺"正常结束"。
- 不做全知世界模型、不做自动规划器；程序就是人（模型）写的普通 JS。

---

## 1. 裁决

| # | 裁决 | 放弃的方案与理由 |
|---|---|---|
| 1 | 程序是一个**合法 JS 文件**：元数据在头注释，入口是 `async function main(mc, input)` | "头注释 + 函数体片段"。后者不是合法 JS：编辑器、linter、模型的代码直觉全部失效，错误行号还要靠包装偏移纠正。 |
| 2 | 没有 `import`，复用只有两条路：`mc.call("名字")` 或复制源码再改 | ESM 模块、相对路径导入、依赖图。模块缓存、循环依赖、路径解析全是为了省一次调用，而调用本来就只是一行。 |
| 3 | 两个入口：`mc.call` 用于动作与程序（返回领域值），`mc.read` 用于查询（返回 `{value, version, unknown}`） | 单一 `mc.call` 返回裸值：`{block:null}` 无法区分空气、查询失败与区块未加载，而这三者在挖矿/建造里指向完全不同的动作。 |
| 4 | 有状态的东西是句柄（`body`、`window`、`stream`），无状态的东西是引用 | 全部用字符串引用，或全部用对象。句柄有生命周期、有方法、有所有权；能力是无状态的纯调用。两者混在一起才会出现 `mc.body()`、`mc.player`、`mc.world` 这种镜像对象树。 |
| 5 | 执行即快照：**每次程序调用**捕获确切字节，按内容寻址写到 `runs/<run>/sources/<sha256>.js` | 段级快照：一个段可以跑多个不同程序，一份文件无法对应三个调用，`save {from}` 也说不清保存哪个。版本号：快照比版本号更强，且不需要发布流程。 |
| 6 | 段内名字固定：某程序名第一次被解析后，本段后续同名调用复用它 | 每次调用重读文件。模型看到两次 `mc.call("wood_pick")` 会假设同一个实现；段内换实现只制造无从解释的行为差异。跨段仍看当前文件。 |
| 7 | 调用之间零共享：每次调用一个独立 QuickJS 运行时 | 段内长活 guest 全局、模块缓存、热重载。跨调用要保留的东西写世界或传参；否则并发、恢复、复现都会变糊涂。 |
| 8 | 身体租约属于段；把身体交给**另一个程序**必须显式 `body.call` 委托 | `mc.call` 隐式继承身体：独立的调用被自动升级成身体控制者，调用点看不出资源归属。 |
| 9 | 失败带 `source`（哪一层报的，事实）与 `hint`（建议，可能不准） | 单一 `blame`（责任归属）。`PATH_NOT_FOUND` 可能是地形、也可能是查询错、寻路缺陷或观察过期，Program 无从知道责任，只能知道自己从哪收到它。 |
| 10 | 库操作只有五件：`list/get/save/update/delete`，保存就是写文件 | search 评分、向量检索、质量认证、目录索引、发布事务。程序数量在几十到几百量级，文件系统就是索引。 |
| 11 | 引擎 = worker 线程 + 每次调用一个 QuickJS-WASM 运行时 | `node:vm`（没有内存上限、没有中断）与子进程（启动/运维重）。见附录 B 的实测。 |

每条裁决对应的接口细节在后续章节；第 6 节列出对既有文档的变更。

---

## 2. 程序模型

### 2.1 一个文件

```text
.uina/world-data/minecraft/programs/wood_pick.js
```

文件是普通 JavaScript 脚本（不是 ES 模块）：头部注释 + 顶层声明 + 入口函数。

```js
/**
 * @summary 砍够原木。附近需要有橡树；挖不到会停在 progress 里。
 * @tags 木, 开局
 * @input {"type":"object","properties":{"count":{"type":"integer","minimum":1},"radius":{"type":"integer"}}}
 * @lesson 密林里半径 24 会绕远，12 更快
 */
async function main(mc, input) {
  const want = input?.count ?? 8;
  let { value: inv } = await mc.read("inventory@1");
  let have = inv.counts.oak_log ?? 0;
  mc.progress({ summary: `原木 ${have}/${want}`, have, want });

  while (have < want) {
    const { value: found } = await mc.read("blocks@1", {
      name: "oak_log", radius: input?.radius ?? 12, limit: 8,
    });
    if (!found.blocks.length) throw new Error("附近没有橡树");
    await mc.call("mine@1", { block: found.blocks[0].position });
    ({ value: inv } = await mc.read("inventory@1"));
    have = inv.counts.oak_log ?? 0;
    mc.progress({ summary: `原木 ${have}/${want}`, have, want });
  }
  return { oak_log: have };
}
```

规则：

- 执行 = 求值整个脚本，然后调用全局 `main(mc, input)`；`main` 的返回值就是调用结果（可以是 promise）。
- 顶层只放声明（辅助函数、常量）。顶层没有 `await`，也不该有副作用；逻辑都在 `main` 里。
- 没有 `exports`、没有 wrapper、没有 ESM。文件名就是程序名。
- **行号即源码行号**：脚本被原样编译，没有包装前缀，`wood_pick.js:14` 就是第 14 行。这一条直接来自"文件是合法 JS"。

### 2.2 头注释

文件开头的第一个块注释（`/** … */`）是元数据。它是普通 JS 注释，不影响执行；格式由宿主工具写入与合并，模型不必手写。

| 字段 | 必需 | 含义 | 谁写 |
|---|---|---|---|
| `@summary` | 是（`save` 时强制） | 一句话：做什么、假定什么 | `save`/`update` 参数 |
| `@tags` | 否 | 逗号分隔，用于 `list` 过滤 | 同上 |
| `@input` | 否 | 一行 JSON Schema，调用前校验 | 同上 |
| `@lesson` | 否，可重复 | 踩过的坑，给下一次的自己看 | `addLesson` |
| `@saved` | 否 | 来源调用与保存时间，`{run,segment,call}` | `save` |
| 其他 | 否 | 忽略（向前兼容） | — |

规则：

- 解析：逐行 `@字段 值`，不以 `@` 开头的续行并入上一个字段；`@input` 的值按 JSON 解析。
- 没有头注释合法：程序照常可调用；`list` 里显示 `summary: null`。
- `save`/`update` 会剥掉源码里已有的头注释，再写回规范的一份（避免重复或半截元数据）。
- 头注释只影响可读性与 `@input` 校验，不影响执行：**执行只读脚本体**。
- 不用 XML / YAML：XML 里嵌 JSON Schema 要转义，YAML 要额外依赖或子集解析器；行式标签是 30 行解析、零依赖、与 JSDoc 习惯一致。

### 2.3 目录、命名与冲突

- 扫描 `programs/**/*.js`（递归，子目录只作人类整理，不参与身份）。
- 程序名 = 文件名去掉 `.js`，规则 `^[a-z][a-z0-9_-]{0,47}$`（小写；Windows 大小写不敏感）。
- 以 `.` 或 `_` 开头的文件忽略（临时文件、草稿）。
- 同名出现在多个目录 → `PROGRAM_CONFLICT`：两个都不可调用，`list` 里标出路径，让 Uina 自己删一个。
- 目录由既有 world 激活约定推导（`worldDataDir`：无 profile 时 `<cwd>/.uina/world-data/<worldName>`，有 profile 时 `<cwd>/profiles/<id>/state/world-data/<worldName>`），不配置、不写死绝对路径。同一数据根下还有 `blueprints/`、`experiences/`、`runs/`（源码快照）、`world-history.db`、`runtime.db`，各归其所有者，见 [概要 §8.2](../design.md)。

为什么不是"分类目录即命名空间"：那要么让名字变成 `combat/pvp`（地址里多一层分隔符、更多解析规则），要么允许重名（解析歧义）。分类用 `@tags` 表达，零成本。

### 2.4 地址与解析

| 选择子 | 例 | 含义 |
|---|---|---|
| 不含 `@` | `wood_pick` | 已保存程序，文件当前字节 |
| 含 `@` | `craft@1`、`block@1` | 能力的精确版本 |
| 其他 | `craft`、`a/b` | `SELECTOR_INVALID` + 最接近的候选（能力名与程序名一起给） |

两种语法不相交，因此没有遮蔽、没有回退、没有优先级。程序名也永远不会和能力名冲突。

解析在 Runtime 侧发生（它同时知道能力目录与 Program），`mc.call`/`mc.read` 只把选择子转上去。`SELECTOR_INVALID` 与 `PROGRAM_NOT_FOUND` 都带候选列表，避免模型靠猜。

### 2.5 没有导入

- 程序里没有 `import`、`require`、`export`；也没有文件、网络、环境变量——guest 里根本不存在这些对象。
- 复用程序的两条正当路径：**调用**（`mc.call("wood_pick", {...})`）与**复制改写**（`library.get` 拿到源码，改完 `library.update`）。后者是模型学习成本最低的路径，不需要先把程序参数化到完美。
- 不做 `require("./x.js")`：它会带来模块缓存、循环依赖、路径解析和"改了没生效"的困惑，收益只是省一次调用。
- 程序之间没有共享内存；要传状态就用 `input` 和返回值，要长期保存就写世界（箱子、蓝图）或存成程序。

### 2.6 每次调用一份源码快照

某个程序名第一次在段内被解析时：

1. 读文件一次（完整读取到内存，不从缓存拿）。
2. 算 `sha256`。
3. 写 `runs/<run>/sources/<hex>.js`：同摘要已存在则核对字节后复用，不存在则写临时文件再 `rename`。内容寻址，天然去重。
4. 返回 `{name, digest, snapshotPath}`，并**在段内固定**：本段后续同名调用复用这份字节，不再读文件。
5. 每次程序调用把自己的 `{digest, snapshotPath}` 写进**调用记录**（不是段记录）。

为什么是每次调用、而不是每个段：一个段可以依次跑 `wood_pick`、`craft_basic`、`build_hut`，三份源码各自独立；段级单文件无法对应，`library.save({from:{run,segment,call}})` 也说不清保存哪一个。内容寻址则让"同一次运行里同一份源码被用了几次"一眼可见（同摘要 = 同一个文件）。

段结束后，下一个段重新解析，拿到的是文件当前内容（§4.3）。

---

## 3. 编程面

### 3.1 能力阶梯

| 层 | 是什么 | 谁拥有 | 粒度 | 稳定性 |
|---|---|---|---|---|
| L0 客户端操作 | `body.drive/dig/attack/…` | Driver | 一 tick / 一个动作 | 引擎合同，随引擎版本 |
| L1 能力引用 | `craft@1`、`mine@1`、`inventory@1` | Driver / World 模块 | 一个领域目标 | `@major` 版本化 |
| L2 程序 | `wood_pick` | Uina（本文） | 一个可复用流程 | 编辑即最新 |
| L3 任务 | run | Runtime | 一次请求 | — |

规则只有三条：

- 上层可以使用下层的全部：程序可以调用能力、可以掉到 L0、可以调用程序。
- 原生能力自己处理身体：`mine@1` 内部借身体、挖、还；程序不需要为它 `withBody`。
- 只有需要 tick 级控制时，程序才显式接管身体。

这三条让"简单的事一句话，复杂的事不掉能力"同时成立。

### 3.2 `mc` 表面：两个入口，一条判据

程序里能用的全部宿主入口只有七个方法加 `console`：

| API | 签名 | 说明 |
|---|---|---|
| `mc.call` | `(selector, input?) => Promise<Json>` | 动作与程序。返回领域值；失败抛 `Error`（带 `code`/`source`/`hint`/`dispatch`/`effects`/`progress`） |
| `mc.read` | `(selector, input?) => Promise<{value, version, unknown?}>` | 查询能力。`version` 是不透明令牌，`unknown` 只在有未知时出现（如 `["chunk_unloaded"]`） |
| `mc.waitForChange` | `(targets, predicate, opts?) => Promise<{kind: "satisfied" \| "timeout", values, version}>` | 现在不满足就等：读一次 → 判定 → 等到观察版本变化 → 重读重判，直到 `afterMs` |
| `mc.sleep` | `(ms) => Promise<void>` | 可取消的等待 |
| `mc.progress` | `(value: Json) => void` | 覆盖式进度；有 `summary` 字符串时作为一行摘要 |
| `mc.decide` | `({reason, checkpoint?}) => Promise<never>` | 交还整个段（§5.4） |
| `mc.withBody` | `(work: (body) => Promise<T>) => Promise<T>` | 借用身体；退出即释放 |
| `console` | `log/info/warn/error` | 进调用控制台缓冲，失败时回传尾部 |

**判据是一句话：名词用 `mc.read`，动词用 `mc.call`。** 用错了是明确错误，不是静默降级：`mc.call("block@1")` → `USE_MC_READ`，`mc.read("mine@1")` → `USE_MC_CALL`。

为什么要分开：`{block: null}` 同时可能是"那里是空气"、"区块没加载"、"查询不到"。挖矿、放置、寻路对这三种的回答完全不同（换个方块挖 vs 等加载 vs 报错）。世界查询天然带版本与未知语义，把它压成裸值就是丢信息；而动作的返回值是领域结果，没有这层语义。所以不是"两个 API 长得很像"，是**两类事实的形状本来就不同**。

**为什么不做 SDK。** 类型化方法（`mc.craft({item,count})`）看起来更贴近 JS 习惯，但它把"有哪些能力"从数据变成了代码：

| | `call` / `read` | SDK |
|---|---|---|
| 新增一个能力 | 目录里加一条，指南 **0 行**改动 | 加一个方法 + 参数说明 + 错误说明，指南 +3～6 行 |
| 能力改参数 | 改目录条目 | 改方法签名 + 指南 |
| 模型怎么知道有什么 | `describe` 按需查询 | 只能靠上下文里的完整方法表 |
| 程序名（动态）与能力名（静态） | 同一个命名空间，同一个入口 | 两套：方法 vs 字符串 |
| 与目录的一致性 | 只有一份真相 | SDK 与目录可能版本漂移 |

需要承认的是：**固定入口并不能免除每个能力的领域知识**。`craft@1` 的 `item` 是什么、`count` 怎么算、缺材料报什么，无论有没有 SDK 都得讲。所以"学得舒服"的关键不在入口形态，而在两件事：

1. 固定表面积小：一条判据（名词 read / 动词 call）+ 一条元规则（不知道就先 `describe`），附录 A 一页。
2. 每个能力的说明**可直接拿去编程**：`describe` 返回输入 schema、输出形状、完成口径、错误码、前置条件，以及一段可复制的 `await mc.call(...)` 示例（§3.4）。领域知识按需现取，一次只看一两个能力。

SDK 唯一真正的优势——"参数补全与类型"——在这里换不来什么：模型不是靠 IDE 补全写代码，而是靠读一段准确的说明。

**SDK 形状该出现的地方是句柄**，因为那里有生命周期和所有权：`body`、`window`、`stream` 是对象，有方法，有失效条件。这两个世界不要混。

### 3.3 `body` 表面

```js
await mc.withBody(async (body) => { … });   // 退出即释放；嵌套的 withBody 加入同一租约
```

| | 签名 | 说明 |
|---|---|---|
| `body.call` | `(selector, input?) => Promise<Json>` | **委托身体**调用另一个程序（§3.3.1） |
| `body.drive` | `(input: ControlInput, opts?: {ticks?: number}) => Promise<void>` | 原样下发控制；`ticks` 省略时为单 tick |
| `body.dig` | `(position: Vec3, opts?: {aim?: "target" \| "preserve"}) => Promise<void>` | 挖指定方块 |
| `body.attack` | `(target: EntityRef) => Promise<void>` | 攻击一次 |
| `body.useItem` | `(opts?: {hand?: "main" \| "off"}) => Promise<void>` | 使用当前物品 |
| `body.endUse` | `() => Promise<void>` | 结束持续使用（弓、进食） |
| `body.interact` | `(target: {position} \| EntityRef, opts?) => Promise<EffectReceipt>` | 右键交互（门、按钮、村民、容器） |
| `body.equip` | `(item: ItemSelector, hand?) => Promise<void>` | 装备/切换到手持 |
| `body.openContainer` | `(target) => Promise<Window>` | 打开容器，返回窗口句柄 |
| `body.lookAt` | `(target: {position} \| EntityRef) => Promise<void>` | 转向目标（角度换算在 Driver 内） |
| `body.feedback` | `(sensors: Sensors) => Promise<Stream>` | 手动反馈循环：`stream.next()` / `stream.apply(input)` |
| `body.loop` | `(step: (frame) => ControlInput \| {done:true}, sensors?: Sensors) => Promise<void>` | 本地闭环；`step` 必须同步；`frame.self` 恒有，`sensors` 补查询 |

`ControlInput`：

```js
{
  keys?: { forward?, back?, left?, right?, jump?, sprint?, sneak? },   // 布尔
  look?: { yaw, pitch },        // 弧度；除非要精确控制，优先用 lookAt
  lookAt?: { position } | EntityRef,
  use?: { mode: "hold" | "once", hand: "main" | "off" },
  attack?: EntityRef
}
```

`lookAt` 是新增的糖：yaw/pitch 的符号与基准角是写 MC 代码最容易错的地方（模型也常错），把这个换算放进 Driver，程序永远不碰角度。`look` 保留给确实要精确控制的场合。

`Window`：`snapshot()` / `click({slot, button, mode, expectedRevision?})` / `close()`。窗口只在 `withBody` 内有效；退出 body 会自动关闭未关的窗口。

`Stream`（`body.feedback` 返回）：`next()` / `apply(input)` / `close()`。`body.loop` 是它的语法糖，覆盖 95% 的用法。

#### 3.3.1 身体租约与委托

- **租约属于段**。`mc.withBody` 取得它，回调结束释放；同一段里嵌套的 `withBody` 加入同一租约，不重复申请。
- **另一个程序是另一个调用**。`mc.call("x")` 不会把身体交给它：如果 `x` 里调 `mc.withBody` 而调用方正持着租约，它得到 `BODY_NOT_DELEGATED`，提示是"调用方用 `body.call` 委托"。
- **显式委托**：`body.call("x", input)` 把当前租约交给这次调用；`x` 里的 `mc.withBody` 直接拿到同一个 `body`（不重新 acquire），托管到这次调用返回为止。父调用在等它，所以不存在两个程序同时驱动身体。
- **原生能力不是"另一个程序"**：`mine@1`、`craft@1` 就是身体的接口，在段当前租约内直接借还，不需要委托。否则 `withBody` 里调任何能力都要写一遍委托，纯噪音。
- **不会互等**：段内所有调用（程序调程序、程序调原生、原生调程序）复用同一个执行域，不再申请容量（§5.2）。同一个域里可以同时有多个挂起的 guest：`P` 在等原生 `N` 的回复时挂起，`N` 又调用程序 `Q`，`Q` 就在同一个 worker 里新建一个运行时跑——worker 在等宿主回复时让出执行权，所以 `P → Native → Q` 不会因为"单线程"而死锁，也不会互相等待。唯一的例外是 `Q` 的同步循环占满 worker，那由中断与预算（§5.3）覆盖，不是死锁。持身体时第一次开域只尝试、不排队，满了立即 `PROGRAM_CAPACITY`。

### 3.4 能力目录与发现

能力的实现归 Driver/World 模块；这里固定**命名、语义与完成口径**，作为程序可依赖的契约与示例的依据。清单本身由工具动作 `mc describe` 按需查询（不在程序里查），所以下面的表是契约，不是要背下来的 API 表。查询是名词，动作是动词，多段用 `.`：`<domain>[.<verb>]@<major>`。

查询（`access: "read"`，不产生副作用，用 `mc.read`）：

| ref | 输入 | `value` | 说明 |
|---|---|---|---|
| `self@1` | `{}` | `{place, health, food, onGround, velocity, held}` | 自身状态 |
| `inventory@1` | `{}` | `{slots, counts, freeSlots, held}` | 背包快照；`counts` 按物品名聚合 |
| `block@1` | `{at}` 或 `{below?}` | `{block: {name, position, properties} \| null}` | 单方块；`null` 的语义由 `unknown` 补齐 |
| `blocks@1` | `{name?, radius, limit?}` | `{blocks: [{position, name}], truncated}` | 范围内搜索，按距离排序 |
| `entities@1` | `{kind?, radius, limit?}` | `{entities: [{ref, kind, name, position, health?}]}` | 附近实体 |
| `world@1` | `{}` | `{dimension, timeOfDay, weather, gameMode}` | 世界事实 |
| `blueprint@1` | `{name, at?}` | `{cells: [{position, block}], size}` | 已存蓝图；给了 `at` 就返回绝对坐标 |

动作（`access: "act"`，自带身体，用 `mc.call`）：

| ref | 输入 | 完成口径 | 常见错误 |
|---|---|---|---|
| `move.to@1` | `{position, tolerance?}` | 到达容差内 | `PATH_NOT_FOUND`、`TIMEOUT` |
| `mine@1` | `{block}` | 方块消失、掉落物入包 | `OUT_OF_REACH`、`INVENTORY_FULL`、`UNBREAKABLE` |
| `place@1` | `{block, at, face?}` | 该位置变成目标方块 | `NO_MATERIAL`、`OBSTRUCTED`、`OUT_OF_REACH` |
| `craft@1` | `{item, count}` | 背包里数量达标 | `MISSING_MATERIALS`、`NO_TABLE`、`RECIPE_UNKNOWN` |
| `smelt@1` | `{item, count, fuel?}` | 产物入包 | `NO_FURNACE`、`NO_FUEL` |
| `attack@1` | `{target}` | 目标消失或本次攻击生效 | `TARGET_GONE`、`OUT_OF_REACH` |
| `use@1` | `{item?, target?}` | 使用动作被服务端确认 | `NOT_USABLE` |
| `equip@1` | `{item, hand?}` | 手持为目标物品 | `NOT_FOUND` |
| `interact@1` | `{target}` | 交互被确认 | `NO_INTERACTION` |
| `say@1` | `{text}` | 已发送 | `NOT_CONNECTED` |

约定：

- `mc.read` 的 `version` 由宿主生成、程序原样回传，不解释；`unknown` 是短原因列表（`chunk_unloaded`、`not_connected`、`stale` 等），没有未知就不出现。`value` 本身不表达未知——这正是两个入口分开的理由。
- 每个能力声明 `completion.scope`（`execution` / `capability` / `goal`）：`say@1` 是 execution，`mine@1`/`craft@1` 是 capability。**程序默认 `execution`**：正常返回只承诺"执行完了"，不承诺"目标达成"。
- 失败里 `dispatch` 与 `effects` 由 Runtime 填；`source` 由报错的那一层决定；`hint` 是建议。
- 能力不得要求程序先借身体；需要身体的内部自己借。这样 `mine@1` 与 `body.dig` 是两个层次，不互相重复。

**发现：`describe` 的输出必须能直接拿去写代码。** 这是"模型学得舒服"的真正着力点，不是入口形态。

```text
mc describe { query: "合成" }
→ [ { ref: "craft@1", summary: "用背包已有材料合成，必要时用附近工作台", tags: ["合成","开局"] },
    { ref: "smelt@1", summary: "熔炼矿物与食物", tags: ["合成","炉"] } ]

mc describe { ref: "craft@1" }
→ access: act
  用途：用背包已有材料合成，必要时自动使用附近工作台。
  输入：{ item: string; count: integer ≥ 1 }
  输出：{ crafted: integer, leftover: { [item]: integer } }
  完成：背包里 item 数量达到 count（capability 口径）
  前置：需要配方已知；count > 1 时需要材料足够
  错误：MISSING_MATERIALS（缺材料）· NO_TABLE（附近无工作台）· RECIPE_UNKNOWN（没有这个配方）
  示例：
    const r = await mc.call("craft@1", { item: "stick", count: 4 });
```

规则：

- `query` 按名字、摘要、标签做子串匹配，返回 5–10 条候选（带 `tags`），不建向量检索、不建语义排序。模型先看候选、再 `describe` 精确项。
- 候选与详情都来自同一份 descriptor；描述文本由能力作者写，只要求"用途 / 输入 / 输出 / 完成 / 错误 / 示例"六项齐全，不要求长文。
- 示例必须是可复制的完整调用语句（含 `await`），不是伪代码。模型抄它就能跑。

### 3.5 五种写法

所有复杂行为都是这五种写法的组合：

**1. 读 → 判断 → 做**

```js
const { value: here, unknown } = await mc.read("block@1", { at: input.target });
if (unknown?.length) return { reason: "地形没看清", unknown };   // 别把 null 当空气
if (here.block?.name !== "water") {
  await mc.call("place@1", { block: "oak_planks", at: input.target });
}
```

**2. 反馈循环**（tick 级控制，不能用能力表达时）

```js
await mc.withBody(async (body) => {
  await body.loop((f) => {
    const p = f.self.value.place.position;
    if (Math.hypot(input.to.x - p.x, input.to.z - p.z) < 1.5) return { done: true };
    return { keys: { forward: true }, lookAt: input.to, use: { mode: "hold", hand: "main" } };
  }, { self: { ref: "self@1", input: {} } });
});
```

**3. 等待**

```js
// 等背包里出现 8 个原木：现在就满足就立即返回，不满足就等观察版本变化
const r = await mc.waitForChange(
  { inv: { ref: "inventory@1" } },
  (s) => (s.inv.counts.oak_log ?? 0) >= 8,
  { afterMs: 5000 },
);
if (r.kind === "timeout") return { reason: `只等到 ${r.values.inv.counts.oak_log ?? 0} 个` };
return r.values.inv;
```

判定函数在 guest 里；"先满足"与"稍后满足"是同一条路径。无漏唤醒由宿主保证：`mc.read` 返回的 `version` 是这次读取的观察位置，等待时先比对当前位置——已经变了就立刻重读，没变才订阅，而订阅从那个位置之后的变化不会再丢（§5.5）。程序不需要碰游标。

**4. 重试与降级**（失败后换策略，而不是原样重来）

```js
try {
  await mc.call("move.to@1", { position: input.target });
} catch (e) {
  if (e.code !== "PATH_NOT_FOUND") throw e;
  await mc.call("move.to@1", { position: input.fallback });
}
```

**5. 交还决策**

```js
const { value: inv } = await mc.read("inventory@1");
if (inv.freeSlots <= 2) {
  await mc.decide({ reason: `背包只剩 ${inv.freeSlots} 格`, checkpoint: { at: lastPos } });
}
```

### 3.6 失败：哪一层报的、发生了什么、建议什么

程序里的 `throw` 和 `mc.call`/`mc.read` 的失败都会变成同一种错误对象：

```js
{
  name: "CallError", code: "MISSING_MATERIALS", source: "world",
  message: "craft@1 缺少 4 个 oak_planks（背包有 2）",
  dispatch: "not_sent", effects: [], progress: { have: 2, want: 4 },
  recoverable: true, hint: "先 mine@1 或 craft@1 取得 oak_planks，再重试"
}
```

`source` 表示**错误从哪一层报出来**（事实），不是责任判定：

| source | 含义 | 模型通常该做的事 |
|---|---|---|
| `program` | Program 自己（语法、类型、越界、死循环、内存、值不合法） | 改代码 |
| `capability` | 能力实现自己报的（内部错误、协议错、超时） | 换能力或报告；同一调用重试通常无用 |
| `world` | 能力依据世界状态拒绝（没材料、路不通、目标消失、背包满） | 改变世界状态后重试 |
| `input` | 参数不合法（缺字段、类型错、越界、选择子解析不到） | 改参数或先 `list`/`describe` |
| `environment` | 连接、进程、容量、资源上限 | 停下并报告，或等资源后重试 |

`hint` 是**建议**，由 `code` + `source` 查表生成，可能不准。宁可写"可能"也不要把猜测包装成结论：`PATH_NOT_FOUND` 的 `source` 是 `capability`（能力报的），但世界是否真的不可达、寻路算法是否有缺陷、观察是否过期，Program 无从知道，所以它只给"换个位置试 / 检查目标是否可达"，不给"世界不可达"这种判决。

**给模型看的失败文本**（`run` 的返回值，也是 `runs` 里能读到的）：

```text
✗ wood_pick · 第 14 行 · 程序错误（来自 console/代码）
  TypeError: Cannot read properties of undefined (reading 'counts')
  at wood_pick.js:14
  之前：mine@1 成功 3 次（oak_log ×3）；progress { have: 3, want: 8 }
  建议：第 14 行读的是 mc.read("inventory@1") 的返回值，检查是否取了 .value
```

失败文本的三个要素：**定位**（行号 + 栈）、**现场**（已生效的效果与进度）、**下一步**（建议，明确是建议）。不生成长篇分析，一句话足够模型决定改代码还是改环境。

### 3.7 示例集

**A. 采集（已有，§2.1）**——读 → 判断 → 做 → 进度。

**B. 合成（依赖顺序）**

```js
async function ensure(mc, item, count) {
  const { value: inv } = await mc.read("inventory@1");
  if ((inv.counts[item] ?? 0) >= count) return;
  await mc.call("craft@1", { item, count });
}
async function main(mc, input) {
  await ensure(mc, "oak_planks", 8);        // 工作台 4 + 木棍 2 + 镐 3，留 1 冗余
  await ensure(mc, "crafting_table", 1);
  await ensure(mc, "stick", 4);
  await ensure(mc, "wooden_pickaxe", 1);
  return "ok";
}
```

依赖顺序由脚本表达，不由能力猜测——这是"程序是组合语言"的具体含义。

**C. 搭桥（tick 级控制）**

```js
async function main(mc, input) {
  await mc.withBody(async (body) => {
    await body.loop((f) => {
      const p = f.self.value.place.position;
      if (p.y < input.keepAbove) return { done: true };            // 掉下去了，停
      if (Math.hypot(input.to.x - p.x, input.to.z - p.z) < 1.0) return { done: true };
      if (f.sensors.under.value.block) return { keys: { forward: true }, lookAt: input.to };
      return { keys: { forward: true }, lookAt: { position: { x: p.x, y: p.y - 1, z: p.z } },
               use: { mode: "once", hand: "main" } };
    }, { under: { ref: "block@1", input: { below: 1 } }, self: { ref: "self@1", input: {} } });
  });
}
```

**D. 按蓝图建造**

```js
async function main(mc, input) {
  const { value: bp } = await mc.read("blueprint@1", { name: input.blueprint, at: input.origin });
  let placed = 0;
  for (const cell of bp.cells) {
    const { value: here, unknown } = await mc.read("block@1", { at: cell.position });
    if (unknown?.includes("chunk_unloaded")) { await mc.sleep(50); continue; }
    if (here.block?.name === cell.block) continue;
    await mc.call("place@1", { block: cell.block, at: cell.position });
    if (++placed % 10 === 0) mc.progress({ summary: `已放 ${placed}/${bp.cells.length}`, placed });
  }
  return { placed, total: bp.cells.length };
}
```

**E. 战斗（反馈 + 撤退）**

```js
async function main(mc, input) {
  await mc.withBody(async (body) => {
    await body.loop((f) => {
      const me = f.self.value;
      const target = f.sensors.near.value.entities[0];
      if (!target) return { done: true };
      if (me.health < 8) return { done: true };                   // 撤退判断留在程序里
      return { keys: { forward: true }, lookAt: target.ref, attack: target.ref };
    }, { self: { ref: "self@1", input: {} },
         near: { ref: "entities@1", input: { kind: "hostile", radius: 6, limit: 1 } } });
  });
}
```

**F. 容器整理**

```js
async function main(mc, input) {
  await mc.withBody(async (body) => {
    const win = await body.openContainer(input.chest);
    const snap = await win.snapshot();
    const mine = new Set(snap.regions.find((r) => r.name === "player").slots);
    for (const slot of snap.slots) {
      if (slot.item?.name === "cobblestone" && mine.has(slot.slot)) {
        await win.click({ slot: slot.slot, button: 0, mode: "quick_move" });
      }
    }
  });
}
```

槽位带 `region`（`player`/`container`）与所属区域列表，程序不必自己数索引；`mode` 的取值归 driver §12。

**G. 长任务交还（探矿）**

```js
async function main(mc, input) {
  let last = null;
  for (;;) {
    const { value: inv } = await mc.read("inventory@1");
    if (inv.freeSlots <= 2) {
      await mc.decide({ reason: `背包只剩 ${inv.freeSlots} 格`, checkpoint: { at: last, ore: inv.counts } });
    }
    const { value: found } = await mc.read("blocks@1", { name: "iron_ore", radius: 16, limit: 1 });
    if (!found.blocks.length) {
      await mc.decide({ reason: "附近没有铁矿了", checkpoint: { at: last } });
    }
    last = found.blocks[0].position;
    await mc.call("mine@1", { block: last });
  }
}
```

这七个例子覆盖了 MC 里绝大部分需要程序的事：采集、合成、移动、建造、战斗、容器、长任务。它们的共同点是没有一个需要新机制。

---

## 4. 学习循环：库

### 4.1 五个操作

`library` 是 `mc` 工具的一个 action，`kind` 缺省为 `"program"`；三类条目（program / blueprint / experience）共用这套动词，蓝图与经验的细节见 [Library §5](assets.md)。以下请求省略 `kind`：

| op | 请求 | 返回 |
|---|---|---|
| `list` | `{kind?, text?, tag?, limit?}` | `[{kind, name, summary, tags, updatedAt, size?, digest?, path?, aboutError?}]` |
| `get` | `{kind?, name}` | program → `{name, source, summary, tags, lessons, path, digest, savedFrom?, updatedAt}`；其余见 Library §5 |
| `save` | `{name, summary, tags?, input?, from?: {run, segment, call}, source?}` | `ProgramSummary` |
| `update` | `{name, source?, summary?, tags?, addLesson?, removeLesson?, expectedDigest?}` | `ProgramSummary` |
| `delete` | `{name}` | `{name, deleted: true}` |

- `save` 只创建；已存在 → `NAME_EXISTS`，提示用 `update`。这样一次陈旧的运行不会静默换掉正在用的文件。
- `update` 是唯一的修改入口：改源码、改摘要、加 lesson 都在这里；`source` 缺省表示只改元数据。
- `update` 支持 `expectedDigest`：与文件当前摘要不符 → `DIGEST_CONFLICT`，不覆盖。这是普通文件编辑的乐观并发控制（多个运行与用户自己都可能改同一份文件），不是发布 CAS。
- `delete` 硬删除文件；`runs/` 里的快照保留（历史仍可读）。
- `list` 只做大小写不敏感的子串 + 标签过滤，按 `updatedAt` 倒序，默认 50 条。没有评分、没有向量检索："哪个程序真的能用"由运行记录聚合回答，库不维护第二份统计。
- 库自己的错误（不产生段失败）：`NAME_EXISTS`、`NOT_FOUND`、`NAME_INVALID`、`HEADER_INVALID`（`@input` 不是合法 JSON Schema）、`DIGEST_CONFLICT`、`IO_ERROR`。它们直接回给 Uina，不进 `ProgramFailure`。

### 4.2 保存时工具做什么

`save` 收到 `{name, summary, from:{run,segment,call}}` 后：

1. 校验名字、`summary` 非空、长度上限。
2. 由调用记录找到那次调用的源码摘要，从 `runs/<run>/sources/<hex>.js` 读**当时执行的字节**（不是重读工作文件）。
3. 剥掉源码里已有的头注释，按参数生成新的头注释（`summary`、`tags`、`input`；`from` 转成一行 `@saved` 附注）。
4. 写临时文件 → `rename`（单文件，原子）。

`update` 做同样的规范化：保留未在参数里出现的旧字段，追加新的 `@lesson`，重写头注释。**模型永远不需要写头注释语法**——它只提供字段。

保存就是写一个文件。除了头注释规范化（模型不该手写元数据语法）与原子写，没有候选、没有审批、没有发布记录。

### 4.3 修改与正在跑的段

- 段内**第一次**解析某程序名时固定字节；本段后续同名调用复用同一份，即便磁盘文件已经改了。
- 下一个段重新解析，看到的是当前文件。
- 想在一次执行中途用新版：开新段（`decide` / 重新 `run`），或复制成新名字。
- 为什么固定：模型看到两次 `mc.call("wood_pick")` 会假设同一个实现。固定只在段内，不引入版本系统，也不需要发布。

### 4.4 发现

`list` 返回摘要，`get` 返回源码。模型学一个程序的路径是：**调用**（输入契约对得上）或**读源码改写**（世界不同）。后者不需要先把程序参数化到完美，是学习成本最低的复用。

### 4.5 质量从哪来

不靠认证，靠四件事：

1. `@summary` 说清假定（"附近需要有橡树"），`save` 时强制。
2. `@lesson` 记录踩过的坑，`update` 追加。
3. 失败信息足够精确（行号、栈、来源、已生效效果、建议）。
4. 程序在末尾自己 `mc.read` 校验关键结果并 `throw`——它的价值是**让失败更早、更清楚**，不是给 Runtime 提供完成证明。

完成口径固定为三层，不混：

- 程序默认 `completion.scope = execution`：正常返回只说明"执行完了"。它自己的校验只是它自己的判断。
- 原生能力声明自己的口径（`capability`/`goal`），由实现负责。
- Runtime 记录 `effects` 与对应证据；"目标是否达成"由主脑依据观察与记录判断，不由程序的返回值冒充。

### 4.6 为什么没有版本号

版本号服务三件事：复现旧行为（快照给的是确切字节，更强）、并行维护变体（复制文件改名，模型本来就会）、依赖不漂移（段内固定 + 调用记录里的摘要已经足够）。代价是发布仪式、两份源码、冲突处理——收益不成立。所以 `save` 不是发布，`update` 不是新版本，`delete` 就是删文件，没有"当前发布版本"这个概念。

---

## 5. 执行域

### 5.1 结构

```text
Runtime ── ProgramPort ──┬── 库（programs/ 扫描、读写、头注释）
                         └── 域（每个活动段一个 worker）
                               └── guest（每次调用一个 QuickJS 运行时）
```

一个域 = 一个 worker 线程 + 该段在册的调用。worker 只做三件事：消息泵、每个调用一个 QuickJS 运行时、把宿主返回值塞回 guest。

选 QuickJS + worker 的依据是实测而非偏好（附录 B）：

- **同步死循环**：QuickJS 的 `setInterruptHandler` 能只打断一次调用（37ms），`node:vm` 只能终止整个 worker，兄弟调用一起死。
- **内存上限**：QuickJS 的 `setMemoryLimit` 产生可捕获的 `InternalError: out of memory`，运行时随后仍可用；`node:vm` 在 worker 堆上限被击穿时**整个进程 abort**。
- **Node 环境**：QuickJS 里 `process`/`require`/`fetch`/`WebAssembly` 根本不存在，动态 `import()` 永不结算；`node:vm` 里这些是"没注入"，靠逃逸防护。

worker 保留的唯一理由是：guest 的同步计算不得占用 Driver/Runtime 的事件循环（`runtime.md` §9 的硬要求）。主线程只做消息收发。

worker 开在 world 伴生进程内，不为段另起子进程：隔离靠 QuickJS 的内存上限与中断，不靠 OS 进程边界（段子进程的启动、回收与孤儿风险换不来额外保证，见附录 B 的内存实测）。

### 5.2 生命周期与容量

```text
closed ──open──► queued ──准入──► active ──retire──► retiring ──► retired
                                                            └── 证明失败 ──► unknown
active ──worker 崩溃──► dead（容量立即释放，段失败）
```

- **准入时机**：段内第一次需要 program 执行时。顶层程序段在入场；原生段在第一次调用程序时（惰性）。
- **排队规则**（决定段能否等待容量）：
  - 段当前**不持**身体租约 → 可以排队：满了进 `queued`，`runs` 看得见，取消随时可做。
  - 段当前**持有**身体租约 → 只尝试，不排队：满了立即 `PROGRAM_CAPACITY`（`source: environment`），段失败并释放身体。
  理由：持着身体排队，可能和"别人正等这个身体"形成互等。这不是防御性设计，是消除死锁的必要规则（§3.3.1 的 `P → Native → Q` 就是这条规则的实例）。
- **粒度是段**：段内新调用、程序调程序，都复用本域，不再准入。
- **上限**：`program.maxDomains`，默认 4（每域 RSS 约 60MB 量级）。
- **可见性**：`capacity()` 返回实时观察值 `{observedAt, limit, occupied, queued, entries[{run,segment,state,requestedAt,activeAt?}]}`，`runs` 状态直接用它显示"排队中/执行中"。
- **崩溃**：worker 死 → 在册调用全部 `PROGRAM_CRASH`（source=environment），容量释放，段失败；下一次运行由新段重新 `open`。

### 5.3 预算

| 名称 | 默认 | 触发后 | 理由 |
|---|---|---|---|
| `guestMemoryBytes` | 64 MiB | 该调用 `PROGRAM_MEMORY`（call 级） | QuickJS 硬上限，干净失败 |
| `computeBurstMs` | 5000 | 该调用 `PROGRAM_TIMEOUT` | 从入场或上一次宿主 RPC 边界起算的连续解释时间；有 RPC 即重置，"循环里读世界"的长程序不会被误杀 |
| `maxSourceBytes` | 64 KiB | `PROGRAM_INVALID` | 源码是模型写的，超过这个量级通常是循环生成 |
| `maxValueBytes` | 1 MiB | `PROGRAM_VALUE` | input / 返回值 / 单个 RPC 参数的 JSON 上限 |
| `consoleBytes` | 16 KiB | 截断并标记 | 控制台环形缓冲，保留最后一段 |
| `maxCallDepth` | 8 | `PROGRAM_DEPTH` | 程序调程序的上限 |
| `retireGraceMs` | 1000 | 记 `unknown` | terminate 后等 `exit` 的证明窗口 |

预算在域内强制（QuickJS 上限 + 中断回调 + 每次 RPC 的字节检查），不依赖 guest 配合。取消标志与起算时间放在 `SharedArrayBuffer` 上：主线程用 `Atomics.store` 写，worker 里 QuickJS 的中断回调用 `Atomics.load` 读——**guest 在同步死循环时 worker 的事件循环是停的，任何"发消息让 worker 取消"的做法都不成立**，只有共享内存 + 中断回调能打断它。

**空闲调用不设墙钟超时**：程序 `await` 一个永不结算的 promise（例如 `import("node:fs")`，或等一个很久的世界变化）时既不占 CPU 也不占内存，此时没有任何预算该触发。这类调用停在 idle：`runs` 显示 `idleMs` 与最后一条进度，由主脑判断是不是卡死，决定是否 `stop`。不自动杀，是因为合法程序也会有数分钟的静默等待（长距离移动、炼炉、等夜晚）。

### 5.4 取消、decide、退役

**取消**（Run stop、段关闭、父调用失败）四步，目标 < 50ms：

1. Runtime 关闭调用范围（拒绝新 RPC）并 abort `signal`。
2. Program 停止派发新 RPC，丢弃已派出 RPC 的迟到回执。
3. 主线程置该调用的中断标志（`Atomics.store`）：正在同步执行的，QuickJS 中断回调立刻结束它；停在等 RPC 的，直接 `dispose` 它的运行时、永不恢复。两者都**不等 guest 收尾**（`catch`/`finally` 可能不跑，这是设计选择：退出不依赖 guest 合作）。只有整个域退役、或标志 50ms 未生效时才 `terminate()` worker——那会连同该域其它在册调用一起取消，所以它是域级手段，不是取消一个调用的默认路径。
4. 该调用立即以 `CANCELLED` 结算。

**decide**（`mc.decide({reason, checkpoint})`）从任何子调用交还整个段：

1. 该 RPC 与其他 RPC 同路径转给 Runtime。
2. Runtime：封闭段准入 → 取消兄弟调用 → 固定可序列化 checkpoint → 撤销控制 → 记录 decision → 要求 Program 退役该段。
3. Program `retire("decide")`：拒绝新调用、在册调用全部 `CANCELLED`、`terminate` worker、等 `exit`。
4. `decide` 的 promise 永不结算；段进 `awaiting_decision`，等 `runs continue` 开新段。

**退役**返回可核验的事实：

```ts
type ProgramRetirement =
  | { state: "retired"; stoppedAt: string }
  | { state: "unknown"; detail: string };
```

`terminate()` 后等到 `exit` 才 `retired`；`retireGraceMs` 内没等到 → `unknown`，容量**不释放**，域上报 Executor 隔离，Run 不得报 `succeeded`（沿用 `runtime.md` §11）。

### 5.5 值边界、观察版本与错误重建

- 只允许 JSON：`null | boolean | finite number | string | array | plain object`。`undefined` 按 JSON 语义（对象属性省略、数组转 `null`）；函数、symbol、`bigint`、非有限数、循环引用 → `PROGRAM_VALUE`。
- 单值上限 `maxValueBytes`；超限是失败，不是截断。
- 宿主错误进 guest 时必须是 guest 的 `Error`（`instanceof Error` 为真），字段 `code/source/hint/dispatch/effects/progress/recoverable/data` 挂上去，程序可以直接 `catch (e) { if (e.code === …) }`。
- guest 错误出宿主时：`{name, message, stack, line, column}`，栈只保留 `<name>.js` 与 `__shim` 帧，最多 10 帧。**行号映射：脚本原样编译，guest 行号就是源码行号**，没有偏移；`main` 内的帧统一标成 `<name>.js`。
- 宿主进入 guest 只有一个入口：调用它的 `__resolve(id, payload)`，随后 `executePendingJobs()` 把微任务跑到下一次 `await` 或结束；guest 出来也只有一个出口：同步导出的 `__post(method, argsJson)`。这套"同步出口 + promise 表 + 泵"是实测可行的最小桥（两次 RPC、三轮结算、1ms）。
- 微任务死循环（`while(1) await Promise.resolve()`）由同一个预算与中断覆盖：泵每轮检查已用时间与取消标志，超限即中断——否则 worker 会被烧满而不报错。

**观察版本与无漏唤醒**（`mc.read` / `mc.waitForChange` 的合同）：

- `version` 是宿主生成的不透明令牌，内容是这组目标各自的观察位置：World 目标用该次读取对应的世界游标（`ObservationCursor`），事实类目标（`self@1`/`inventory@1`）用产生该值的反馈帧 `sequence`。程序不解释它，只回传。
- 宿主的 `watch(targets, since)` 先比对**当前**位置与 `since`：任一不同，立即做一次新的读取并返回 `changed`；全部相同才订阅。订阅后再有任何变化都会唤醒（World 的 `read → watch` 原子比较合同，`contracts/world.ts` 的 `watch(query, after, signal)`）。
- 因此"读到旧值 → 条件不满足 → 订阅"之间不存在丢失窗口：变化要么让 `since` 立刻变旧（下次比对发现），要么在订阅之后被送达。
- 多目标：宿主为每个目标各自维护位置，任一变化即唤醒，返回整组新值。

### 5.6 反馈时延

一帧的路径：客户端 tick → Driver 采样 → `stream.next` → 主线程 → worker → QuickJS JSON 解析 → `step(frame)` → `stream.apply` → Driver。

| 环节 | 实测/预算 |
|---|---|
| 主线程 ↔ worker 往返 | p50 0.03ms / p95 0.09ms |
| 15KB 帧 JSON 解析 | 0.37ms |
| 单次调用 QuickJS 运行时 | 0.16ms（仅调用开始一次） |

每帧跨边界两次，额外约 0.5ms；50ms 的物理帧里可忽略。真正决定帧率的是采样与物理步进，不是桥。

---

## 6. 与既有设计的差异

| 文件 | 变更 |
|---|---|
| `public-api.md` §6 | 删 `mc.wait`/`WaitRequest`/`WaitConditionDef`/`ConditionCheck`/`CompletionCheck`/`mc.checkpoint`；**保留 `mc.read` 但改形状**为 `{value, version, unknown?}`（查询专用）；新增 `mc.sleep`/`mc.waitForChange`/`body.call` |
| `public-api.md` §6.3 | 删 `ProgramDefinition` 的 `dependencies`/`bindings`、`ProgramBinding`、`nativeEnvironment`/`effectiveBindings`；程序改为单文件 + 头注释 + `main` 入口 |
| `public-api.md` §7.1 | `ProgramExecutionPort` → `ProgramPort`（§7）；`invoke` 的 `api` 改为 §7 的扁平 RPC；`ProgramCapacity` 状态集为 `queued/active/retiring/unknown`；`ProgramExecutionFailure` 的 `reason` 换成 §7 的 `code` + `source` + `hint` |
| `assets.md`（已改为 Library）§6.2 / §8 / §11.1 | Program 不再是 asset kind；`publishFromRun` → `library.save`；`ProgramManifest`/`sourceForm` 不再存在。该文件的仓库机制（SQLite 目录、不可变包、发布 CAS、证据副本）一并删除，蓝图/经验改为文件约定 |
| `runtime.md` §9 | 引擎定为 worker + QuickJS-WASM；容量按段、持身体时只尝试；资源失败降为 call 级 |
| `runtime.md` §10 | 删 `WaitConditionDef`/`mc.wait`/条件注册；`waitForChange` 改为「`read` 返回观察版本 + `watch` 原子比较」，判定函数留在 guest |
| `runtime.md` §11 | 不变，但快照由 Program 写、写在调用级（`sources/<sha256>.js`），记录只存 ref + digest |
| `contracts.md` §5.3 / §5.4 | 删 `mc.wait` 条件注册与 `WaitConditionDef`；容量准入改为按段（持身体只尝试）；无漏唤醒由 `mc.read` 返回的观察版本 + `watch` 原子比较承担 |
| `contracts/body.ts` | `ControlInput` 增加 `lookAt`；`BodyOps` 增加 `lookAt`；`body.dig` 收 `position`；新增句柄方法 `body.call`（委托） |
| `contracts/executor.ts` | `Entry` 合并为 `{selector, input, code?}`；`CallRecord` 增加 `sourceDigest`/`snapshotPath`；段记录不再保存单一程序源码 |
| `contracts/world.ts` / Driver 事实 | 读 RPC 需要能给出"这组值对应的观察位置"：World 用 `ObservationCursor`，事实类用反馈帧 `sequence`；若 Driver 拿不到帧序号，退化为 body 会话内的事实修订计数 |
| World 入口（`worlddef`） | `run` 收 `{ref, input}` 或 `{code, input}`；`library` 五 op（§4.1） |
| Driver / World | 采用 §3.4 的命名与完成口径；能力自带身体；新增的能力不需要 Program 改代码 |

---

## 7. 类型与端口

```ts
// ── 宿主看到的全部 Program 接口 ──────────────────────────────
interface ProgramPort {
  open(request: OpenRequest): Promise<OpenedSegment>;
  writeSnapshot(request: { run: string; source: string }): Promise<SnapshotRef>;
  readSnapshot(request: { run: string; digest: string }): Promise<{ source: string; path: string } | null>;
  list(query?: { text?: string; tag?: string; limit?: number }): Promise<ProgramSummary[]>;
  get(name: string): Promise<ProgramDetail | null>;
  save(request: SaveRequest): Promise<ProgramSummary>;
  update(request: UpdateRequest): Promise<ProgramSummary>;
  delete(name: string): Promise<void>;
  capacity(): ProgramCapacity;
}

interface SnapshotRef { digest: string; path: string }

interface ProgramSummary {
  name: string; summary: string | null; tags: string[];
  digest: string; updatedAt: string; path: string;
}
interface ProgramDetail extends ProgramSummary {
  source: string; lessons: string[]; input?: JsonSchema; savedFrom?: string; aboutError?: string;
}

type SaveRequest = {
  name: string; summary: string; tags?: string[]; input?: JsonSchema;
  source: string;                      // from 由 Executor 解析成确切字节后传入
  savedFrom?: { run: string; segment: string; call: string };
};
type UpdateRequest = {
  name: string; source?: string; summary?: string; tags?: string[];
  addLesson?: string; removeLesson?: string;
  expectedDigest?: string;             // 与当前文件不符 → DIGEST_CONFLICT
};

interface OpenRequest {
  name: string; run: string; segment: string;
  mayWait: boolean;                    // 段是否持身体租约：false 时满容量立即失败
  signal: AbortSignal;
}
interface OpenedSegment {
  resolved: ResolvedProgram;
  domain: ProgramSegmentDomain;
}

interface ResolvedProgram {
  name: string; source: string; digest: string; snapshotPath: string; summary: string | null;
}

interface ProgramSegmentDomain {
  readonly state: "active" | "retiring" | "dead";
  resolve(name: string): Promise<ResolvedProgram>;   // 段内固定，首次解析后缓存
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  retire(reason: "finished" | "decide" | "stop" | "failed"): Promise<ProgramRetirement>;
}

interface InvokeRequest {
  call: string;                 // Runtime 侧 Call 标识
  program: ResolvedProgram;
  input: JsonValue;
  delegated: boolean;           // 由 body.call 委托身体
  signal: AbortSignal;
  host: ProgramHostApi;         // §7 的十一条扁平 RPC
}

type InvokeResult =
  | { ok: true; value: JsonValue; startedAt: string; endedAt: string }
  | { ok: false; failure: ProgramFailure; startedAt: string; endedAt: string };

type FailureSource = "program" | "capability" | "world" | "input" | "environment";

type ProgramFailureCode =
  | "PROGRAM_NOT_FOUND" | "SELECTOR_INVALID" | "PROGRAM_INVALID" | "PROGRAM_INPUT_INVALID"
  | "PROGRAM_CONFLICT" | "PROGRAM_RETIRED" | "PROGRAM_CAPACITY"
  | "PROGRAM_ERROR" | "PROGRAM_VALUE" | "PROGRAM_MEMORY" | "PROGRAM_TIMEOUT"
  | "PROGRAM_DEPTH" | "PROGRAM_CRASH" | "CANCELLED";

interface ProgramFailure {
  code: ProgramFailureCode;
  scope: "call" | "domain";
  source: FailureSource;
  message: string;
  line?: number; column?: number;
  guestStack?: string[];
  consoleTail?: string[];
  detail?: string;
  hint?: string;
}

interface ProgramCapacity {
  observedAt: string; limit: number; occupied: number; queued: number;
  entries: { run: string; segment: string; state: "queued" | "active" | "retiring" | "unknown";
             requestedAt: string; activeAt?: string }[];
}

// ── guest → 宿主：扁平 RPC，无函数值 ───────────────────────────
interface ProgramHostApi {
  call(input: { selector: string; args: JsonValue; delegateBody?: boolean }): Promise<JsonValue>;
  read(input: { targets: Record<string, { ref: string; input?: JsonValue }> })
    : Promise<{ values: Record<string, JsonValue>; version: string; unknown: Record<string, string[]> }>;
  watch(input: { targets: Record<string, { ref: string; input?: JsonValue }>;
                 since: string; timeoutMs: number })
    : Promise<{ status: "changed" | "timeout"; values: Record<string, JsonValue>; version: string }>;
  sleep(input: { ms: number }): Promise<null>;
  progress(input: { value: JsonValue }): Promise<null>;
  decide(input: { reason: string; checkpoint?: JsonValue }): Promise<never>;
  acquireBody(input: {}): Promise<HandleRef>;
  releaseBody(input: { handle: string }): Promise<null>;
  handleOp(input: { handle: string; op: string; args: JsonValue }): Promise<JsonValue | HandleRef>;
  closeHandle(input: { handle: string }): Promise<null>;
  log(input: { level: "log" | "info" | "warn" | "error"; text: string }): Promise<null>;
}
```

RPC 十一条，全部一进一出。新增能力不会新增 RPC，只可能新增句柄种类或 `op` 名。`mc.read` 与 `mc.waitForChange` 都不是 RPC：前者是 `read` 的薄包装（单目标时给 `value`），后者是 shim 里约 12 行的循环（`read` → `predicate` → `watch` → 重判），判定函数因此可以闭包任意 guest 状态，也不需要任何条件注册。

失败码 → source 与建议：

| code | source | 建议模板 |
|---|---|---|
| `PROGRAM_INVALID` / `PROGRAM_ERROR` / `PROGRAM_VALUE` / `PROGRAM_MEMORY` / `PROGRAM_TIMEOUT` / `PROGRAM_DEPTH` | program | 改代码（看行号与栈） |
| `PROGRAM_INPUT_INVALID` / `SELECTOR_INVALID` / `PROGRAM_NOT_FOUND` | input | 改参数或先 `list`/`describe` |
| `PROGRAM_CAPACITY` / `PROGRAM_CRASH` | environment | 等资源或停止并报告 |
| `PROGRAM_RETIRED` / `CANCELLED` | environment | 等待或重新提交 |
| 能力返回的错误 | 能力自报 | 换策略/改世界后重试；同一调用重试通常无用 |

另有一类错误不进 `ProgramFailure`，由 shim 或 Runtime 直接抛给 guest，程序可以当场 `catch`：

| 码 | 何时 |
|---|---|
| `USE_MC_READ` | 对查询能力用了 `mc.call` |
| `USE_MC_CALL` | 对动作能力或程序用了 `mc.read` |
| `BODY_NOT_DELEGATED` | 调用方持着身体租约，而本调用不是 `body.call` 委托的 |
| `BODY_SCOPE_ACTIVE` | 持有身体时调 `mc.sleep`/`waitForChange`（要先退出 body） |
| `STEP_ASYNC` | `body.loop` 的 `step` 返回了 promise |
| `WINDOW_CLOSED` | 对已关闭/已脱离 body 的窗口操作 |
| `ACCESS_DENIED` | 读能力里试图产生副作用 |

它们都是程序自己的用法错误，就地抛、就地可诊断，不需要经过段失败路径。

---

## 8. 实施与验收

实施位置：`.uina/worlds/minecraft/program/`（与 `driver/`、`world/`、`assets/` 同级，走同一套加载）。

| 文件 | 职责 |
|---|---|
| `index.ts` | `ProgramPort` 组合：库 + 快照 + 域管理 |
| `store.ts` | 目录扫描、名字规则、头注释解析/生成、原子写、摘要、内容寻址快照 |
| `library.ts` | 五个 op 的实现与错误映射 |
| `domain.ts` | 主线程侧域：worker 生命周期、容量、RPC 路由、取消、退役、段内名字固定 |
| `guest-worker.mjs` | worker 侧：QuickJS 运行时、shim（`mc` 七方法 + `body`）、消息泵（只依赖 node 内置 + `quickjs-emscripten`） |
| `compile.ts` | 脚本编译、`main` 提取、语法错误到行列 |

### 阶段 1：库与格式

验收：两个手工程序能被 `list` 按更新时间列出；`get` 返回逐字节源码与头注释字段；`save` 重名报 `NAME_EXISTS`；`update` 能改源码与追加 lesson 且保留未改字段，`expectedDigest` 不符时报 `DIGEST_CONFLICT` 且不落盘；重名目录冲突在 `list` 里标出；`save {from:{run,segment,call}}` 取到该次调用的字节；快照按 `sha256` 落在 `runs/<run>/sources/` 且同摘要复用；非法文件名被拒。

### 阶段 2：域与桥（无身体）

验收（可脚本化）：

1. 同一程序同 input，经 `{code}` 与经 `save` 后 `{ref}` 调用返回同值。
2. `throw new Error("x")` → `PROGRAM_ERROR`，行号等于源码行号（无包装偏移）。
3. 语法错误 → `PROGRAM_INVALID`，带行号列号；缺 `main` → `PROGRAM_INVALID` 且消息说明入口约定。
4. 同步死循环 → 5s 内 `PROGRAM_TIMEOUT`，主线程事件循环延迟 < 20ms。
5. 微任务死循环（`while(1) await Promise.resolve()`）→ 同样 `PROGRAM_TIMEOUT`，worker 不空转。
6. `const a=[]; for(;;) a.push(new Array(1000).fill(0))` → `PROGRAM_MEMORY`，域仍可继续下一次调用，进程不退出。
7. 返回值含 `NaN`/函数/循环引用 → `PROGRAM_VALUE`。
8. `mc.sleep(10_000)` 后 stop → `CANCELLED`，50ms 内结算。
9. `typeof process === "undefined"`；`import("node:fs")` 永不结算 → 调用停在 idle（不报错、不烧 CPU），`stop` 能立即取消。
10. 段内两次 `mc.call("同名")` 在一次文件修改后仍用同一份字节；下一段看到新内容。
11. `mc.call("block@1")` → `USE_MC_READ`；`mc.read("mine@1")` → `USE_MC_CALL`。
12. `mc.read` 的 `unknown` 在区块未加载时包含 `chunk_unloaded`；`mc.waitForChange` 在"读到旧值后立即发生目标变化"的场景中立即返回（无漏唤醒回归用例）。

### 阶段 3：身体与反馈

验收（`tests/minecraft-driver-helpers.ts` 的 FakeClientBot 模型）：`body.loop` 跑 20 帧，帧序错乱或重复 apply 被拒；`withBody` 内 `mc.sleep` 报 `BODY_SCOPE_ACTIVE`；`body.call("子程序")` 内 `mc.withBody` 拿到同一租约、不二次 acquire；同一段内 `mc.call("子程序")` 而子程序要身体 → `BODY_NOT_DELEGATED`；原生能力在租约内可直接借身体；退出 body 时未关的窗口自动关闭。

### 阶段 4：容量、退役、decide、错误文本

验收：4 域占满后，第 5 个**不持身体**的段停在 `queued`（`capacity` 里可见），第 1 段 `retire` 后它自动转 `active`；4 域占满且有段正持身体时，该段第一次调程序 → `PROGRAM_CAPACITY`（environment）且不死锁；`retire` 得 `retired` 且容量归零；宿主侧强杀 worker 模拟崩溃 → `PROGRAM_CRASH`（environment）、进程存活、容量释放；`decide` 后段进 `awaiting_decision`、域已退役、`continue` 开新段能重读世界；失败文本包含行号、来源、已生效效果与 `hint`。

### 跨阶段不变量

- 每次程序调用的 `sourceDigest` 与 `runs/<run>/sources/` 里的文件一致；改文件不影响在跑的段名下的既有调用。
- 任何失败都不把"没有效果"报成"已生效"：`dispatch`/`effects` 只由 Runtime 填。
- 库操作不执行代码；执行不写库。
- 程序的正常返回不被当作目标达成的证据（`completion.scope = execution`）。

---

## 9. 未决

1. **能力目录的归属**：§3.4 是契约提案，具体实现与错误码归 Driver/World 模块；需要它们确认命名与完成口径后，本文的能力表才算冻结。
2. **`lookAt` 的落地**：需要在 `contracts/body.ts` 与 Driver 控制写入路径上各加一处；若 Driver 拒绝，退回"程序自己算角度"，但指南要多三行。
3. **`describe` 的候选排序**：现在按名字/摘要/标签子串匹配。是否需要显式的分类字段（而不是只靠 tags）来决定候选顺序，等能力数量上去再看。
4. **事实类目标的观察位置**：`self@1`/`inventory@1` 的 `version` 需要 Driver 给出"这组值来自哪一帧"。若 `FeedbackFrame.sequence` 已够用就不加字段；否则需要一处小改动。
5. **`decide` 的 checkpoint 语义**：现在是自由 JSON，由主脑决定怎么用；是否要给"恢复段"一个约定的最小结构（位置、背包摘要、目标），等 `runs continue` 实现后再定。
6. **`sensors` 的上限**：一次 `body.loop` 最多几个传感器、采样频率是否可配，取决于 Driver 的采样成本。
7. **域退役得 `unknown` 时谁接管**：本文要求容量不释放并上报 Executor；是否用 Windows 作业对象回收，超出 Program 范围。
8. **`library.rename`**：暂不提供；重命名 = `save` 新名 + `delete` 旧名。
9. **蓝图的归属**：`blueprint@1` 与 `input.blueprint` 的名字解析归 [Library](assets.md) §3（文件约定）与 Construction（解码、绝对坐标）；本文只假定"按名取到一组绝对坐标的 cells"。

---

## 附录 A：给模型的一页

这段就是 `mc` 工具描述里该注入的全部内容（也放进系统提示的附件）：

```text
程序：一个 .js 文件，合法 JavaScript。入口是 async function main(mc, input) { ... }，
      return 的就是结果。跑通后 library save 存起来；之后 mc run {ref:"名字", input:{...}} 直接调。

两个入口，一句话：名词用 mc.read，动词用 mc.call。

读（查询，返回 value / version / unknown）
  const { value: inv, unknown } = await mc.read("inventory@1");
  const { value: here } = await mc.read("block@1", { at: pos });
  value 是领域值；unknown 非空表示"没看清"（如 chunk_unloaded），别把 null 当空气。

做（动作与程序，返回领域值，失败 throw）
  await mc.call("craft@1", { item: "stick", count: 4 });
  await mc.call("wood_pick", { count: 24 });    不带 @ 是已保存的程序，带 @ 是能力。
  失败：e.code=原因  e.source=哪一层报的  e.hint=建议  e.effects=已发生的事

不知道有什么能力
  mc describe { query: "合成" }   → 候选
  mc describe { ref: "craft@1" }  → 输入/输出/完成口径/错误/可直接复制的示例

库
  library list [text|tag]          有什么
  library get  {name}              看源码（学它怎么写）
  library save {name, summary, from:{run,segment,call}}  把跑通的这次存下来
  library update {name, source?, summary?, addLesson?, expectedDigest?}
  library delete {name}

身体（只有要逐 tick 控制时才显式拿）
  await mc.withBody(async body => { ... })     退出即释放
  await body.loop(step, sensors)               step 每帧返回 {keys,lookAt,use,attack} 或 {done:true}
  body.call("别的程序", input)                  把身体显式委托给它（mc.call 不会）
  body.dig(pos) / body.attack(ref) / body.useItem() / body.equip(item)
  body.openContainer(pos) -> win.snapshot() / win.click({slot,button,mode})
  sensors = { 名字: {ref:"block@1", input:{...}} }，帧里读 f.sensors.名字.value

等待（现在就满足会立即返回，不会漏掉之前的变化）
  const r = await mc.waitForChange({inv:{ref:"inventory@1"}}, s => s.inv.freeSlots <= 2, {afterMs:5000})
  r.kind === "timeout" ? 处理超时 : 用 r.values
  await mc.sleep(ms)

进度与交还
  mc.progress({summary:"..."})
  await mc.decide({reason, checkpoint})   结束本段并交还决定权（不返回）

不要
  import/require、文件、网络、跨调用的全局变量。要复用：存库、mc.call，或复制源码改。
  body.loop 的 step 里不要 await（要 IO 就用 body.feedback 手写循环）。
```

约五十行，不含能力清单——能力清单由 `describe` 按需查询，不占常驻上下文。

---

## 附录 B：实测证据

Node v24.13.1 / Windows / `quickjs-emscripten@0.32.0`。

| 项 | 结果 |
|---|---|
| worker 启动（空） | 17.2–19.6 ms |
| worker 启动（含 QuickJS 就绪） | 37.1–41.0 ms |
| 主线程 ↔ worker 往返 | p50 0.026 ms / p95 0.085 ms |
| worker 终止（同步死循环中） | 0.8 ms；期间主线程 interval 正常触发 |
| QuickJS 中断同步死循环 | 37.4 ms，中断回调 2001 次 |
| QuickJS 运行时 + 上下文 | 0.16 ms |
| QuickJS 编译 120 行 + 上下文 | 0.37 ms |
| QuickJS 15 KB JSON 解析 | 0.37 ms |
| QuickJS `setMemoryLimit(32MiB)` 下堆膨胀 | `InternalError: out of memory`（~3 s），随后新上下文仍可用 |
| worker `resourceLimits.maxOldGenerationSizeMb=32` 下堆膨胀 | **整个进程 FATAL ERROR abort**（不可用作边界） |
| QuickJS 纯计算 | 3M `Math.sqrt` 循环 140 ms |
| guest 全局 | `process`/`require`/`fetch`/`WebAssembly`/`setTimeout` 均 undefined；`import("node:fs")` 返回永不结算的 promise |
| 单 worker + QuickJS RSS | ~62 MB |

---

## 附录 C：实现骨架

头注释解析（`store.ts`）：

```ts
function parseHeader(source: string) {
  const m = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!m) return { header: null, body: source };
  const fields: Record<string, string[]> = {};
  let key: string | null = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/^\s*\*\s?/, "").trimEnd();
    const tag = /^@(\w+)\s*(.*)$/.exec(line);
    if (tag) { key = tag[1]; (fields[key] ??= []).push(tag[2]); }
    else if (key && line.trim()) fields[key].push(line);
  }
  return {
    header: {
      summary: fields.summary?.join("\n").trim() ?? null,
      tags: (fields.tags?.join(",") ?? "").split(",").map(s => s.trim()).filter(Boolean),
      input: fields.input ? JSON.parse(fields.input.join("")) : undefined,
      lessons: fields.lesson ?? [],
    },
    body: source.slice(m[0].length),
  };
}
```

入口提取（`compile.ts`）：

```ts
// 脚本原样编译；错误行号即源码行号
const compiled = ctx.evalCode(source, `${name}.js`);
if (compiled.error) return { ok: false, syntax: dumpError(compiled.error) };
const main = ctx.getProp(ctx.global, "main");
if (!ctx.typeof(main) /* function */) return { ok: false, missingEntry: true };
```

域内消息（`guest-worker.mjs`）：

```ts
type ToWorker =
  | { t: "invoke"; call: string; source: string; name: string; input: JsonValue; delegated: boolean }
  | { t: "reply"; call: string; id: number; ok: true; value: JsonValue | HandleRef }
  | { t: "reply"; call: string; id: number; ok: false; error: HostError }
  | { t: "cancel"; call: string }
  | { t: "retire" };

type FromWorker =
  | { t: "ready" }
  | { t: "rpc"; call: string; id: number; method: string; args: JsonValue }
  | { t: "settled"; call: string; ok: true; value: JsonValue }
  | { t: "settled"; call: string; ok: false; failure: ProgramFailure }
  | { t: "log"; call: string; level: string; text: string };
```

`cancel` 消息只对"停在等 RPC"的调用有效；同步执行中的调用收不到消息，靠 `SharedArrayBuffer` 上的标志由中断回调打断（§5.3/§5.4）。

一次调用的顺序：`open`（解析 + 段内固定 + 准入）→ `invoke`（worker 新建运行时 + 编译脚本 + 调用 `main`）→ guest 的 `__post` 发出 `rpc` → 主线程交给 Runtime → 回 `reply` → guest 继续 → `settled` → Runtime 记录屏障。快照由 `writeSnapshot` 在解析时写入。取消与退役在任意时刻插入，都走 §5.4 的路径。
