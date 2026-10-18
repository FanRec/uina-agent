# Program（程序）详细设计

状态：详细设计，待实施。本文是 Minecraft Program 的终态设计。

本文取代：`public-api.md` §6、§6.3、§7.1 中程序 API 与执行端口的部分；`assets.md`（已改为 Library）中 Program 作为资产、`publishFromRun` 的部分；`runtime.md` §9、§10 中程序执行域的实现建议与 `mc.wait` 条件注册。本文未覆盖的部分（身体仲裁、调用与效果记录、World 查询语义、能力实现）仍归 Runtime / Driver / World；蓝图与经验归 [Library](assets.md)。

**读者与读法。** 这是给**实现者**的规格（本项目的实现者是人 + AI 编码代理），也供评审者查证决策，不是教程或用户手册：

| 部分 | 读者 | 用途 |
|---|---|---|
| §0–§5、§7 | 实现者 | 权威合同：类型、不变量、错误码、时序。冲突时以这里为准 |
| §6 | 实现者 | 要对**其它文档/模块**做的同步改动清单 |
| §8、附录 B | 实现者 + 评审者 | 验收标准与选择依据的证据 |
| 附录 A | **运行期的模型**，不是开发者 | 它证明"这套东西能被一页纸学会"；真正生效的指南必须由 descriptor 生成，不能手抄两份 |
| 附录 C | 实现者 | 参考骨架（非合同，见其标题下说明） |

写代码时只读正文（§0–§9）就够；附录按需查。

---

## 0. 终态

### 0.1 一段实录

下文的 `mc` 指 Minecraft 工具（action：`observe` / `describe` / `run` / `runs` / `library` / `say`），`library list` 是 `mc library {op:"list"}` 的简写。工具上的 `say` 是不动身体的便捷入口，等价于 `mc.call("say@1", {text})`（程序里没有工具动作，只有能力，见 capabilities.md §4）。

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
Uina: library get { name: "wood_pick" }     → 源码 + 头部说明
Uina: mc run { name: "wood_pick", input: { count: 24 } }
Uina: mc run { code: "… 按蓝图放方块 …", input: { blueprint: "hut_7x5" } }
```

密林里发现半径 24 太慢，直接把默认值改小：

```text
Uina: library update { name: "wood_pick", source: "…radius: input?.radius ?? 12…" }
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
4. 程序可以显式接管身体做 tick 级操作（`withBody` + `body.loop`），也可以只调用能力（能力自己处理身体）；持身体期间要把控制权交给别的调用，只能显式 `body.call`——这对原生能力和程序是同一条规则。
5. 失败能说清楚：哪一行、错误从哪一层来（事实）、已经发生了什么、建议下一步（明确标注为建议）。
6. 程序可以在中途把决定权交回（`decide`），下次从新段继续。
7. 多个程序并发时各自隔离，互不抢身体、互相拖不垮。
8. 死循环、内存爆炸、worker 崩溃都不会带走 Uina 的进程。
9. 改文件不影响正在跑的段；每一次程序调用都有当时的源码快照与摘要。
10. 模型要学的固定表面积只有一页（附录 A）；每个能力的具体参数用 `describe` 现取，不占着上下文。
11. 保存与校验不执行代码：库操作只做静态编译检查；入口与"顶层只有声明"在 guest 内随调用成立，顶层拿不到任何宿主句柄。
12. 取消只取消等待：已派发的操作照常结算并留痕（效果、未知），不会出现"程序取消了、挖掉的方块却没记录"。
13. 域内的两类资源都有界且**超限即拒、不排队**：同时活动的 guest（默认 8）与单个 guest 的在途宿主 RPC（默认 16）。前者防"等待者占满、被等待者进不来"的环，后者防一个 guest 把宿主队列打满；两者都只是计数检查，报 `PROGRAM_CAPACITY` 并给分批建议。
14. 单次连续计算有独立预算（默认 20ms），保证同一 worker 里的兄弟 guest 仍能按时处理反馈（50ms 一个 tick）；中断即终止该调用，不能暂停恢复，所以"分片"由程序显式 `await mc.sleep(0)` 表达。

### 0.3 本文不做

- 不做模块系统、不做 `import`/`require`、不做包管理器。
- 不做程序版本号、发布流水线、依赖图、绑定表。
- 不做第二套能力 API（不为每个能力生成方法）。
- 不做完成条件的 DSL 或完成校验子系统：程序默认只承诺"正常结束"。
- 不做全知世界模型、不做自动规划器；程序就是人（模型）写的普通 JS。
- 不在已有机制之外再造调度器、状态机或安全层：隔离（QuickJS/worker）、身体仲裁（BodyScope）、窗口状态校验（`Window`）、效果结算（`EffectRecord`）各自解决一个问题，不互相替代，也不叠加第二套。

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
| 8 | 身体控制属于**调用谱系上的 BodyScope**：`mc.withBody` 独立申请，`body.call` 委托继承；`mc.call` 从不继承 | 隐式继承：独立的调用被自动升级成控制者，调用点看不出资源归属；按 Native/Program 分两套规则：同一件事有两种说法，迟早对不上。 |
| 9 | 失败带 `source`（哪一层报的，事实）与 `hint`（建议，可能不准） | 单一 `blame`（责任归属）。`UNREACHABLE` 可能是地形、也可能是查询错、寻路缺陷或观察过期，Program 无从知道责任，只能知道自己从哪收到它。 |
| 10 | 库操作只有五件：`list/get/save/update/delete`，保存就是写文件 | search 评分、向量检索、质量认证、目录索引、发布事务。程序数量在几十到几百量级，文件系统就是索引。 |
| 11 | 引擎 = worker 线程 + 每次调用一个 QuickJS-WASM 运行时 | `node:vm`（没有内存上限、没有中断）与子进程（启动/运维重）。见附录 B 的实测。 |
| 12 | 容量按段准入：同段复用本域；跨段排队；只有"段已持身体、却还没有域"这一条路径立即 `PROGRAM_CAPACITY` | 把容量普遍做成失败码：资源竞争变成程序必须处理的业务错误，而它其实只是一句"等一下"。但"持着身体排队"是真正的互等（我等你结束、你等我的身体），只能拒绝；这条只在原生组合能力首调程序时出现。 |
| 13 | 不设墙钟超时，但等待必须可见（`waiting.kind` + `idleMs`） | 用统一看门狗杀长任务：长途移动、炉子、等天亮都会被误杀。停不停是主脑的判断，不是定时器的判断。 |
| 14 | 域内两道上限都**满即拒绝**：活动 guest 8 个、单 guest 在途宿主 RPC 16 个；都不排队 | 域内排队 = 等待者占着槽位等被等待者，三层调用就能自锁；RPC 不设上限 = 一个 guest 用一万个 promise 就能把宿主队列打满，而 guest 内存远没到上限。两道限制都只是一次计数检查，不引入调度器。 |
| 15 | 单次连续计算 20ms（`computeBurstMs`），与累计 60s 分开；分片由程序显式 `sleep(0)` | 5 秒 burst 会让同 worker 的兄弟 guest 断掉 100 个 tick 的反馈；而 QuickJS 中断只能终止、不能暂停恢复，所以只能把预算做小 + 给程序一条自愿让出的路。 |
| 16 | 校验与执行用**同一个 QuickJS 引擎**：`COMPILE_ONLY` 只编译不执行 | 宿主 V8 先编译一次：两个解析器、两套错误格式、两份测试，还得承认"V8 过了 QuickJS 可能不过"。同一引擎下，校验期与执行期不可能给出两套诊断，代价只是每次调用多编译一次（0.3–0.5ms）。 |
| 17 | 只有**带观察游标的查询**能做 `waitForChange`；静态与派生查询（`item`/`recipe`/`route.plan`/`build.plan`/`container.last`）`version` 为 `null` | 让任意查询都可等待 = 给派生计算建响应式依赖图（蓝图、材料、世界几何、当前状态）。那是把 World 变成通用计算框架，只为省一次"睡 200ms 再读"。 |
| 18 | 程序头不存经验：没有 `lesson` 字段，也没有 `addLesson`/`removeLesson` | 同一件事写三处（代码默认值、Experience、程序头），模型下次面对三份可能互相矛盾的说明。程序存"怎么做"，Experience 存"发生过什么、学到了什么"。 |
| 19 | `mc.decide` 只在**根调用**成立；子程序调用得到 `DECIDE_NOT_ROOT` | 任意深度的子调用都能打断父任务：非局部控制，与普通函数的组合语义冲突。根调用保留交还能力（Run 身份、累计进度、checkpoint），机制本来就为 `stop` 存在。 |

每条裁决对应的接口细节在后续章节；第 6 节列出对既有文档的变更。

---

## 2. 程序模型

### 2.1 一个文件

```text
.uina/world-data/minecraft/programs/wood_pick.js
```

文件是普通 JavaScript 脚本（不是 ES 模块）：头注释 + 顶层声明 + 入口函数。

```js
// uina {"summary":"砍够原木。附近需要有橡树；挖不到会停在 progress 里。","tags":["木","开局"],"input":{"type":"object","properties":{"count":{"type":"integer","minimum":1},"radius":{"type":"integer"}}}}
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
    await mc.call("mine@1", { at: found.blocks[0].position });
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

文件开头连续的 `// uina {…}` 行是元数据，每行一个 JSON 对象，浅合并（标量后者覆盖、数组拼接）。它是普通 JS 行注释，不影响执行；格式由宿主工具写入，模型不必手写。

| 字段 | 必需 | 含义 | 谁写 |
|---|---|---|---|
| `summary` | 是（`save` 时强制） | 一句话：做什么、假定什么 | `save`/`update` 参数 |
| `tags` | 否 | 字符串数组，用于 `list` 过滤 | 同上 |
| `input` | 否 | JSON Schema，调用前用仓库已有的 `ajv` 校验 | 同上 |
| `saved` | 否 | 来源调用与保存时间：`{run, segment, call, digest, at}` | `save` |
| 其他 | 否 | 忽略（向前兼容） | — |

**没有 `lesson` 字段**：经验不写在程序头上。同一件事可以落在三个地方——代码里的默认值、Experience 资产、程序头注释——让模型下次面对三份可能互相矛盾的说明（"头里写着半径 12 更快，代码里还是 24"）。分工是清楚的：**程序存"怎么做"，Experience 存"发生过什么、学到了什么"**（带证据，见 [assets.md](assets.md) §10）。如果半径 12 确实更好，就直接把默认值改成 12；要记录为什么，就写一条 Experience 并指向这个程序的摘要。这样本库只有五个 op，也不需要 `addLesson`/`removeLesson` 这种"在源码旁边追加旁注"的接口。

为什么是行注释 + JSON，而不是 `/** @summary … */` 块注释：

- **`*/` 会提前终止块注释**：摘要里写了 `a */ b`，保存后的文件与保存前的语义不同、甚至不再是合法 JS。转义能解决，但"作者必须知道哪些字符要转义"本身就是个坑。
- 行注释的终止符只有换行，而 JSON 字符串里不能有裸换行，所以**内容无法破坏结构**——这条保证是语法给的，不是约定给的。
- 解析从"逐行 `@字段 值` + 续行规则 + `@input` 再解析"变成一次 `JSON.parse`，十行代码，零依赖，也没有"续行拼接"这种要教给模型的规则。
- 与"文件是合法 JS"一致：`// uina` 是普通行注释，删掉整行也不影响任何工具链。

规则：

- 解析：从第一行起，凡以 `// uina ` 开头就切掉前缀按 JSON 解析；遇到第一行非注释即停止。JSON 非法或不是对象 → `HEADER_INVALID`，**记在 `list`/`get` 的 `headerError` 里而不是静默丢掉**（否则"保存了但字段没生效"会变成谜）。
- **头坏了不影响执行**：执行只读脚本，`run` 照常；`save`/`update` 能覆盖坏头（写回不依赖解析，见附录 C）。这是"元数据不可信"与"程序不可用"之间必须切开的两件事。
- 没有头注释合法：程序照常可调用；`list` 里显示 `summary: null`。
- `save`/`update` 剥掉文件里已有的 `// uina` 行，写回**一行**规范化的 JSON；**脚本体一个字节都不动**（不重排、不改缩进）。头原来是多行时，合并成一行会让脚本体整体上移——所以错误里的行号以**执行快照**为准，不以当前文件为准。
- 因为规范化会改头，**保存后的文件字节与被执行的源码字节可能不同**：`saved.digest` 记的是执行时的源码摘要，返回的 `ProgramSummary.digest` 是落盘文件的摘要；两者不同不是异常，是事实。所以"从运行段保存"（`save {from:{run,segment,call}}`）的语义是"把那次执行的**脚本体**逐字节搬过来，头按本次参数重写"。
- 头只影响可读性与 `input` 校验，不影响执行：**执行只读脚本**。

### 2.3 目录、命名与冲突

- 扫描 `programs/**/*.js`（递归，子目录只作人类整理，不参与身份）。
- 程序名 = 文件名去掉 `.js`，规则 `^[a-z][a-z0-9_-]{0,47}$`（小写；Windows 大小写不敏感）。
- 以 `.` 或 `_` 开头的文件忽略（临时文件、草稿）。
- 同名出现在多个目录 → `PROGRAM_CONFLICT`：两个都不可调用，`list` 里标出路径，让 Uina 自己删一个。
- **路径必须落在库根之内**：扫描与读取都以"解析后的真实路径"判定（`realpath` 之后仍以库根为前缀），符号链接、目录联接（junction）、硬链接指向外部，或 `.js` 不是普通文件 → 跳过并记 `unsafe` 诊断，`list` 里可见。否则 `programs/x.js → C:\…\任意文件` 就成了读取任意文件的入口；而这台机器上的"本地扩展默认受信任"不等于"关掉基本校验"。这是每个读取入口的一次前缀检查，不是沙箱。
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

调用材料有两个来源，**解析后合流**：`{name}` 取库里的文件，`{code}` 是工具入口直接提交的临时代码。两者都变成同一份 `{source, digest}`，之后走完全相同的路。**解析与快照是两步**，因为 `resolve` 不知道 `run`：

```text
resolve(source)        → {source, digest, name, origin}      只读，不落盘
validate({source})     → ProgramValidation                    只编译，不执行
writeSnapshot({run, program}) → {digest, path}                幂等：同 run 同摘要同路径
open({run, segment, program, snapshot, mayWait, signal}) → 域
invoke(...)            → 结果
```

临时代码不跳过校验、不获得额外特权，只是没有名字、不写库、错误信息里的文件名是 `code-<digest 前 8 位>.js`。

某个程序名第一次在段内被解析时（`resolve` 只读文件、算摘要；落盘是紧接着的一次 `writeSnapshot({run, program})`）：

1. 读文件一次（完整读取到内存，不从缓存拿）。
2. 算 `sha256`。
3. 段调 `writeSnapshot({run, program})` 写 `runs/<run>/sources/<hex>.js`：同摘要已存在则核对字节后复用，不存在则写临时文件再 `rename`。内容寻址，天然去重。
4. **在段内固定**：本段后续同名调用复用这份字节，不再读文件。段内解析出的子程序同样写自己的快照（域内部走同一个写函数），所以"这次运行到底执行了哪些源码"永远可查。
5. 每次程序调用把自己的 `{digest, snapshot}` 写进**调用记录**（不是段记录）。

**固定的是"首次解析这个动作"，不是"解析完成后的结果"**：`resolve(name)` 是异步的，`await Promise.all([mc.call("wood_pick"), mc.call("wood_pick")])` 会让两个调用同时发现缓存为空。所以段内缓存存的是 **Promise**（singleflight），不是结果：

```ts
let pending = fixed.get(name);
if (!pending) { pending = resolveFromDisk(name); fixed.set(name, pending); }
return await pending;                      // 两个并发调用拿到同一个 Promise，同一份字节与摘要
```

失败要驱逐：`resolve` 失败（文件不存在、读到一半被删、编码错）时把该条目从缓存里删掉并让两个等待者都拿到同一个失败——否则一个"名字打错"的失败会被固定一整个段，后续同名调用连文件都不会再看。驱逐之后的下一次调用重新读文件；成功解析过的条目不再受改文件影响。

临时代码只走第 2–3 步（摘要即身份，天然段内固定），并且**每次调用都是新的字节**——改了代码就是新的摘要，不会命中旧快照。`run {code}` 与 `run {name}` 的调用记录、失败来源、`save {from}` 完全同构；后者只是多一个名字来源。所以"先在 `run {code}` 里试，跑通了再保存成名字"是一条完整通路，不需要为临时代码准备第二条执行路径或额外的临时文件约定。

静态校验发生在 `resolve` 之后、`open` 之前：语法不对的字节**不占容量、不排队、不开域**，直接得到 `PROGRAM_INVALID`（带行列号）。校验与执行用同一个 QuickJS 引擎、同一份字节（只编译不执行，§7 `validate`），所以校验期和执行期的诊断不会互相矛盾，也不存在"V8 放行、QuickJS 拒绝"的分裂。这也让 `run {code}` 的失败与 `run {name}` 的失败在时间与资源上都一样便宜。

为什么是每次调用、而不是每个段：一个段可以依次跑 `wood_pick`、`craft_basic`、`build_hut`，三份源码各自独立；段级单文件无法对应，`library.save({from:{run,segment,call}})` 也说不清保存哪一个。内容寻址则让"同一次运行里同一份源码被用了几次"一眼可见（同摘要 = 同一个文件）。

段结束后，下一个段重新解析，拿到的是文件当前内容（§4.3）。

### 2.7 三类"版本"，只冻结一种

| 版本 | 例子 | 谁负责 |
|---|---|---|
| 接口版本 | `mine@1` 的 `@1` | 能力作者；程序里写死 |
| 游戏数据版本 | `oak_log`、配方、方块状态、实体 id | 运行时事实；程序不声明 |
| 服务器实现 | 插件、权限、传送指令、边界 | 运行时事实；程序不声明 |

程序只写死接口版本。物品/方块名是**运行时要解析的名字**，不是编译期常量：名字在这个版本不存在时能力报 `NOT_FOUND`，`hint` 给出同族候选（`oak_log` → `dark_oak_log`、`spruce_log`…）。段记录里带 `environment: {serverVersion, protocol}`，`runs` 与失败文本可读——这样"为什么昨天能跑，今天不能"有一个可查的答案，而不需要在每个程序头上声明游戏版本（那会变成第二套兼容性系统，且模型几乎必然写错）。

同一个程序在不同版本上失败是正常结果，不是需要预防的缺陷；要预防的是**失败说不清原因**。

接口版本自己也要有纪律：**语义变了就换 major**，不能同号换义。这条无法靠类型检查发现，靠调用记录兜住——每次能力调用都记下该次解析到的 `descriptor.digest`（`ResolvedCallable` 本来就带 `digest`）。于是"同一段程序昨天成功、今天报的参数错"可以追到"`mine@1` 的实现摘要变了"，而不是变成无法复现的怪事。不阻断、不认证，只留证据：能力和程序不一样，它是宿主代码而非从磁盘读来的不可信输入，多一层版本协商没有收益。

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
| `mc.call` | `(selector, input?) => Promise<Json>` | 动作与程序。返回领域值；失败抛 `Error`（带 `code`/`source`/`hint`/`dispatch`/`effects`/`progress`）。**从不继承身体**：持 BodyScope 时调需要身体的目标 → `BODY_SCOPE_ACTIVE` |
| `mc.read` | `(selector, input?) => Promise<{value, version, unknown?}>` | 查询能力。`version` 是不透明令牌，覆盖**值变了**与**可观察性变了**两种情况；静态/派生查询（`item`/`recipe`/`route.plan`/`build.plan`/`container.last`）没有变更流，`version` 为 `null`，也不能拿去做等待（§5.5）；`unknown` 只在有未知时出现（如 `["chunk_unloaded"]`） |
| `mc.waitForChange` | `(targets, predicate, opts?) => Promise<WaitResult>` | 现在不满足就等：读一次 → 判定 → 等到观察版本变化 → 重读重判，直到 `afterMs`；观察代次失效则立刻返回 `{kind:"invalidated", reason}`（§5.5）。**三种结局是判别联合**，见下。`targets` 只能是有观察游标的查询（`feedback:true`，见 [capabilities.md](capabilities.md)）；`route.plan`/`build.plan` 这类派生查询没有游标 → `INVALID_INPUT`，改用 `mc.read` + `mc.sleep` |
| `mc.sleep` | `(ms) => Promise<void>` | 可取消的等待；`ms` 取 `0` 时是"让出一次"——让 worker 泵其他 guest 并把连续计算计时清零（长计算分片用，§5.3） |
| `mc.progress` | `(value: Json) => void` | 覆盖式进度。同步入队、按序送达，**保证在本次调用结算之前被 Runtime 收到**（§5.4）：不需要 `await`，也不会丢 |
| `mc.decide` | `({reason, checkpoint?}) => Promise<never>` | 交还整个段（§5.4）。**只有根调用能用**：子程序里调用得到 `DECIDE_NOT_ROOT`，要交还就 `return` 一个讲清楚的值 |
| `mc.withBody` | `(work: (body) => Promise<T>) => Promise<T>` | 借用身体；退出即释放。持身体期间交给别的调用的唯一方式是 `body.call`（§3.3.1） |
| `console` | `log/info/warn/error` | 进调用控制台缓冲，失败时回传尾部 |

**判据是一句话：名词用 `mc.read`，动词用 `mc.call`。** 用错了是明确错误，不是静默降级：`mc.call("block@1")` → `USE_MC_READ`，`mc.read("mine@1")` → `USE_MC_CALL`。

**等待的三种结局**，`kind` 必须如实区分（判别联合，见 §7 的 `WaitResult`）：`met`（判定为真）、`timeout`（到 `afterMs`）、`invalidated`（观察代次失效——断线重连、世界/Driver 重新激活）。前两种带 `values/version/unknown`；第三种只带 `reason`，**没有值也没有版本**——旧 `version` 属于已经不存在的观察空间，强行给一组"新值"只会让程序把重连瞬间的空白当成世界状态。所以 `invalidated` 一律让程序重新读一次。

**未知是可观察性，不是世界状态**，两者必须分开：某个目标从"有值"变成 `unknown`（区块卸了、实体出了视距）时，世界本身没变，但"你看到的"变了——这必须算一次变化（推进 `version`、唤醒等待），并把 `unknown` 交给判定函数；否则等待会睡在一个永远不会再有消息的版本上。反过来，`unknown` 也不等于失效：代次只在地图/连接整体更换时变（`epoch`），单个目标的覆盖变化不动代次。

因此判定函数拿两个参数：`predicate(values, { unknown })`——第一个是各目标的当前值（`unknown` 的照实为 `null`/部分值），第二个是 `{ [ref]: string[] }` 的未知原因清单。写 `s => s.inventory.freeSlots <= 2` 依然成立，需要区分时可写 `(s, { unknown }) => !unknown.inventory && s.inventory.freeSlots <= 2`。`predicate` 必须是**同步布尔函数**：返回 Promise 或非布尔值 → `PREDICATE_INVALID`（guest 侧即时报错）。异步判定会让"观察到变化"和"判定"之间再开一个窗口，而等待的全部价值就在于这个窗口是原子的。

**调用参数在派发前冻结**：`input`、默认值、`selector` 解析到的能力版本在第一个副作用前定下，并记进 `CallRecord`；而路线、目标选择、走位由能力按当前世界持续更新（`capabilities.md` §2.13）。程序算出来的值就是请求的值，不会因为世界变了而悄悄改；能力执行中的算法也不会因为请求已定就停止观察。

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
await mc.withBody(async (body) => { … });   // 退出即释放；嵌套的 withBody 加入同一 BodyScope
```

| | 签名 | 说明 |
|---|---|---|
| `body.call` | `(selector, input?) => Promise<Json>` | **委托身体**调用任意 callable，原生或程序（§3.3.1） |
| `body.drive` | `(input: ControlInput, opts?: {ticks?: number}) => Promise<{receipt, ticks, end}>` | 原样下发控制。返回**实际**生效的 tick 数与结束时的自身状态：要 10 实际 3 是常事（被打断、落地、受击），调用方得看得见 |
| `body.dig` | `(at: Pos, opts?: {aim?: "target" \| "preserve"}) => Promise<EffectReceipt>` | 挖一个方块。`Pos` 是坐标或"坐标 + 维度"；结果可核验（`completion`），不是 void |
| `body.attack` | `(target: EntityRef) => Promise<EffectReceipt>` | 攻击一次；命中与否在 `completion` 里，不在 void 里 |
| `body.useItem` | `(opts?: {hand?: "main" \| "off"}) => Promise<EffectReceipt>` | 使用当前物品 |
| `body.endUse` | `() => Promise<void>` | 结束持续使用（弓、进食） |
| `body.interact` | `(target: {position} \| EntityRef, opts?: {hand?, face?, cursor?}) => Promise<EffectReceipt>` | 精确右键：手、交互面、命中点都可显式指定，省略时由 Driver 按可见性取默认 |
| `body.equip` | `(item: ItemSelector, hand?) => Promise<void>` | 装备/切换到手持 |
| `body.openContainer` | `(target: Pos \| EntityRef) => Promise<Window>` | 打开容器，返回窗口句柄 |
| `body.lookAt` | `(target: {position} \| EntityRef) => Promise<void>` | 转向目标（角度换算在 Driver 内） |
| `body.feedback` | `(sensors: Sensors) => Promise<Stream>` | 手动反馈循环：`stream.next()` / `stream.apply(input)` |
| `body.loop` | `(step: (frame) => ControlInput \| {done:true}, sensors?: Sensors) => Promise<void>` | 本地闭环；`step` 必须同步；`frame.self` 恒有，`sensors` 补查询 |

```ts
type Pos = { x: number; y: number; z: number } | { position: { x: number; y: number; z: number }; dimension: string };
```

**坐标的身份由 Driver 在派发时补齐，不由模型填写**。`body.*` 的 `Pos` 在派发时解析成 `BlockTarget`（`Place` + 整数坐标），`Place` 取自当前 body 会话（连接、incarnation、维度、世界版本）。同一个 `(x,y,z)` 在过传送门或重连之后不指同一个方块，所以 Driver 只在两种情况下拒绝坐标操作：会话 incarnation 变了 → `DISCONNECTED`；进入 `withBody` 以来维度变过、而这次调用没显式给 `dimension` → `WRONG_STATE`（hint：改用 `{position, dimension}`）。`EffectReceipt` 带回实际 `place`，程序能把"挖的是哪一处"写进证据。

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

**`Window`：前置条件由句柄从快照推出，不由模型填。** Driver 的 `click` 要同时核验窗口版本、该格内容、光标三样（`public-api.md` §4：`expectedRevision` + `expectedSlots` + `expectedCursor`），因为一次点击的效果取决于这三者，不只是"第几格、什么模式"。让模型填 `StackExpectation` 既不现实也更容易错，所以句柄代做：

```js
const snap = await win.snapshot();                 // {revision, layout, slots, cursor}；slots[i].region 标明属于谁，item 可能是 null
await win.click({ slot: 5, mode: "quick_move" });  // mode 省略时默认 "click"（见下）
```

- **参照视图**是句柄内部记录的"调用方看到的状态"，初始取自 `snapshot()`。`expectedSlots` 取参照视图里该格（省略 `expect` 时）或调用方显式给的值；`expect: null` 表示这格不校验（"现在是什么就搬什么"）。
- **光标预期也来自参照视图**，不取实时值。这是关键：如果实时取，`Promise.all` 之外的另一个动作（或玩家本人）往光标上放了东西，句柄会"顺手"把新光标当成预期，让一次从未被预期的点击成立——操作意图被悄悄改写了。参照光标与实时光标不一致 → `CONFLICT`（hint：重新 `snapshot`），不派发。
- **句柄自己点击成功后，只更新参照视图里的光标与版本**（取确认结果里的新值），槽位的预期仍钉在最初那次 `snapshot()` 上，直到调用方重新 `snapshot()`。这样"照一次 snapshot 连续搬 8 格"成立：每格的预期都是当初看到的那件东西，光标则随每次成功的操作前进；中途被外部改动的那一步会拒绝你，而不是被悄悄换成新内容。外部导致的光标变化同样不接受，只有句柄自己确认过的操作能移动参照光标。
- `expectedRevision` 用**派发前的实时值**——它是"版本戳"，不是预期内容；用旧版本号会让每次都撞 `CONFLICT`，而正确性由 `expectedSlots`/`expectedCursor` 保证。
- 有不依赖光标内容的模式（`quick_move`、`swap` 等由 Driver 定义）：这类模式的光标预期由 Driver 明确按"不校验光标"处理，而不是靠句柄猜。哪些模式属于这一类写在 Driver 的 `Window` 合同里，句柄只转达模式名。
- 这保留而不是削弱了 Driver 的强校验合同：核验仍在 Driver 侧原子完成，Program 只是把模型看不见的字段正确地填上。

窗口只在 `withBody` 内有效；退出 body 会自动关闭未关的窗口。

`Stream`（`body.feedback` 返回）：`next()` / `apply(input)` / `close()`。`body.loop` 是它的语法糖，覆盖 95% 的用法。

#### 3.3.1 身体：一个控制者，两条进入的路

控制的单位是**调用谱系上的一个 BodyScope**，不是段，也不是实现类型。任一时刻，一个段里最多有一个活动控制者。

- **独立申请**：程序里 `mc.withBody(…)`；或某个动作能力在自己的调用里申请。Runtime 按 FIFO 发放。没有 BodyScope 时 `mc.call("mine@1")` 完全正常：`mine` 自己申请、用完释放。
- **委托继承**：已经持有 BodyScope 的调用写 `body.call(selector, input)`，把控制权交给这次子调用。子调用可以是原生能力，也可以是程序；它继承同一个 BodyScope，不重新排队。委托期间调用方的 `body` 句柄挂起（`drive`/`apply` 报 `BODY_SUSPENDED`），返回后恢复。
- **`mc.call` 永不继承身体，但也不被禁**。它在持 BodyScope 时照常执行：不需要身体的调用（查询、纯计算、不开窗口不移动的程序）完全正常；**只有真的去申请身体时**才冲突。冲突点在 `withBody`/内部 acquire，不在 `mc.call`：调用谱系里已经有人持有 BodyScope，后代再申请就是自等待 → `BODY_SCOPE_ACTIVE`（可 `catch`，hint 指向 `body.call`）。这条**与实现类型无关**：`mine@1`（原生，内部申请）和某个内部 `withBody` 的程序受完全相同的约束。
- **持 BodyScope 时同样不能用 `mc.sleep`/`mc.waitForChange`** → `BODY_SCOPE_ACTIVE`：等待期间身体仍被占着，别人只能排队。要等就先退出 body 再等。
  为什么把判据放在申请点而不是入口：`mc.call` 无法预知被调方要不要身体（`requires` 是提示，不是契约），提前拒绝会误杀"持身体时算个路线"这种完全合法的组合；放在申请点则一次判断、必然准确。
- **没有 BodyScope 时 `body.call` 与 `mc.call` 等价**（没有可委托的东西），不报错——不需要为"是否已在 body 里"写两套代码。
- **一次一个委托**。同一 scope 同时只允许一个 `body.call` 在途；第二个立即 `BODY_BUSY`。`Promise.all([body.call(a), body.call(b)])` 的第二个失败、第一个照常。理由：委托是把控制权借出去，两个借出者没有意义；排队又会把"我以为在并行"变成静默串行。同理，一个调用同时只持有一个 BodyScope，`Promise.all([mc.withBody(a), mc.withBody(b)])` 的第二个报 `BODY_BUSY`（嵌套 `withBody` 是加入同一 scope，允许）。
- **委托不是回滚**：`body.call` 返回后拿回同一个 scope，但世界已经变了。窗口、反馈帧、观察的 `revision`/`sequence` 可能已失效，不能假设"没动过"。
- **能力之间的组合不走 `mc.call`**：`fight@1` 内部用移动的实现，是同一控制器内的函数调用，不是一次新的独立申请。复合能力因此不必嵌套申请身体，也不会把"内部步骤"暴露成可被程序抢占的调用。
- **判据在 Runtime，不在语法糖**：shim 只是把 `body.call(x)` 翻译成 `call` RPC 的 `delegateBody: true`；是不是真的能委托、这次调用能不能拿身体，由 Runtime 按调用谱系核对（`body.call` 的目标若不是 callable、或调用方实际没持 scope，都按普通规则处理）。guest 侧拿到的错误码是结论，不是权限。
- **不会互等**：段**已经开了域之后**，段内所有调用（程序调程序、程序调原生、原生调程序）复用同一个执行域，不再申请容量（§5.2）。同一个域里可以同时有多个挂起的 guest：`P` 在等原生 `N` 的回复时挂起，`N` 又调用程序 `Q`，`Q` 就在同一个 worker 里新建一个运行时跑——worker 在等宿主回复时让出执行权，所以 `P → Native → Q` 不会因为"单线程"而死锁。唯一的例外是 `Q` 的同步循环占满 worker，那由中断与预算（§5.3）覆盖。真正需要新申请容量的只有一种时刻：**这一段还没有域**（段首调用，或根调用是持身体的原生能力时它内部第一次调程序），那种情况按 §5.2 的 `mayWait` 判据处理。

### 3.4 能力目录与发现

> **已被 `modules/capabilities.md` 取代**（2026-10-18）：那里是完整的能力面——13 个查询 + 37 个动作、扁平命名、统一的 13 个失败码、试算（`route.plan`/`build.plan`，以及 `recipe@1` 的 `plan` 字段）与部分完成口径。本节的表只保留为历史与"为什么这样组织"的说明；名字与输入的改动见那份文档的附录 C。

能力的实现归 Driver/World；**命名的唯一权威是 `modules/capabilities.md`**（13 个查询 + 37 个动作、扁平名、13 个失败码、试算与部分完成口径）。这里不复制那张表：两份清单一定会漂移，而模型只要读一份就够。本节只留程序侧必须知道的四条约定与"怎么发现"。

约定：

- 每个能力声明 `completion.scope`（`execution` / `capability` / `goal`）：`say@1` 是 execution，`mine@1`/`craft@1` 是 capability。**程序默认 `execution`**：正常返回只承诺"执行完了"，不承诺"目标达成"。
- 失败里 `dispatch` 与 `effects` 由 Runtime 填；`source` 由报错的那一层决定；`hint` 是建议（§3.6）。
- 能力不得要求程序先借身体；需要身体的内部自己借。所以 `mine@1` 与 `body.dig` 是两个层次，不互相重复。
- 查询用 `mc.read`、动作用 `mc.call`，判据是能力自身的 `access`（§3.2）。

**发现：`describe` 的输出必须能直接拿去写代码。** 这是"模型学得舒服"的真正着力点，不是入口形态。

能力清单、`describe` 的输出格式与每个能力的输入输出**只写在** [`capabilities.md`](capabilities.md) §3、§4、§8；这里不维护第二份清单。

程序侧只需要记住四条：

1. **先查再写**：`mc.describe` 不带参数给概览（名字 + 2–4 字用途），带 `{query:"合成"}` 给相关的几条，带 `{ref:"craft@1"}` 给六行契约。名字、参数、错误码永远以返回的契约为准。
2. **读与调分开**：`mc.read(selector, input)` 取世界现状并给观察版本；`mc.call(selector, input)` 才动世界。用错方向（拿 `read` 调动作）报 `USE_MC_CALL`，反之报 `USE_MC_READ`。
3. **不可用要显式看到**：`mc.describe` 的返回带 `availability`（当前环境/版本不支持时给原因）；调用侧报 `NOT_FOUND`/`WRONG_STATE`，不要退回到用更底层动作手拼一遍。
4. **名字变了要报错，不要静默替换**：库程序里写死的 `collect@1` 在新版本被改名，入场报 `PROGRAM_NOT_FOUND` 或 `NOT_FOUND`；同一个 `@1` 内部语义若变了，能力实现要换 major。

规则：

- 概览给**名字 + 2–4 字用途**，不给参数：名字回答"叫什么"，标签回答"这是干什么的"。纯名字对模型是猜谜——`take`/`stow`/`use`/`transit` 这种词光看名字看不出方向与对象；而把 50 条参数也塞进概览，等于把指南塞进返回值。十几个字的标签是这两者之间唯一划算的点。
- `query` 按名字、摘要、标签做子串匹配，返回 5–10 条候选（带 `tags`），不建向量检索、不建语义排序。模型先看候选、再 `describe` 精确项。
- 候选与详情都来自同一份 descriptor；描述文本由能力作者写，只要求"用途 / 输入 / 输出 / 完成 / 错误 / 示例"六项齐全，不要求长文。
- 示例必须是可复制的完整调用语句（含 `await`），不是伪代码。模型抄它就能跑。
- **发现的质量取决于措辞，不取决于检索**：每个能力至少带一个"任务词"标签（建造 / 挖矿 / 战斗 / 容器 / 合成 …），`summary` 用"什么时候用"的句子而不是名词解释。这样 `describe {query:"造房子"}` 能直接命中 `build`/`build.plan`/`collect`/`craft` 四条，模型不用先浏览 50 条再逐个猜。这是能力作者的验收项，不是检索基础设施：`capabilities.md` §10 用三条黄金查询（造房子 / 挖矿 / 整理背包）锁住"该出现的进前排、无关的不占前排"，哪条不过就改 descriptor 的措辞，不加检索层。
- 程序名也在同一份概览里（`library list` 的位置不同但语义相同：先给名字，再给详情）。

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
  await mc.call("goto@1", { at: input.target });
} catch (e) {
  if (e.code !== "UNREACHABLE") throw e;
  await mc.call("goto@1", { at: input.fallback });
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
  name: "CallError", code: "MISSING_MATERIAL", source: "world",
  message: "craft@1 缺少 4 个 oak_planks（背包有 2）",
  dispatch: "not_sent", effects: [], progress: { have: 2, want: 4 },
  recoverable: true, hint: "先 mine@1 或 craft@1 取得 oak_planks，再重试"
}
```

`dispatch` 与 `effects` 由 Runtime 填，Program 从不自报。取消时也一样：guest 侧拿到 `CANCELLED` 只说明**等待结束**，而 `dispatch: "sent"` 与 `effects` 说的是真实发生过的事——两者可以同时成立（§5.4）。

`source` 表示**错误从哪一层报出来**（事实），不是责任判定：

| source | 含义 | 模型通常该做的事 |
|---|---|---|
| `program` | Program 自己（语法、类型、越界、死循环、内存、值不合法） | 改代码 |
| `capability` | 能力实现自己报的（内部错误、协议错、超时） | 换能力或报告；同一调用重试通常无用 |
| `world` | 能力依据世界状态拒绝（没材料、路不通、目标消失、背包满） | 改变世界状态后重试 |
| `input` | 参数不合法（缺字段、类型错、越界、选择子解析不到） | 改参数或先 `list`/`describe` |
| `environment` | 连接、进程、容量、资源上限 | 停下并报告，或等资源后重试 |

`hint` 是**建议**，由 `code` + `source` 查表生成，可能不准。宁可写"可能"也不要把猜测包装成结论：`UNREACHABLE` 的 `source` 是 `world`（能力报的），但世界是否真的不可达、寻路算法是否有缺陷、观察是否过期，Program 无从知道，所以它只给"换个位置试 / 检查目标是否可达"，不给"世界不可达"这种判决。

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

这七个例子是**合同测试**，不是示意图：它们被逐字放进 `tests/` 跑（用 FakeClientBot + 桩能力），因此输入必须符合能力 Schema、返回值必须体现真实的部分完成与未知状态。**模型会照抄示例**，所以示例里不许出现"看起来成功"的写法——`body.loop` 退出不等于到达，`build` 返回空 `remaining` 才叫放完。

**A. 采集（已有，§2.1）**——读 → 判断 → 做 → 进度。

**B. 合成（依赖顺序）**

```js
// craft@1 的 count 是"新增多少个"，不是"最后要有多少个"——所以这里传差额
async function ensure(mc, item, count) {
  const { value: inv } = await mc.read("inventory@1");
  const have = inv.counts[item] ?? 0;
  if (have >= count) return;
  await mc.call("craft@1", { item, count: count - have });
  const { value: after } = await mc.read("inventory@1");
  const nowHave = after.counts[item] ?? 0;
  if (nowHave < count) throw new Error(`${item} 只到 ${nowHave}/${count}（合成被中断或材料不足）`);
}
async function main(mc, input) {
  await ensure(mc, "oak_planks", 9);        // 工作台 4 + 木棍 2 + 镐 3 = 9
  await ensure(mc, "crafting_table", 1);
  await ensure(mc, "stick", 4);
  await ensure(mc, "wooden_pickaxe", 1);
  return "ok";
}
```

依赖顺序由脚本表达，不由能力猜测——这是"程序是组合语言"的具体含义。`ensure` 在返回前重读一次背包：能力返回"做成了 N 个"之后仍可能有消耗与并发占用，**部分完成不报成功**是程序的判断，不是能力的承诺。

**C. 搭桥（tick 级控制）**

```js
async function main(mc, input) {
  let outcome = "stopped";                                   // 退出 ≠ 到达，结论由程序给
  await mc.withBody(async (body) => {
    await body.loop((f) => {
      const p = f.self.value.place.position;
      if (p.y < input.keepAbove) { outcome = "fell"; return { done: true }; }
      if (Math.hypot(input.to.x - p.x, input.to.z - p.z) < 1.0) {
        outcome = "arrived"; return { done: true };
      }
      if (f.sensors.under.value.block) return { keys: { forward: true }, lookAt: input.to };
      return { keys: { forward: true }, lookAt: { position: { x: p.x, y: p.y - 1, z: p.z } },
               use: { mode: "once", hand: "main" } };
    }, { under: { ref: "block@1", input: { below: 1 } }, self: { ref: "self@1", input: {} } });
  });
  return { outcome };
}
```

`body.loop` 正常返回只表示循环结束：`done: true` 是"我决定停"，不是"我到了"。**判断达成是程序的事**（这里用 `outcome` 记），这也是为什么 `withBody` 结束时不做任何"成功"推断。

**D. 按蓝图建造**

```js
async function main(mc, input) {
  const { value: plan } = await mc.read("build.plan@1", { from: input.blueprint, at: input.origin });
  if (Object.keys(plan.missing).length) return { reason: "料不够", missing: plan.missing };
  const r = await mc.call("build@1", { from: input.blueprint, at: input.origin });
  if (r.remaining.length) return { reason: "没放完", remaining: r.remaining.slice(0, 5) };
  return { placed: r.placed };
}
```

蓝图只管"变成方块"与"算料"两件事，放格子的顺序与够高处由 `build@1` 自己处理——程序不必写循环。

**E. 战斗（反馈 + 撤退）**

```js
async function main(mc, input) {
  let outcome = "timeout";
  await mc.withBody(async (body) => {
    await body.loop((f) => {
      const me = f.self.value;
      const target = f.sensors.near.value.entities[0];
      if (!target) { outcome = "clear"; return { done: true }; }
      if (me.health < 8) { outcome = "retreated"; return { done: true }; }   // 撤退判断留在程序里
      return { keys: { forward: true }, lookAt: target.ref, attack: target.ref };
    }, { self: { ref: "self@1", input: {} },
         near: { ref: "entities@1", input: { kind: "hostile", radius: 6, limit: 1 } } });
  });
  return { outcome };
}
```

**F. 容器整理**

```js
async function main(mc, input) {
  await mc.withBody(async (body) => {
    const win = await body.openContainer(input.chest);
    const snap = await win.snapshot();
    const mine = new Set(snap.layout.regions.find((r) => r.name === "player").slots);
    const targets = snap.slots.filter((s) => mine.has(s.slot) && s.item?.name === "cobblestone");
    for (const slot of targets) {
      await win.click({ slot: slot.slot, mode: "quick_move" });   // 快速转移；默认 "click" 是拿在光标上
    }
    const after = await win.snapshot();                            // 验证东西真的进了箱子
    const moved = targets.filter((t) => !after.slots.find((s) => s.slot === t.slot)?.item).length;
    await win.close();
    if (moved !== targets.length) throw new Error(`只转移了 ${moved}/${targets.length} 格`);
  });
  return "ok";
}
```

槽位带 `region`（`player`/`container`），程序不必自己数索引；`click` 的三项强校验（`expectedRevision`、`expectedSlots`、`expectedCursor`）由句柄从参照视图填，模型只给点哪一格——让模型手填这三个值既无意义又必然出错。`mode` 默认 `"click"`（拿起/放下，光标参与校验）；整理背包要显式写 `"quick_move"`——这正是"点击成功"与"东西到位"是两件事的地方，所以示例在关闭窗口前重读快照核对。`"quick_move"`/`"swap"` 这类不依赖光标内容的模式不校验光标，由 Driver 明确处理；完整取值归 driver §12。

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
    await mc.call("mine@1", { at: last });
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
| `list` | `{kind?, text?, tag?, limit?}` | `[{kind, name, summary, tags, updatedAt, size?, digest?, path?, headerError?}]` |
| `get` | `{kind?, name}` | program → `{name, source, summary, tags, path, digest, savedFrom?, updatedAt}`；其余见 Library §5 |
| `save` | `{name, summary, tags?, input?, from?: {run, segment, call}, source?}` | `ProgramSummary` |
| `update` | `{name, source?, summary?, tags?, input?, expectedDigest?}` | `ProgramSummary` |
| `delete` | `{name}` | `{name, deleted: true}` |

- `save` 只创建；已存在 → `NAME_EXISTS`，提示用 `update`。这样一次陈旧的运行不会静默换掉正在用的文件。
- `update` 是唯一的修改入口：改源码、改摘要、改 `input` schema 都在这里；**没出现的字段保持原值**，出现就覆盖（`tags` 整体替换，不做合并）。
- `update` 支持 `expectedDigest`：与文件当前摘要不符 → `DIGEST_CONFLICT`，不覆盖。这是普通文件编辑的乐观并发控制（多个运行与用户自己都可能改同一份文件），不是发布 CAS。
- `delete` 硬删除文件；`runs/` 里的快照保留（历史仍可读）。
- `list` 只做大小写不敏感的子串 + 标签过滤，按 `updatedAt` 倒序，默认 50 条。没有评分、没有向量检索："哪个程序真的能用"由运行记录聚合回答，库不维护第二份统计。
- 库自己的错误不产生段失败：`NAME_EXISTS`、`NOT_FOUND`、`NAME_INVALID`、`HEADER_INVALID`（`// uina` 行不是合法 JSON 对象，或 `input` 不是合法 JSON Schema）、`DIGEST_CONFLICT`、`UNSAFE_PATH`、`IO_ERROR`。它们是**工具动作的返回值**，直接回给 Uina，永远不进程序；程序里只会见到 13 个能力码与 `PROGRAM_*`。`NOT_FOUND` 两处同名，但出现的位置不同（工具回执 vs 段内 `CallError`），不需要靠猜。

### 4.2 保存时工具做什么

`save` 有两条入口，落盘前都走同一步「规范化头 + 原子写」。

**A. 从运行段保存**（`{name, summary, from:{run,segment,call}}`）：

1. 校验名字、`summary` 非空、长度上限。
2. 由调用记录找到那次调用的源码摘要，从 `runs/<run>/sources/<hex>.js` 读**当时执行的字节**（不是重读工作文件）。
3. 剥掉源码里已有的 `// uina` 行，按参数生成新的头（一行 JSON；`saved` 写成 `{run, segment, call, digest, at}`，其中 `digest` 是**执行时**的源码摘要）。
4. 写临时文件 → `rename`（单文件，原子）。
5. 返回 `ProgramSummary`，其中 `digest` 是**落盘文件**的摘要。两个摘要不同是正常事实：头被规范化了，脚本体一个字节没动。

**B. 直接给源码**（`{name, summary, source}`）：先 `validate`（只编译；语法错报 `PROGRAM_INVALID` 并带行列），再按参数重写头、写临时文件、`rename`。这条路不要求先跑一次，适用于拷贝或改写现成代码。

`update` 做同样的规范化：保留未在参数里出现的旧字段，重写头。**模型永远不需要写头注释语法**——它只提供字段。

保存就是写一个文件。除了头规范化（模型不该手写元数据）与原子写，没有候选、没有审批、没有发布记录。

### 4.3 修改与正在跑的段

- 段内**第一次**解析某程序名时固定字节；本段后续同名调用复用同一份，即便磁盘文件已经改了。
- 下一个段重新解析，看到的是当前文件。
- 想在一次执行中途用新版：开新段（`decide` / 重新 `run`），或复制成新名字。
- 为什么固定：模型看到两次 `mc.call("wood_pick")` 会假设同一个实现。固定只在段内，不引入版本系统，也不需要发布。

### 4.4 发现

`list` 返回摘要，`get` 返回源码。模型学一个程序的路径是：**调用**（输入契约对得上）或**读源码改写**（世界不同）。后者不需要先把程序参数化到完美，是学习成本最低的复用。

### 4.5 质量从哪来

不靠认证，靠四件事：

1. `summary` 说清假定（"附近需要有橡树"），`save` 时强制。
2. 学到的结论直接落进代码或默认值（"半径改 12"），而不是在源码旁边攒旁注；为什么这么改，写一条 Experience 指向这个程序。
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

- **准入时机**：段内第一次需要执行域时。顶层程序段在入场；原生段在第一次调用程序时（惰性）。
- **准入两级**：
  1. 段**已经有域** → 直接复用，不参与域容量竞争（程序调程序、程序调原生、原生调程序都在这一档）。
  2. 段**还没有域** → 申请一个域。有空槽就立即进入 `active`；没有空槽则看一个**内部布尔** `mayWait`：
     - `mayWait=false`（该调用谱系此刻持有 BodyScope）→ 立即 `PROGRAM_CAPACITY`。hint 说"先退出 `withBody` 或停掉在跑的程序"。**不排队**。
     - `mayWait=true` → 排队（段状态 `queued`，`runs` 与 `capacity()` 都看得见）。
- **`mayWait` 为什么必须存在**：持着身体排队 = 占着一个别人可能要用的资源去等另一个资源。占着域的段可能正好在等这个身体，两边都不让 → 资源互等，而且会一直挂着而不报错。这个判据只出现在"段的第一个域"这一刻，是 Runtime 内部的一个布尔（`open({..., mayWait})`，由 Runtime 按调用谱系是否持 BodyScope 填），**不是模型参数，也不产生新的学习负担**。
- **有了它，原生的组合能力不必被砍**：原生能力可以在自己持身体时调用程序（`fight@1` 里跑一段玩家策略、`build@1` 里跑一段放置脚本）。早先版本为了"证明"容量安全而禁止这条路径，是拿表达能力换内部简单，不划算。代价只有一句：此时若域已满，那次调用会立刻拿到 `PROGRAM_CAPACITY`，而不是悄悄排队到天荒地老。
- **粒度是段**：段内新调用、程序调程序，都复用本域，不再向域外准入。
- **域的上限**：`program.maxDomains`，默认 4（单域实测 RSS 约 60 MB；满载数字见 §8 阶段 4 的压测，不拿单域数字外推）。
- **域内的 guest 上限：满就拒绝，绝不排队**。`program.maxGuestsPerDomain`（默认 8）限制同一域内同时活动的 QuickJS 运行时数（一个调用一个）。超出时新调用立即得到 `PROGRAM_CAPACITY`（`source:"environment"`，hint："并发太多，把 `Promise.all` 拆成每批 N 个，或改成顺序循环"），**没有等待队列**。
  - **为什么必须拒绝而不能等**：一个域内，等待者是"已经占着 guest 槽位、正在等子调用返回"的调用。若子调用也要槽位，队列就变成"所有槽位被等待者持有，而被等待者永远进不来"的环。`maxCallDepth` 拦不住它（环可能只有三层：`root → 7×child → grandchild`）。这类环不需要依赖图才能消除，只需要一条禁令：**任何等待都不得以"同域里被其他等待者占着的资源"为对象**。
  - 由此得到一条可检查的不变量：**域内没有等待边指向尚未分配的 guest**。guest 只在"立即分配成功"时创建；等待边只指向已经存在的 guest（父等子），或宿主/世界（可见的 `waiting`）。等待图是有限树，叶子必然在运行或在等宿主，不会自锁。
  - 拒绝是**可重试**的：这次调用没有执行、没有副作用（调用方原生能力可能已经有效果，见 §5.4 的记账规则），把并发降下来重试即可。
- **每个 guest 的在途宿主 RPC 有界：满就拒绝，不排队**。`program.maxPendingRpcsPerGuest`（默认 16）限制**一个调用**同时挂起的宿主 RPC 数（`call`/`read`/`watch`/`sleep`/`body.*` 都算，`log` 不算）。计数复用已有的 RPC promise 表：发起时 `+1`、结算时 `-1`；超限立即 `PROGRAM_CAPACITY`（`source:"environment"`，hint："一次派发太多，分批 `await` 或用 `Promise.allSettled` 每批 ≤16"）。
  - **为什么 guest 内存上限兜不住它**：`for (…) requests.push(mc.read(…)); await Promise.all(requests)` 只有一个 guest、guest 堆里只是 10000 个 promise 对象（几 MiB，远不到 32MiB 就发完了），而宿主侧同时接到 10000 个读取任务、10000 个返回值缓冲、10000 条待泵消息。等 guest 触发 OOM，宿主早已被压住——**内存上限管的是 guest 的堆，不是宿主的队列**。
  - **为什么不引入第二轮死锁**：因为这里没有队列。槽位只在"立即派发成功"时占用、结算即释放；父调用的 RPC 占着槽位等子调用、子调用要发新 RPC 时，父调用本来就还在等——环仍然可能出现（父占满 16 个、每个都在等子），所以规则同样简单：**满了就报错，让程序自己分批**，而不是让域替它排。报错可重试，且这次调用尚未执行。
  - 取消照旧：已在途的 RPC 按 §5.4 结算并记账，不因为 guest 被 dispose 就丢。
- **`guestMemoryBytes` 是每个 guest 的 QuickJS 堆上限，不是预留、不是进程 RSS**。理论上限（4 域 × 8 guest × 32 MiB = 1 GiB）是天花板，不是常态：一个典型程序的实际堆在几 MiB，最大的一次单值也只有 1 MiB。附录 B 的 62MB 是"一个 worker + 一个运行时"的实测 RSS，不能乘以 4×8 当估算。阶段 4 的验收专门测满载并记录峰值 RSS（场景见 §8），若超过约 1.5 GiB，就把 `maxGuestsPerDomain` 的默认值降下来——**调一个策略参数，不引入跨 guest 的内存账本**。
- **取消与停止要清干净**：该调用在域内的挂起项、在途 RPC、待泵的消息一并撤销；已经派发的宿主操作照常结算并记账（§5.4），不因为 guest 被 dispose 就丢。
- **可见性**：`capacity()` 返回实时观察值 `{observedAt, limit, occupied, queued, entries[{run,segment,state,requestedAt,activeAt?,guests?}]}`，`runs` 状态直接用它显示"排队中/执行中"。
- **崩溃**：worker 死 → 在册调用全部 `PROGRAM_CRASH`（source=environment），容量释放，段失败；下一次运行由新段重新 `open`。

### 5.3 预算

| 名称 | 默认 | 触发后 | 理由 |
|---|---|---|---|
| `guestMemoryBytes` | 32 MiB | 该调用 `PROGRAM_MEMORY`（call 级） | QuickJS 硬上限，干净失败；典型程序的实际堆在几 MiB |
| `computeBurstMs` | 20 | 该调用 `PROGRAM_TIMEOUT` | **一次**连续解释时间（从入场或上一次宿主 RPC 起算，有 RPC 即重置）。同一 worker 里通常还有别的 guest 在跑 `body.loop`：MC 一个 tick 50ms，5 秒 = 100 tick，那几秒里兄弟 guest 的反馈全断。这个预算管的是**同域实时性**，不是"这个大不大" |
| `computeTotalMs` | 60000 | 该调用 `PROGRAM_TIMEOUT` | 该调用**累计**解释时间。管的是**总消耗**——`while(1){ 算 4 秒; await mc.progress() }` 每轮都在 burst 里，只有累计量能收住它 |
| `maxSourceBytes` | 64 KiB | `PROGRAM_INVALID` | 源码是模型写的，超过这个量级通常是循环生成 |
| `maxValueBytes` | 1 MiB | `PROGRAM_VALUE` | input / 返回值 / 单个 RPC 参数的 JSON 上限 |
| `consoleBytes` | 16 KiB | 截断并标记 | 控制台环形缓冲，保留最后一段 |
| `maxCallDepth` | 8 | `PROGRAM_DEPTH` | 程序调程序的上限 |
| `maxPendingRpcsPerGuest` | 16 | 该调用 `PROGRAM_CAPACITY` | 单 guest 在途宿主 RPC 数（§5.2）。结算即释放，**没有等待队列** |
| `retireGraceMs` | 1000 | 记 `unknown` | terminate 后等 `exit` 的证明窗口 |

两个计算预算不能合并：只有 burst 时，反复短 RPC 的忙循环可以永远跑；只有 total 时，一次正常的长计算和一帧反馈无法区分，实时性没有保证。它们在同一个中断回调里就是两次比较，不引入新机制。60 秒不是正确性边界，是策略值：真实的 `body.loop` 跑十分钟，每帧亚毫秒，累计也就十几秒。

**20ms 是"同域实时性"的预算，不是"程序该干多少活"的预算。** 一个 worker 里所有 guest 共享一条线程，QuickJS 没有协程级抢占：中断回调只能**终止这次计算**，不能让出后恢复。所以"让调度器弥补过大的 burst"这条路不存在，burst 必须自己足够小——20ms 是初值，阶段 4 用两件事校准：兄弟 guest 的反馈帧时延 p95（须 < 50ms）与正常程序的直接放行率（不许大量程序因为计算量被判超时）。方向是先保实时性：**卡住兄弟 guest 的反馈是可见的功能故障，而一次超时是可重试的显式失败**。

需要更多计算的程序有唯一的正当出路：**自己分片**——`await mc.sleep(0)` 让出 worker 事件循环，并让 burst 计时从零开始（它就是一次宿主 RPC）。所以写长计算时这样切：

```js
for (let i = 0; i < 5000; i++) {
  work(i);
  if (i % 500 === 0) await mc.sleep(0);   // 每 ~10ms 让一次；别写成 while(true)
}
```

真正重量的循环不该待在程序里：`region`/`build.plan`/`route.plan` 这些计算在宿主侧做，程序只负责组合。

预算在域内强制（QuickJS 上限 + 中断回调 + 每次 RPC 的字节检查），不依赖 guest 配合。取消标志与起算时间放在 `SharedArrayBuffer` 上：主线程用 `Atomics.store` 写，worker 里 QuickJS 的中断回调用 `Atomics.load` 读——**guest 在同步死循环时 worker 的事件循环是停的，任何"发消息让 worker 取消"的做法都不成立**，只有共享内存 + 中断回调能打断它。

**空闲不等于免费。** 程序 `await` 一个永不结算的 promise（`import("node:fs")`、悬挂的 `new Promise(() => {})`）时 CPU 为零，但它仍占着一份 QuickJS 运行时、几十 MB 内存和一个域容量：四个域都被这类调用占住，后面的任务就只能在队列里等。所以不设墙钟超时（合法程序也会有数分钟的静默：长途移动、炼炉、等夜晚），但**等待必须可见**——`runs` 的 `waiting` 四种 `kind`：

| kind | 判据 | 主脑该做什么 |
|---|---|---|
| `host_call` | 有在途宿主 RPC（`call`/`query`/`body.*`） | 看 `progress`，等 |
| `world_change` | 停在 `awaitChange` | 看 `unknown` 与剩余时间，等或换目标 |
| `sleep` | 停在 `mc.sleep` | 等 |
| `idle` | 没有任何在途 RPC，guest 也没在跑（悬挂 promise） | 唯一可疑的一类：看 `idleMs`，决定 `stop` |

`waiting: {kind, method?, sinceMs}` 由域根据最后一次挂起的 RPC 方法名算出，不需要额外状态；`runs` 同时给出 `idleMs`。回收与否是主脑的判断，程序不自动杀。

### 5.4 取消、decide、退役

取消要分开两件事，混起来必然丢事实：**取消 guest 的等待**（快，< 50ms）与**结算已经派发出去的世界操作**（可以慢，而且必须留痕）。

1. Runtime 关闭该调用的 RPC 准入并 abort `signal`：从现在起，这个调用不会再派出任何新的世界操作。
2. **已经派发的，不撤也不丢**。Runtime 继续接收它们的回执并记账：确认的进 `EffectRecord`，无法确认的标 `dispatch: "sent" | "unknown"` 并计入 `unknownEffects`。迟到的回执**不再交给 guest**（它正在被拆），但**必须进入记录**——"程序被取消"不等于"方块没被挖掉"。
3. 主线程置该调用的中断标志（`Atomics.store`）：正在同步执行的，QuickJS 中断回调立刻结束它；停在等 RPC 的，直接 `dispose` 它的运行时、永不恢复。两者都**不等 guest 收尾**（`catch`/`finally` 可能不跑，这是设计选择：退出不依赖 guest 合作）。只有整个域退役、或标志 50ms 未生效时才 `terminate()` worker——那会连同该域其它在册调用一起取消，所以它是域级手段，不是取消一个调用的默认路径。
4. 结算分两层：**guest 侧调用**立刻以 `CANCELLED` 结束（这是调用者的结果）；**世界侧**按第 2 步的事实异步收尾。`cancelSettleMs`（默认 1000）内仍未确认的操作标 `dispatch: "unknown"`，Run 从 `stopping` 进 `finished` 时带着非空 `unknownEffects`——`cancelled` 与"世界可能变了"同时成立，两个都必须出现在快照里。
5. **迟到证据写在效果记录上，不重开 Run**。每条已派发操作在派发时就拿到稳定的 `effectId`；`EffectRecord.completion` 是被后续事实**修订**的字段（`unknown → met | not_met`），`evidence` 只追加。`unknownEffects` 存的是 `effectId` 列表而不是计数，所以 Run 终态之后 `readEffect(effectId)` 仍会给出"那次挖掘其实成功了"。Run 的 `outcome` 不变（它就是 `cancelled`），变的只是效果的解释——这正是"未知"该有的样子：不假装知道，也不丢掉后来知道的。不需要重开 Run，也不需要新的状态机。

**正常返回同样是收口。** `main` 返回时可能还有没 `await` 的调用在跑：

```js
mc.call("mine@1", { at });    // 没 await
return { done: true };
```

这里不需要第二套机制：Runtime 对 CallScope 的关闭算法对"正常返回、取消、父调用失败"是同一个——封闭新准入 → 在途调用各自结算（拿到结果就记账，过了 `cancelSettleMs` 未确认则 `dispatch: "unknown"`）→ 效果屏障 `flushThrough` → 释放 BodyScope，**且不早于控制撤销屏障**（否则新主人会看到旧主人的按键）。区别只在结论：`main` 正常返回 ⇒ 这次调用 `succeeded`；它没等的子调用可以独立地是 `failed`、`cancelled` 或 `unknown`，两者不互相覆盖。`Promise.race` 输掉的那一支同理：进程不等它，但账照记。

**但"父成功"不能被读成"全都成了"**。所以收口时把被抛下的调用列出来，随结果一起返回：

```js
// 返回值
{ done: true, misplaced: 1 }
// run 摘要（模型看到的）
✓ wood_pick · 完成 · 2.4s
  另 1 个调用未被等待：mine@1 失败（UNREACHABLE，第 12 行）
```

`RunSnapshot` 在 `finished` 相里增加 `orphans: Ref[]`（被抛下的子调用 id，通常为空）。**只放 id，不放结局**：`CallRecord` 已经有 `outcome`/`code`/`line`，摘要与 `readCall` 都从那一份记录取——两处各存一份结算事实迟早对不上。它们不是失败：Run 的 `outcome` 仍是 `succeeded`；但模型必须看得见"我扔掉的这件事没成"，否则它会以为世界已经变成自己想象的样子。行号之所以要在记录里，是因为那条 `mc.call` 就在那里写着，只是少了个 `await`。这份列表在快照时从 `CallRecord` 现算（`parent` 指向本次调用、且还没有结束状态的子调用），**不单独持久化**：它只是同一份记录的一个视图。

同一条规则适用于所有会让调用提前结束的路径（`decide`、父调用失败、段关闭）：**取消的是等待，不是已经发生的事**。段记录与调用记录里的效果、`unknownEffects`、`dispatch` 不因为取消而清空；这也是下一次决策唯一的依据。

**decide**（`mc.decide({reason, checkpoint})`）把决定权交还主脑，**只在根调用里成立**：

1. 该 RPC 与其他 RPC 同路径转给 Runtime；Runtime 核对"发起这个调用的，是不是本段的根调用"。
2. 是根：封闭段准入 → 取消兄弟调用（同样分两层：先停等待，再结算已派发的操作）→ 等效果屏障 `flushThrough` → 固定可序列化 checkpoint → 撤销控制 → 记录 decision → 要求 Program 退役该段（`retire("decide")`：拒绝新调用、在册调用全部 `CANCELLED`、`terminate` worker、等 `exit`）。段进 `awaiting_decision`，等 `runs continue` 开新段；`decide` 的 promise 永不结算。
3. 不是根：立即抛 `DECIDE_NOT_ROOT` 给 guest（可 `catch`），**什么都不改变**。子程序想交还，就 `return` 一个讲清楚的值，由调用它的程序决定怎么办——这正是普通 JS 的组合语义。

为什么保留、但要砍掉非局部性：删掉 decide 能省下 `awaiting_decision` 相、checkpoint 与 `continue`，但长时间任务中途交还就只剩"返回并让主脑重新 run"——差别是 Run 身份与累计进度（一次二十分钟的挖矿中途交还，重新 run 会丢 `progress` 曲线和调用归组）。而关闭/退役这套机制本来就为 `stop` 存在（§5.2），decide 只是换触发者和结论，机制不新增。真正该削的是"任意深度的子调用都能打断父任务"：那让被调用的程序可以悄悄改变调用者的生命周期，与普通函数的组合语义直接冲突。所以留下交还能力，砍掉非局部性。

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

- `version` 是宿主生成的不透明令牌，语义只有一条：**同版本 ⇒ 这些值不会变，而且"能不能看见"也不会变；这两者任一变了 ⇒ 版本必变**。程序不解释它，只回传。
- **只有有观察游标的查询能等**。`feedback:true` 的八个查询（`self`/`inventory`/`block`/`blocks`/`region`/`entities`/`world`/`places`）由 World 与 Driver 的变更流推进 `version`；`item`/`recipe` 是静态数据，`route.plan`/`build.plan` 是派生计算，`container.last` 是历史视图——它们没有"变了就通知"的游标，`mc.read` 返回 `version: null`，`waitForChange` 直接 `INVALID_INPUT`（hint：重读，或等它依赖的基础查询）。**不给派生查询建响应式依赖图**：为了 `build.plan` 的无漏唤醒，就得追踪蓝图、材料、世界几何的整条依赖链，那是把 World 变成通用计算框架，代价远大于"睡 200ms 再读一次"。
- 因此它**不能取物理帧号**：每一帧都推进的序号会让"等背包变化"每帧唤醒。版本必须对应这些值的修订位置——World 目标用它本来就有的观察游标（`ObservationCursor`，带 `stream`/`epoch`/`sequence`）；`self@1`/`inventory@1` 这类事实用 Driver 在**内容变化时**推进的修订。这对 Driver 是一句要求：事实流的序号按内容推进，不按采样推进；能满足就直接复用现有 `Fact`，不新建版本管理器。
- **覆盖变化也是变化**：一个目标从"有值"变成 `unknown`（走远了、区块卸了）或反过来，`version` 必须推进并唤醒等待——否则等待会睡在一个再也不会更新的版本上。推进时 `unknown` 里如实给出原因，判定函数拿到第二个参数自己决定（§3.2）。这与"世界数据变了"是两件事，但都走同一个版本通道；区分交给 `unknown`，不交给 `kind`。
- 宿主的 `watch(targets, since)` 先比对**当前**位置与 `since`：任一不同，立即做一次新的读取并返回 `changed`；全部相同才订阅。订阅后再有任何变化都会唤醒（World 的 `read → watch` 原子比较合同，`contracts/world.ts` 的 `watch(query, after, signal)`）。
- 因此"读到旧值 → 条件不满足 → 订阅"之间不存在丢失窗口：变化要么让 `since` 立刻变旧（下次比对发现），要么在订阅之后被送达。
- **代次失效不是变化**。`epoch` 变（断线重连、世界或 Driver 重新激活）时，旧 `version` 属于已经不存在的观察空间，不能继续按数值比较——宿主直接结算 `{status:"invalidated", reason}`（**不带 values/version**），让程序重读。把这种情况伪装成 `changed` 或一直等到 `timeout`，都会把"世界换了"变成"世界没变/变了"的错误结论；硬凑一组"当前值"则会让重连瞬间的空白被当成世界状态。
- 多目标：每个目标各自维护位置，任一变化即唤醒，返回整组新值与整组 `unknown`。

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

下表是这一轮对周边文档与合约的要求，**已全部落地**；若与某文档正文有出入，以该文档正文为准（本表是追溯用）。

| 文件 | 变更 |
|---|---|
| `public-api.md` §4 | Program 侧 `body.*` 不降级：`drive` 返回实际 tick 与结束状态，`dig`/`attack`/`useItem`/`interact` 返回 `EffectReceipt`，`interact` 保留 `hand/face/cursor`；`Window.click` 的 `expectedRevision`+`expectedSlots`+`expectedCursor` 三项强校验保留，由句柄从快照推出而不是要求模型填写 |
| `public-api.md` §5 | `EffectRecord.completion` 可被迟到事实修订（`unknown → met/not_met`），`evidence` 只追加；`unknownEffects` 是 `effectId` 列表而不是计数 |
| `public-api.md` §7 | `RunSnapshot` 的 `finished` 相增加 `orphans: Ref[]`（被抛下的子调用 id；结局只在 `CallRecord` 里有一份） |
| `public-api.md` §5（查询事实） | `version` 的语义扩为"值与可观察性任一变化都推进"；`unknown` 随值一起返回，等待的判定函数拿得到 |
| `public-api.md` §6 | 删 `mc.wait`/`WaitRequest`/`WaitConditionDef`/`ConditionCheck`/`CompletionCheck`/`mc.checkpoint`；**保留 `mc.read` 但改形状**为 `{value, version, unknown?}`（查询专用）；新增 `mc.sleep`/`mc.waitForChange`/`body.call` |
| `public-api.md` §6.3 | 删 `ProgramDefinition` 的 `dependencies`/`bindings`、`ProgramBinding`、`nativeEnvironment`/`effectiveBindings`；程序改为单文件 + 头注释 + `main` 入口 |
| `public-api.md` §7.1 | `ProgramExecutionPort` → `ProgramPort`（§7）；`invoke` 的 `api` 改为 §7 的扁平 RPC；`ProgramCapacity` 状态集为 `queued/active/retiring/unknown`；`ProgramExecutionFailure` 的 `reason` 换成 §7 的 `code` + `source` + `hint` |
| `assets.md`（已改为 Library）§5 / §7 | Program 不再是 asset kind；`publishFromRun` → `library.save`；`ProgramManifest`/`sourceForm` 不再存在。该文件的仓库机制（SQLite 目录、不可变包、发布 CAS、证据副本）一并删除，蓝图/经验改为文件约定 |
| `runtime.md` §9 | 引擎定为 worker + QuickJS-WASM；容量按段准入：段还没有域且无空槽时排队，持身体却无域时立即 `PROGRAM_CAPACITY`；段内所有调用复用本域；资源失败降为 call 级 |
| `runtime.md` §10 | 删 `WaitConditionDef`/`mc.wait`/条件注册；`waitForChange` 改为「`read` 返回观察版本 + `watch` 原子比较」，判定函数留在 guest |
| `runtime.md` §11 | 不变，但快照由 Program 写、写在调用级（`sources/<sha256>.js`），记录只存 ref + digest；取消时已派发操作照常结算，不得因 guest 结束而丢效果记录 |
| `runtime.md` §8 | 身体继承只由委托决定，与 Callable 是原生还是程序无关：`mc.call` 独立申请、`body.call` 继承、一次一个委托（`BODY_BUSY`） |
| `contracts.md` §5.3 / §5.4 | 删 `mc.wait` 条件注册与 `WaitConditionDef`；容量准入改为按段：同段复用、跨段排队，持身体且无域时立即 `PROGRAM_CAPACITY`；无漏唤醒由 `mc.read` 返回的观察版本 + `watch` 原子比较承担 |
| `contracts/body.ts` | `ControlInput` 增加 `lookAt`；`BodyOps` 增加 `lookAt`；`body.dig` 收 `position`；新增句柄方法 `body.call`：把当前 BodyScope 委托给任意 callable（原生或程序），委托期间本调用句柄挂起 |
| `contracts/executor.ts` | `Entry` 的第二支改为 `{kind:"program", source: SourceRequest, input}`（`source` 是 `{name}` 或 `{code}`，与 `run` 的两种入口一一对应）；`SegmentRecord.entry` 分 `native`（descriptor + digest）与 `program`（name/origin/digest/snapshot），不再有 `nativeEnvironment`/`effectiveBindings`；`CallRecord` 记 `implementation`/`digest` 与父子关系，结局只在这里有一份 |
| `contracts/world.ts` / Driver 事实 | 读 RPC 需要能给出"这组值对应的观察位置"：World 用 `ObservationCursor`；事实类用 Driver 在**内容或可观察性变化**（含 known↔unknown）时推进的修订号——不能取物理帧序号（否则每帧唤醒），能直接复用现有 `Fact` 就复用，不新建版本管理器 |
| World 入口（`worlddef`） | `run` 收 `{name, input}` 或 `{code, input}`；`library` 五 op（§4.1） |
| Driver / World | 采用 §3.4 的命名与完成口径；能力自带身体；新增的能力不需要 Program 改代码 |

---

## 7. 类型与端口

```ts
// ── 宿主看到的全部 Program 接口 ──────────────────────────────
interface ProgramPort {
  resolve(source: SourceRequest): Promise<ResolvedProgram>;   // 只读：名字→文件字节，code→直接字节，都算摘要
  validate(request: { source: string; filename?: string }): ProgramValidation;  // 静态，不执行
  open(request: OpenRequest): Promise<OpenedSegment>;
  writeSnapshot(request: { run: string; program: ResolvedProgram }): Promise<SnapshotRef>;  // 幂等：同 run 同摘要同路径
  readSnapshot(request: { run: string; digest: string }): Promise<{ source: string; path: string } | null>;
  list(query?: { text?: string; tag?: string; limit?: number }): Promise<ProgramSummary[]>;
  get(name: string): Promise<ProgramDetail | null>;
  save(request: SaveRequest): Promise<ProgramSummary>;
  update(request: UpdateRequest): Promise<ProgramSummary>;
  delete(name: string): Promise<void>;
  capacity(): ProgramCapacity;
}

/** 一次调用的材料来源；两种都解析成同一份确切字节。
 *  叫 SourceRequest 而不是 ProgramSource：它描述的是"要什么"，不是"源码本身"。 */
type SourceRequest =
  | { name: string }      // 库里的程序文件
  | { code: string };     // 工具入口 `run {code}` 的临时代码

interface SnapshotRef { digest: string; path: string }

interface ProgramSummary {
  name: string; summary: string | null; tags: string[];
  digest: string; updatedAt: string; path: string;
}
interface ProgramDetail extends ProgramSummary {
  source: string; input?: JsonSchema; headerError?: string;
  savedFrom?: { run: string; segment: string; call: string; digest: string; at: string };
}

type SaveRequest = {
  name: string; summary: string; tags?: string[]; input?: JsonSchema;
  source: string;                      // from 由 Executor 解析成确切字节后传入
  savedFrom?: { run: string; segment: string; call: string };
};
type UpdateRequest = {
  name: string; source?: string; summary?: string; tags?: string[];
  expectedDigest?: string;             // 与当前文件不符 → DIGEST_CONFLICT
};

interface OpenRequest {
  run: string; segment: string;
  program: ResolvedProgram;            // 已解析材料：名字与临时代码在这里合流
  snapshot: SnapshotRef;               // 已写入的运行级快照（resolve 时还不知道 run，所以是两步）
  mayWait: boolean;                    // 该调用谱系此刻是否持 BodyScope；false 时容量不足立即失败，不排队（§5.2）
  signal: AbortSignal;
}
interface OpenedSegment {
  resolved: ResolvedProgram;
  domain: ProgramSegmentDomain;
}

interface ResolvedProgram {
  name: string | null;                 // 临时代码为 null
  origin: "library" | "code";
  source: string; digest: string; summary: string | null;
}

interface ProgramSegmentDomain {
  readonly state: "active" | "retiring" | "dead";
  resolve(name: string): Promise<ResolvedProgram>;   // 段内 singleflight：缓存 Promise，失败驱逐
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
             requestedAt: string; activeAt?: string;
             guests?: number }[];
}

/** 静态校验：同一个 QuickJS 以 compileOnly 编译同一份字节（不执行、不接触世界），诊断与执行期同源 */
type ProgramValidation =
  | { ok: true; digest: string }
  | { ok: false; code: "PROGRAM_INVALID";
      reason: "syntax" | "encoding" | "size" | "header";
      message: string; line?: number; column?: number };

// ── guest → 宿主：扁平 RPC，无函数值 ───────────────────────────
type WatchResult =
  | { status: "changed" | "timeout"; values: Record<string, JsonValue>;
      version: string; unknown: Record<string, string[]> }
  | { status: "invalidated"; reason: string };

interface ProgramHostApi {
  call(input: { selector: string; args: JsonValue; delegateBody?: boolean }): Promise<JsonValue>;
  read(input: { targets: Record<string, { ref: string; input?: JsonValue }> })
    : Promise<{ values: Record<string, JsonValue>; version: string | null; unknown: Record<string, string[]> }>;
  watch(input: { targets: Record<string, { ref: string; input?: JsonValue }>;
                 since: string; timeoutMs: number })
    : Promise<WatchResult>;
  sleep(input: { ms: number }): Promise<null>;
  progress(input: { value: JsonValue }): Promise<null>;
  decide(input: { reason: string; checkpoint?: JsonValue }): Promise<never>;
  acquireBody(input: {}): Promise<HandleRef>;
  releaseBody(input: { handle: string }): Promise<null>;
  handleOp(input: { handle: string; op: string; args: JsonValue }): Promise<JsonValue | HandleRef>;
  closeHandle(input: { handle: string }): Promise<null>;
  log(input: { level: "log" | "info" | "warn" | "error"; text: string }): Promise<null>;
}

// guest 侧看到的等待结果（shim 把 watch 的 status 映射成 kind）
type WaitResult<T = Record<string, JsonValue>> =
  | { kind: "met" | "timeout"; values: T; version: string; unknown?: Record<string, string[]> }
  | { kind: "invalidated"; reason: string };        // 没有 values/version：旧观察空间已经不存在
```

RPC 十一条，全部一进一出。新增能力不会新增 RPC，只可能新增句柄种类或 `op` 名。`mc.read` 与 `mc.waitForChange` 都不是 RPC：前者是 `read` 的薄包装（单目标时给 `value`），后者是 shim 里约 12 行的循环（`read` → `predicate` → `watch` → 重判），判定函数因此可以闭包任意 guest 状态，也不需要任何条件注册。

失败码 → source 与建议：

| code | source | 建议模板 |
|---|---|---|
| `PROGRAM_INVALID` / `PROGRAM_ERROR` / `PROGRAM_VALUE` / `PROGRAM_MEMORY` / `PROGRAM_TIMEOUT` / `PROGRAM_DEPTH` | program | 改代码（看行号与栈） |
| `PROGRAM_INPUT_INVALID` / `SELECTOR_INVALID` / `PROGRAM_NOT_FOUND` | input | 改参数或先 `list`/`describe` |
| `PROGRAM_CRASH` | environment | 停止并报告；重启新段 |
| `PROGRAM_CAPACITY` | environment | 三种来源：段持着身体且没有空域（先退出 `withBody` 或停掉在跑的程序）；同域活动 guest 已满（把 `Promise.all` 拆成每批 N 个或改顺序循环）；单个 guest 的在途 RPC 已满 16（改分批，或 `Promise.allSettled` 收齐）。**只保证这次程序调用没有执行**——调用它的原生能力可能已经产生了效果，那些效果照常进 `CallRecord`/`EffectRecord`（§5.4）。降低并发后重试 |
| `PROGRAM_RETIRED` / `CANCELLED` | environment | 等待或重新提交 |
| 能力返回的错误 | 能力自报 | 换策略/改世界后重试；同一调用重试通常无用 |

另有一类错误不进 `ProgramFailure`，由 shim 或 Runtime 直接抛给 guest，程序可以当场 `catch`：

| 码 | 何时 |
|---|---|
| `USE_MC_READ` | 对查询能力用了 `mc.call` |
| `USE_MC_CALL` | 对动作能力或程序用了 `mc.read` |
| `BODY_SCOPE_ACTIVE` | 调用方持有 BodyScope 却用 `mc.call` 调需要身体的能力（改用 `body.call`）；或持身体时调 `mc.sleep`/`waitForChange`（先退出 body） |
| `BODY_BUSY` | 同时请求第二个 `body.call` 委托，或同一调用同时申请第二个 BodyScope |
| `BODY_SUSPENDED` | 委托期间用调用方挂起的 `body` 句柄执行 `drive`/`apply` |
| `STEP_ASYNC` | `body.loop` 的 `step` 返回了 promise |
| `WINDOW_CLOSED` | 对已关闭/已脱离 body 的窗口操作 |
| `ACCESS_DENIED` | 读能力里试图产生副作用 |
| `PREDICATE_INVALID` | `waitForChange` 的判定函数返回了 Promise 或非布尔值 |
| `DECIDE_NOT_ROOT` | 子程序（本段的非根调用）调用 `mc.decide`。要交还就 `return` 一个讲清楚的值，由调用它的程序处理 |

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

### 阶段 0：真实玩法验收（主线，先于一切压测）

**这一节定义"做完了"，下面四阶段是它的支撑证据。** 全部跑在真实的 mineflayer 客户端与真实服务器上（不用 FakeClientBot），每条都要留下运行记录、截图或录像，以及 `runs` 里可复查的调用树。

| 场景 | 验证什么 | 通过标准 |
|---|---|---|
| 从零取得木镐 | 查询 → 采集 → 合成 → 部分失败恢复 | 程序自己完成"找树、砍够原木、合木板、合木棍、合工作台、合木镐"；中途缺料/没树时以可读失败结束或自行换目标，不静默成功 |
| 自动采矿并回基地 | 导航、资源观察、工具使用、避险 | 下矿 → 挖到目标矿物 → 回地面 → 回基地箱；至少一次遇到岩浆/悬崖/怪物时做出正确反应（绕开、撤退或战斗），且 `runs` 能说清当时看到了什么 |
| 自动建小屋 | 蓝图、算料、放置、完成核验 | 按 `build.plan` 算料 → 缺料时去补 → 按 `build` 完成 → 用 `read block`/`region` 复验结构；有 `remaining` 时必须如实报"没放完" |
| 整理箱子与熔炉 | 窗口操作、状态冲突、物品流转 | 打开容器、批量转移、熔炼；期间玩家/自身背包变化导致的 `CONFLICT` 被正确处理（重新快照后重试），不出现物品丢失 |
| 自主探索、遇敌撤退 | 实时反馈、风险决策、身体控制、交还主脑 | `body.loop` 控制下的探索与逃跑；血量低时正确撤退；需要新计划时用根级 `decide` 交还，`continue` 后能重读世界继续 |

这五个场景里**任何一个跑不过，就不算 Program 可用**——无论压测多干净。反过来，压测的意义只是解释"为什么某个真实场景在边界上会失败"。

### 阶段 1：库与格式

验收：两个手工程序能被 `list` 按更新时间列出；`get` 返回逐字节源码与头字段；`save` 重名报 `NAME_EXISTS`；`update` 能改源码与摘要且保留未改字段，`expectedDigest` 不符时报 `DIGEST_CONFLICT` 且不落盘；重名目录冲突在 `list` 里标出；`save {from:{run,segment,call}}` 取到该次调用的字节**且返回的两个摘要（执行时 / 落盘）各自可复算**；快照按 `sha256` 落在 `runs/<run>/sources/` 且同摘要复用；非法文件名被拒；**符号链接/目录联接指向库外 → 被跳过并在 `list` 里标 `unsafe`，读取不越界**；摘要里含 `*/`、引号、换行的 JSON 值写入后文件仍是合法 JS 且 `parseHeader` 原样读回（`writeHeader`→`parseHeader` 幂等）；**`save`/`validate` 只编译不执行**（用一个顶层 `throw` 或顶层 `while(1)` 的文件证明：保存成功/只报语法错，进程里从未运行过它）。

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
13. 顶层写 `mc.call(…)` → `PROGRAM_ERROR`（`mc is not defined`），证明顶层拿不到宿主句柄；顶层 `while(1){}` → 预算内 `PROGRAM_TIMEOUT`，不是卡死。
14. 语法错误的 `{code}` → `PROGRAM_INVALID`，且 `capacity()` 的 `occupied` 前后不变（不开域、不排队）。
15. `validate` 与执行对同一份源给出同一诊断（同一个 QuickJS）：语法错的 `line` 等于执行期报出的行号；`run {code}` 的语法错在 `open` 之前返回，`capacity().occupied` 不变。
16. §3.7 的七个示例逐字跑通（FakeClientBot + 桩能力），并断言它们的返回值形态（`build` 的空 `remaining`、`body.loop` 的 `outcome`、容器遍历不越界）。

### 阶段 3：身体与反馈

验收（`tests/minecraft-driver-helpers.ts` 的 FakeClientBot 模型）：`body.loop` 跑 20 帧，帧序错乱或重复 apply 被拒；`withBody` 内 `mc.sleep` 报 `BODY_SCOPE_ACTIVE`；`body.call("子程序")` 内 `mc.withBody` 拿到同一 BodyScope、不二次 acquire；`withBody` 内 `mc.call("mine@1")` 报 `BODY_SCOPE_ACTIVE`（它要身体），而 `mc.call("纯计算或只读的子程序")` **正常执行**——判据是"要不要身体"，不是"是不是程序"；`mc.call("另一个内部会 withBody 的程序")` 进入后在自己的 `withBody` 处失败；`body.call("mine@1")` 则正常执行（委托对原生也成立）；`Promise.all([body.call(a), body.call(b)])` 中第二个 `BODY_BUSY`、第一个正常返回；委托期间对被挂起的句柄 `drive` → `BODY_SUSPENDED`；退出 body 时未关的窗口自动关闭。
取消相关：`mine@1` 派发后立即 stop → guest 侧 `CANCELLED`，但挖掉的方块仍出现在 `EffectRecord` 里；若无法确认，段的 `unknownEffects` 非空且 Run 不报"干净取消"。

### 阶段 4：容量、退役、decide、错误文本

验收：4 域占满后，第 5 个段停在 `queued`（`capacity` 里可见），第 1 段 `retire` 后它自动转 `active`；一段持身体时在域内再调程序不新申请容量（仍 `active`，`capacity.occupied` 不变）；**根原生调用持身体、且四个域全满时第一次调程序** → 立即 `PROGRAM_CAPACITY`（不排队，`runs` 不会出现"持着身体排队"），域空出后重试成功；**单段扇出 1000 个 `mc.call`**——分两种：扇出**程序**（每个要一个新 guest）→ 从第 9 个起 `PROGRAM_CAPACITY`；扇出**原生能力**（不占 guest 槽位）→ 从第 17 个在途 RPC 起 `PROGRAM_CAPACITY`（`maxPendingRpcsPerGuest`），两种情况都**不创建 1000 个运行时、不排队**；**自死锁回归用例**：`root` 并发 7 个 `child`、每个 `child` 再调 `grandchild`（8 个 guest 占满）→ 第 9 个调用立即 `PROGRAM_CAPACITY`；用 `Promise.allSettled` 收齐 7 个失败结果后正常结束（`Promise.all` 会在第一个拒绝时就整体拒绝，看不到其余六个），**不悬挂**（3 秒内 Run 进 `finished`）。

**四组压力场景**（阶段 4 必须都跑，缺一组就等于没测边界）：

| 场景 | 量什么 | 通过标准 |
|---|---|---|
| 常规满载：4 域 × 8 guest，每 guest 分配 12 MiB | 峰值 RSS | 记录实测值；> 约 1.5 GiB 则 `maxGuestsPerDomain` 降为 4 并写回本文 |
| 高压：单个 guest 逼近 `guestMemoryBytes`（分配 24–32 MiB） | 该调用失败形态与进程存活 | 该调用 `PROGRAM_MEMORY`，兄弟调用与进程存活，容量释放 |
| 宿主扇出：一个 guest 并发 1000 个 `read`/`call` | 宿主侧队列、内存、结算完整性 | 第 17 个起 `PROGRAM_CAPACITY`；已派发的 16 个全部结算并记账，无泄漏 |
| 实时性：域内 A 持续同步计算，B 跑 50ms 一帧的 `body.loop` | B 的**帧间隔 p95/p99** | p95 < 50ms（一个 tick）；超了就把 `computeBurstMs` 往 10ms 压，或把 `maxGuestsPerDomain` 降到 4 |

`retire` 得 `retired` 且容量归零；宿主侧强杀 worker 模拟崩溃 → `PROGRAM_CRASH`（environment）、进程存活、容量释放；`decide` 后段进 `awaiting_decision`、域已退役、`continue` 开新段能重读世界；失败文本包含行号、来源、已生效效果与 `hint`。

### 跨模块联调验收

上面四个阶段都能在 Program 内部测完。下面六条必须**同时**跑通至少两个模块，否则各自的测试全绿也可能合同不等价：

| 场景 | 期望 |
|---|---|
| 同一输入，顶层 `run {code}`、程序内 `mc.call`、保存后再调用 | 三者返回同一领域值，`sourceDigest` 各自可查 |
| 程序读某目标后宿主改世界，紧接着 `mc.read` | 两次 `version` 不同；`waitForChange` 拿旧 `version` 起等会立即 `met`（原子比较，与 World 的 `watch` 同一语义） |
| 能力调用派发后 stop | guest 侧 `CANCELLED`，同一次调用的 `EffectRecord` 仍出现真实效果；无法确认时 `unknownEffects` 里的 `effectId` 在 Run 终态后仍可 `readEffect` 并显示 `unknown` |
| `save {from}` 之后再 `run name` | 落盘文件摘要是 `digest`，`saved.digest` 是执行时摘要；两段源码逐字节相同（除头） |
| `mc.waitForChange` 恰好在判定与订阅之间发生目标变化 | 不丢唤醒（World 的 `read→watch` 原子比较合同） |
| 程序以 `PROGRAM_ERROR` 结束但已发生效果 | Run 的 `unknownEffects` 与 `effects` 与 `EffectRecord` 一致；程序侧返回的 `dispatch`/`effects` 不被采信 |
| 窗口：`snapshot()` 时光标为空，派发前光标被外部放了东西 | 普通点击 `CONFLICT` 且**不派发**；不会因为句柄取了实时值而变成另一次点击 |
| 等待：目标从 known 变 `unknown` | `version` 推进并唤醒，`predicate` 的第二个参数拿到 `unknown`；`kind` 不是 `invalidated` |
| 头：手工写坏 `// uina {…}` 后 `library.update` | 头被整体覆盖、脚本体逐字节不变；`list` 标 `headerError`，`run` 仍能执行 |
| 身体：`withBody` 内调用只读/纯计算程序 | 正常返回；同一程序内部真正 `withBody` 时才 `BODY_SCOPE_ACTIVE` |
| 资源：单段扇出 1000 个 `mc.call`（程序与原生各一组），以及 `root → 7×child → grandchild` 的三层嵌套 | 程序扇出超 `maxGuestsPerDomain`、原生扇出超 `maxPendingRpcsPerGuest` 时都立即 `PROGRAM_CAPACITY`（有 hint、可重试）；自死锁用例用 `allSettled` 收齐失败后正常结束，**不悬挂**；域内没有"排队等 guest"或"排队等 RPC 槽位"的路径 |

### 跨阶段不变量

- 每次程序调用的 `sourceDigest` 与 `runs/<run>/sources/` 里的文件一致；改文件不影响在跑的段名下的既有调用。
- 任何失败都不把"没有效果"报成"已生效"：`dispatch`/`effects` 只由 Runtime 填。
- 库操作不执行代码；执行不写库。
- 程序的正常返回不被当作目标达成的证据（`completion.scope = execution`）。

---

## 9. 未决

1. **`lookAt` 的落地**：需要在 `contracts/body.ts` 与 Driver 控制写入路径上各加一处；若 Driver 拒绝，退回"程序自己算角度"，但指南要多三行。
2. **事实类目标的修订号**：`self@1`/`inventory@1` 的 `version` 要求 Driver 在**内容变化时**推进序号（不是每帧推进）。若现有 `Fact` 已经有这种修订就直接复用，否则需要一处小改动；`FeedbackFrame.sequence` 本身不能直接用（它按帧推进）。
3. **`describe` 的候选排序**：现在按名字/摘要/标签子串匹配。是否需要显式的分类字段（而不是只靠 tags）来决定候选顺序，等能力数量上去再看。
4. **`decide` 的 checkpoint 语义**：现在是自由 JSON，由主脑决定怎么用；是否要给"恢复段"一个约定的最小结构（位置、背包摘要、目标），等 `runs continue` 实现后再定。
5. **`sensors` 的上限**：一次 `body.loop` 最多几个传感器、采样频率是否可配，取决于 Driver 的采样成本。
6. **域退役得 `unknown` 时谁接管**：本文要求容量不释放并上报 Executor；是否用 Windows 作业对象回收，超出 Program 范围。
7. **蓝图的归属**：`build@1 {from}` / `build.plan@1 {from}` 的 `ExactRef` 解析归 [Library](assets.md) §3（文件约定）与 Construction（解码、绝对坐标）；本文只假定"按 ref 取到一组绝对坐标的 cells"。
8. **"被观察"这一类等待还没有入口**：`waitForChange` 覆盖的是状态变化；"等到被某个玩家看见""等到聊天里出现某句"属于事件流。现在程序拿不到事件，也没有 `mc.read("events@1")`。真需求出现前不做——它需要 World 的事件游标与背压，是比状态查询大一档的东西。
9. **库能否跨世界共享**：现在程序库在 `worldDataDir` 下（每个世界一份）。若同一份生存程序要在多个世界复用，需要一处额外约定（例如 `$UINA_HOME/programs` 作为只读上层），本文不预先设计。

---

## 附录 A：给模型的一页

**附录 A 是给模型看的一页教学**（多给例子与理由）；正式常驻注入的是 `capabilities.md` §7 的速查。两者分工：注入页讲有什么、怎么判，这一页讲怎么写。

```text
程序：一个 .js 文件，合法 JavaScript。入口是 async function main(mc, input) { ... }，
      return 的就是结果。跑通后 library save 存起来；之后 mc run {name:"名字", input:{...}} 直接调。

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
  library save {name, summary, source}                    直接存一段新代码
  library save {name, summary, from:{run,segment,call}}   把跑通的这次存下来
  library update {name, source?, summary?, tags?, expectedDigest?}
  library delete {name}

身体（只有要逐 tick 控制时才显式拿）
  await mc.withBody(async body => { ... })     退出即释放
  await body.loop(step, sensors)               step 每帧返回 {keys,lookAt,use,attack} 或 {done:true}
                                               loop 返回只表示"停了"，到没到要自己判断
  body.call(refOrName, input)                  把当前身体控制权委托给这次调用（原生也走这条；mc.call 不会继承）
  body.dig(pos) / body.attack(ref) / body.useItem() / body.equip(item)
  body.openContainer(pos) -> win.snapshot() / win.click({slot})     mode 默认 "click"；光标预期由句柄从参照快照推出
  sensors = { 名字: {ref:"block@1", input:{...}} }，帧里读 f.sensors.名字.value

等待（现在就满足会立即返回，不会漏掉之前的变化）
  const r = await mc.waitForChange({inv:{ref:"inventory@1"}}, (s, u) => !u.inv && s.inv.freeSlots <= 2, {afterMs:5000})
  predicate 同步返回布尔；第二个参数 u 是"哪些目标看不清"（u.inv 为空表示库存已知）
  r.kind: "met" 满足 / "timeout" 到点 / "invalidated" 重连或世界重启——第三种只有 r.reason，没有值，要重读
  await mc.sleep(ms)

进度与交还
  mc.progress({summary:"..."})
  await mc.decide({reason, checkpoint})   只有根程序能调：结束本段、交还决定权（不返回）
  子程序想交还就 return {needsDecision:true, reason}，由调用它的程序决定怎么办

别把宿主压垮（两条硬限制，超了是 PROGRAM_CAPACITY / PROGRAM_TIMEOUT）
  同时在途的 mc.call/mc.read 别超过 16 个：分批 await，或用 Promise.allSettled
  JS 纯计算一次别超过 ~20ms：长循环每几百次 await mc.sleep(0) 让一下
  重量级计算交给能力做（region / build.plan / route.plan），程序只组合

跑起来之后
  mc runs {run}                 看 phase / waiting.kind / idleMs / progress
  mc runs stop {run}            idle 只有你判断得了：停在永不结算的 promise 上时它不烧 CPU，但占着域

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
| 同一份源 `compileOnly`（校验路径，不执行） | 0.4–0.5 ms，语法错行号与执行期报出的一致（校验不必用第二个引擎） |
| QuickJS 15 KB JSON 解析 | 0.37 ms |
| QuickJS `setMemoryLimit(32MiB)` 下堆膨胀 | `InternalError: out of memory`（~3 s），随后新上下文仍可用 |
| worker `resourceLimits.maxOldGenerationSizeMb=32` 下堆膨胀 | **整个进程 FATAL ERROR abort**（不可用作边界） |
| QuickJS 纯计算 | 3M `Math.sqrt` 循环 140 ms |
| guest 全局 | `process`/`require`/`fetch`/`WebAssembly`/`setTimeout` 均 undefined；`import("node:fs")` 返回永不结算的 promise |
| 单 worker + QuickJS RSS | ~62 MB |

**这张表只说明单域的成本，不能用来估算满载**：4 域 × 8 guest 的理论配额是 4×8×32 MiB = 1024 MiB（还不算 WASM 实例、消息队列与 Runtime 自身）。所以 §8 阶段 4 有一条硬验收：**把 4 域 × 8 guest 各分配到 12 MiB 跑满，记录峰值 RSS**；超过约 1.5 GiB 就把 `maxGuestsPerDomain` 降到 4。`guestMemoryBytes` 管的是 QuickJS 分配器管理的内存，不是进程 RSS——这条边界要写在实现注释里，不能拿它当"进程安全"的证明。

---

## 附录 C：实现骨架

**这是参考实现，不是合同**：与正文（§0–§7）冲突时以正文为准；示例代码只演示形状与关键分支，类型、错误码、边界都以正文和 §7 的类型定义为准。照抄之前先核对 §5 的语义。

头注释解析（`store.ts`）：

```ts
const HEADER_PREFIX = "// uina ";

/** 只做"剥"，不解释内容：头坏了也能安全写回（update 必须能覆盖损坏的头） */
function stripHeader(source: string) {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith(HEADER_PREFIX)) i++;   // 连续的前缀行才属于头
  return { head: lines.slice(0, i).join("\n"), body: lines.slice(i).join("\n") };
}

function parseHeader(source: string) {
  const { head } = stripHeader(source);
  if (!head) return {};
  const header: Record<string, unknown> = {};
  for (const [n, line] of head.split("\n").entries()) {
    let value: unknown;
    try { value = JSON.parse(line.slice(HEADER_PREFIX.length)); }
    catch { throw new HeaderError("HEADER_INVALID", source, n + 1); }   // 只影响读取，不影响执行
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new HeaderError("HEADER_INVALID", source, n + 1);
    for (const [k, v] of Object.entries(value))
      header[k] = Array.isArray(v) && Array.isArray(header[k])
        ? [...(header[k] as unknown[]), ...v]           // 数组拼接
        : v;                                             // 标量后者覆盖
  }
  return header;
}

// 写回：一行规范 JSON + 换行，脚本体逐字节照搬。
// 注意这里不调用 parseHeader：旧头 JSON 坏了，update 仍然必须能覆盖它。
// 副作用说清楚：多行头被合并成一行时，**脚本体字节不变，但脚本体首行的行号变了**。
// 所以"行号"一律相对当前文件计，不追求跨改写的稳定；执行时的行号由 guest 报
// （快照是执行时的确切字节），调用记录存的是执行行号，不保证等于编辑后的文件行号。
function writeHeader(source: string, header: Record<string, unknown>) {
  const { body } = stripHeader(source);
  return `${HEADER_PREFIX}${JSON.stringify(header)}\n${body}`;
}
```

`JSON.parse` 的报错只说明"第几行不是合法 JSON"，而**头坏了不该让程序变得不可调用**：解析失败时 `save`/`list` 报 `HEADER_INVALID` 并给行号，`update` 允许整体覆盖头；调用路径忽略无法解析的头，照常执行。

入口提取（`compile.ts`）——**校验与求值是两件事，但用同一个引擎**：

```ts
// 1) 静态校验（保存、run {code} 提交、open 之前）：只编译，不求值。
//    QuickJS 的 COMPILE_ONLY（quickjs-emscripten 的第三个参数 { compileOnly: true }）
//    把源码编译成函数字节码并返回，顶层语句一条都不会跑。实测：顶层写
//    `globalThis.__ran = true`，compileOnly 之后 typeof __ran 仍是 "undefined"。
//    所以"保存/校验不执行程序"是引擎给的保证，不是作者纪律。
//    语法错误来自同一个解析器：{name, message, fileName, lineNumber}，
//    因为源码被原样编译（没有包装前缀），报错行号就是源码行号。
//    校验用进程内的惰性单例运行时（首次 11ms 初始化，之后每次新建 context 约 0.5ms），
//    不注入任何宿主对象、不占域容量、不排队——它只编译。
const compiler = lazyCompileRuntime();
export function validate(source: string, filename: string): ProgramValidation {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES)
    return { ok: false, code: "PROGRAM_INVALID", reason: "size", message: "源码超过 64 KiB" };
  const ctx = compiler.newContext();
  try {
    const r = ctx.evalCode(source, filename, { compileOnly: true });
    if (r.error) {
      const e = ctx.dump(r.error);            // {name, message, fileName, lineNumber, stack}
      r.error.dispose();
      return { ok: false, code: "PROGRAM_INVALID", reason: "syntax",
               message: e.message, line: e.lineNumber };
    }
    r.value.dispose();
    return { ok: true, digest: sha256(source) };
  } finally { ctx.dispose(); }
}

// 2) 入口提取在 guest 内，是执行路径的一部分：evalCode 会执行顶层声明（JS 语义如此）。
//    同一份字节在这里再编译一次（0.3–0.5ms）——这就是"同一个引擎"的代价，
//    换来的是校验期与执行期不可能给出两套诊断。
//    代价可控，因为 mc、body 从来不是全局——它们只是 main 的形参。
//    顶层代码没有任何宿主句柄，不可能产生世界效果；顶层死循环由计算预算打断。
//    evalCode 同时包了三件事（编译、执行顶层、取值），失败必须分类，不能一律 invalid：
//      SyntaxError                         → PROGRAM_INVALID（reason:"syntax"，带行列）
//      InternalError "interrupted"         → PROGRAM_TIMEOUT（顶层超预算）
//      InternalError "out of memory"       → PROGRAM_MEMORY
//      其他（顶层 throw）                   → PROGRAM_ERROR（带栈与行列）
const r = ctx.evalCode(source, filename);   // 名字由调用方给：库里是 <name>.js，临时代码是 code-<digest8>.js
if (r.error) return failure(await classifyGuestError(r.error));   // 见 §7 的失败码表
r.value.dispose();
const main = ctx.getProp(ctx.global, "main");
const isFn = ctx.typeof(main) === "function";           // typeof 返回字符串，不是"句柄为真"
main.dispose();
if (!isFn) return invalid("缺少顶层 async function main(mc, input)");
```

顶层因此只有一条规则：**只放声明与常量**。求值用户源码之前，shim 不注入任何能到达宿主的对象（没有 `__post`、没有 `mc`、没有 `body`、没有 `console`）；`main` 校验通过之后才注入桥并调用 `main(mc, input)`。真写了死循环，得到的是 `PROGRAM_TIMEOUT`，不是卡死。

**但"顶层拿不到句柄"只是纵深防御，不是授权模型。** 顶层可以排一个微任务，等桥注入之后再 `__post`；真正的保证在 Runtime 侧：每条 RPC 都带该调用的身份，派发前核对"这个调用还在册、还没结算、没被取消、段还开着"。注入了桥但调用已结束 → `PROGRAM_RETIRED`/`CANCELLED`，不产生任何副作用。桥的可见性管的是"手边有没有入口"，准入管的是"这一步还作不作数"；后者不依赖任何语法约定。

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

一次调用的顺序：`resolve`（读字节 + 摘要）→ `validate`（只编译）→ `writeSnapshot`（写运行级快照）→ `open`（准入 + 段内固定）→ `invoke`（worker 新建运行时 + 编译脚本 + 调用 `main`）→ guest 的 `__post` 发出 `rpc` → 主线程交给 Runtime → 回 `reply` → guest 继续 → `settled` → Runtime 记录屏障。取消与退役在任意时刻插入，都走 §5.4 的路径。
