# Library：文件、元数据与发现

状态：详细设计，待实施。本文唯一维护三类库文件的格式、元数据、CRUD 与检索。Program 消费源码与头，负责编译执行；Construction 解释蓝图。

## 1. 裁决

| # | 裁决 | 放弃的机制与理由 |
|---|---|---|
| 1 | 库 = `<worldDataDir>` 下的普通文件，三类条目在同一个根目录下、各自按 kind 命名 | SQLite 资产目录。目录要索引的查询（按名、按 kind、按 tag）在几百个文件规模上 `readdir` 就够；一旦有目录，就要处理目录与文件的一致性、孤儿、损坏，而这些正是它要解决的问题之外的新问题。 |
| 2 | 没有发布事务或版本链 | 工作文件直接更新；expectedDigest 只防本次工具覆盖已变化文件，不提供发布或依赖锁定。执行快照的边界见 [Program §3.5](program.md#35-追溯更新与版本边界)。 |
| 3 | 确切内容由使用方在入场时固定（程序快照、工程记录 digest），库不冻结 | 不可变包保存"发布时的字节"。工程/运行自己记录它实际用的那份字节的摘要，保留当次材料，也不阻断作者继续编辑；不能从 digest 推断完整依赖已保存。 |
| 4 | 证据是弱链接，不复制 | `EvidenceCopy`/`EvidenceExportPort`/`attachEvidence`。事实归 Runtime/World；库里的判断引用记录 id，记录被清理时如实出现断链，而不是在库里养一份可能过期的副本。 |
| 5 | 文本由 `library` 写，字节由文件工具放 | 通过 JSON 工具搬运二进制（base64）。蓝图原件几十 KB 到几十 MB，宿主已有文件能力；库只负责登记元数据、读摘要、读出字节流。 |
| 6 | 蓝图三分保持：Raw / Target / Project | 把原件、语义、工程现场混成一个对象。三分法是原文最有价值的部分，原样保留（§3）。 |

## 2. 目录、命名与分工

```text
.uina/world-data/minecraft/            # worldDataDir；有 profile 时为 profiles/<id>/state/world-data/minecraft/
  programs/<name>.js                 # 程序（Library 管文件与头，Program 管执行）
  blueprints/<name>/
      design.schem                   # 原件字节（唯一必需；扩展名即格式提示）
      about.json                     # 元数据，summary 必填
      target.json                    # 可选：Construction 解释后的目标语义
  experiences/<name>.md              # 经验笔记
  world-history.db                   # World 历史（World 所有）
  runtime.db                         # Runtime 记录（Runtime 所有，runtime.md §5.3）
  runs/<run>/sources/<sha256>.js      # 源码快照（Runtime 所有，Program 只写 sources/；按内容寻址）
```

各位置在同一数据根下并列，互不搬移、互不代管；只有 `runs/` 由 Program 与 Runtime 分工写。大记录读取缓存 exports/ 归 Runtime，不属于库；接入凭证另由 Uina 侧 Executor 的 executor.db 拥有（[Executor §6](executor.md)），不是库条目。

- **命名**：三类的 `name` 统一 `^[a-z][a-z0-9_-]{0,47}$`（小写；Windows 大小写不敏感），在各自类别内唯一。同名不同类别允许（`blueprints/hut` 与 `experiences/hut` 不冲突），因为地址总是带 kind。
- **路径安全**：只允许上述固定结构；拒绝 `..`、绝对路径、反斜杠、保留设备名、忽略大小写后的重复项。`blueprints/<name>/` 内只认 `design.*`、`about.json`、`target.json`，其他文件忽略（不报错）。
- **程序目录**：递归读取 programs/**/*.js；name 为去掉 .js 的文件名，子目录只用于整理。忽略 `.`/`_` 开头文件；同名冲突列出路径并报 PROGRAM_CONFLICT，不任选一个。用 realpath 和路径边界核验阻止符号链接/目录联接越出库根；不声称能追溯硬链接的外部原始路径。
- **分工**：Library 唯一读写三类工作文件和元数据，复用一个头解析/扫描实现；Program 负责源码快照、编译与执行；Construction 负责目标解释、变换和现场计划；World 保存工程记录。
- **装配**：组合根向 Library 注入 compile-only 和确切调用快照读取函数，向 Program 注入只读程序材料加载函数。两者不互持完整服务，不复制文件实现，不在初始化时执行程序。

## 3. 蓝图

### 3.1 三分法

| | 是什么 | 谁拥有 | 不承诺 |
|---|---|---|---|
| **Raw** | `.schem`、`.litematic`、`.snbt` 等原始字节，逐字节保真（含 DataVersion、offset、palette、block entity、entity、biome 与未知标签） | Library 存字节 | 不承诺可解析，更不承诺可施工 |
| **Target** | Construction 可解释的局部设计语义（`target.json`） | Construction 定义 schema 与验证器 | 不承诺当前现场可施工 |
| **Project** | 绑定 world/dimension/anchor/旋转/镜像/现场观察/材料与进度的工程对象 | Construction + World | 不回写 Raw/Target |

Raw 不自动变 Target，Target 不自动变 Project，Project 不回写蓝图。**文件在 ≠ 能解析 ≠ 能施工**，三件事分别报告。

### 3.2 目标语义与 AirPolicy

Target 的 set/clear/preserve/unknown 及共用施工流程由 [Construction 能力合同](capabilities.md#construction-target) 唯一定义。Library 不解释目标或修改设计字节。

导入时，来源已知为空气的格必须明确 AirPolicy：set_air 映射为 clear，preserve 映射为 preserve；未指定报 AIR_POLICY_REQUIRED。来源未知的格保持 unknown，任何空气策略都不能把它变成可拆除目标。解码、DataVersion、状态/NBT 变换、旋转/镜像、材料与顺序归 Construction；无验证器报 SCHEMA_UNAVAILABLE。

### 3.3 完整性与损坏

- `library.get` 计算 `design.*` 的 `sha256` 与字节长度，返回 `{digest, size, formatHint, about, target?: {schema, digest}}`。
- 读取失败 → BLUEPRINT_CORRUPT，target.json 不合法 → TARGET_INVALID。Library 报告本次实际摘要；施工的 expectDigest 比较由 Construction 完成。损坏不返回空建筑。
- 同一目录出现多个 `design.*` → `BLUEPRINT_AMBIGUOUS`，要求作者删掉其余。
- `about.json` 非法不阻止读取字节：`list` 里标 `aboutError`，`get` 仍返回文件事实。

### 3.4 工程引用

工程记录引用 `{name, designDigest}`，并固定实际解释的 Target、变换和解释版本。一次施工使用入场固定材料，不在每次读现场时重读 Library 文件。

新 build/plan 从当前文件解析；expectDigest 不符时按能力合同报 CONFLICT。继续已有工程则使用其固定 Target 并重读现场；需要改变设计时创建关联工程，不把旧完成量搬到新目标。缺少固定材料明确失败，不从同名新文件重建旧设计。

删除库条目不删除工程记录或已经固定的 Target；library.get 返回 NOT_FOUND，工程仍保留原摘要与自身材料。源码/设计追溯不承诺原世界重放。

### 3.5 导入

二进制不进 JSON 工具。导入 = 两步，顺序固定：

1. 用宿主文件能力把字节放到 `blueprints/<name>/design.<ext>`（扩展名就是格式提示）。
2. `library.save {kind:"blueprint", name, summary, tags?}`：核对 `design.*` 存在且唯一，写 `about.json`。元数据最后写，所以中断只会留下"没有元数据的文件"，`list` 会把它列成 `summary: null`，不会留下"有元数据没有内容"的假条目。

外部下载、`git clone`、别的程序生成的结构文件都走同一条路。生成类能力（例如"把这片区域导出成蓝图"）属于 Construction/Driver 能力，可以直接写这两个位置，仍受同一命名与元数据规则约束。

## 4. 经验

### 4.1 形态

单个 markdown 文件，顶部是一个 `uina` 注释头（与程序头同一套语法：标记 + 一行 JSON），正文自由：

```markdown
<!-- uina {"summary":"苦力怕在白天也会爆炸；天亮不等于安全","applies":["mining","combat"],"tags":["creeper","day","安全"]} -->
挖矿时听到嘶嘶声先撤退，别赌它白天不炸。

反例：在雷暴天气的屋顶上，苦力怕是被闪电引来的，撤离路线要先看下方。
```

- 解析与程序共用同一段逻辑：找首行 `uina` 标记、`JSON.parse` 其后内容；坏 JSON 标 headerError，正文照样可读；experience 是供阅读的判断，不参与程序输入校验。程序坏头按 §5.1 拒绝运行，经验正文仍可读。没有头合法，summary=null。
- `applies` 是给检索用的粗分类（可多个），不是 schema 约束；正文承载适用条件、方法、反例与不确定。
- 正文就是散文。判断的强度（猜测/已验证/有争议）写在句子里，不用枚举字段——字段会逼出虚假精确，而读它的是模型。

### 4.2 经验是判断，不是事实

- 经验是作者的判断及其适用条件，可以随时改；改动直接改文件，没有版本号。
- 事实归 Runtime/World 的记录。经验里引用运行用 `run:r-...` 弱链接；记录被清理后链接失效，如实报告，不复制现场。
- 一次成功只能成为带条件的支持材料，一次失败可以成为假设或反例；新证据不自动改判断，也不生成置信度分数。

## 5. `library` 表面

`library` 是 `mc` 工具的一个 action，三类条目共用一套动词：

| op | 参数 | 行为 |
|---|---|---|
| `list` | `{kind?, text?, tag?, limit?}` | 扫描三类目录，返回 `[{kind, name, summary, tags, updatedAt, size?, digest?, path?, aboutError?, headerError?}]`，按 `updatedAt` 倒序，默认 50 条；`digest` 只对程序与文本条目计算，蓝图给 `size` |
| `get` | `{kind, name}` | program → 源码（含头注释）；blueprint → `{about, files, digest, size, target?}`；experience → `{header, text}` |
| `save` | `{kind, name, ...}` | program：从运行段或源码创建（§5.2–§5.3）；blueprint：登记已放入的 `design.*` 并写元数据；experience：写文本与头注释。已存在 → `NAME_EXISTS`，改用 `update` |
| `update` | `{kind, name, ...}` | 改文本/元数据；program 的完整 source 替换与 metadata 补丁互斥（§5.2），blueprint 的 `design.*`/`target.json` 字节不在本操作内替换 |
| `delete` | `{kind, name}` | 删条目（program/experience 删文件，blueprint 删目录）。不删 `runs/` 快照 |

规则：kind 缺省 program；list 省略 kind 时枚举三类。

- **文本可写，字节不搬运**：`save/update` 只写 `.js`、`.md`、`about.json`；`design.*` 与 `target.json` 由文件能力或能力实现写入。
- `save` 对蓝图要求 `design.*` 已存在且唯一（否则 `BLUEPRINT_SOURCE_MISSING` / `BLUEPRINT_AMBIGUOUS`）。
- 三种 kind 都可 `delete`；删除不改变既有运行/工程记录，只让后续引用失败。
- 不提供 `rename`：改名 = `save` 新名 + `delete` 旧名。
- 检索使用名称/摘要子串与 tag，不建立评分；有效性由模型结合运行记录判断。

### 5.1 程序文件与头

文件第一行可有一个 `// uina {…}` 元数据对象；无头文件合法。开头连续出现多个结构化头时报 HEADER_INVALID，运行时报 PROGRAM_INVALID(reason=header)，不合并。库生成的头使用单行 JSON，并转义 U+2028/U+2029；脚本体字节保持原样。完整源码替换不重写所提供的头。

| 字段 | 规则 |
|---|---|
| summary | save 时必需，一句话说明做什么和假定什么 |
| tags | 可选字符串数组；用于文本和标签发现 |
| input / output | 可选 JSON Schema；输入/返回参与校验，不做类型强转或隐式补默认值 |
| examples | 可选 `{input, output?}[]`；输出是说明性示例，不是验收证据 |
| saved | 工具写入 `{run, segment, call, digest, at}`；digest 是来源调用执行时的摘要 |

input/output 未声明时如实显示“契约未声明”，不从一次运行自动推断通用类型。examples 若给出，校验其结构及已声明 input/output schema；通过只表示示例数据形状相符。声明的 output 只校验 JSON 结构，不使程序成为世界目标认证器。普通程序的完成范围固定为 execution。

头 JSON/schema/字段结构损坏时，list 标 headerError，get 返回原文及诊断；run 报 PROGRAM_INVALID(reason=header)，库写入报 HEADER_INVALID。修复使用 `update {name, source}` 替换完整源码，或直接编辑文件；元数据补丁拒绝处理坏头。新源码可以提供合法新头，也可以明确不带头；不能因读取失败而自动丢弃旧输入合同。

头规范化可能改变文件摘要及后续代码行号。saved.digest 指向来源执行字节，返回 digest 指向落盘文件，两者可以不同。程序不另存 lesson；具体方法和默认值进代码，经验及其适用条件进 Experience。

### 5.2 程序操作

library 是工具 action，不是 guest API；kind 缺省 program。普通文件工具可以编辑完整文件。

| op | 程序请求与返回 |
|---|---|
| save | `{name, summary, tags?, input?, output?, examples?, source?\|from?}` → ProgramSummary；source/from 恰一 |
| update | `{name, source, expectedDigest?}` 或 `{name, metadata, expectedDigest?}` → ProgramSummary；两种形式互斥 |

save 只创建，撞名 NAME_EXISTS。list 按大小写不敏感子串/tag 过滤、updatedAt 倒序，默认最多 50，不扫描 runs。

update 的规则只有两组：

- source 是完整文件，包含所需头；逐字节替换，不继承旧头，不接受同请求的 metadata。可修复坏头；故意省略头就是移除旧元数据。
- metadata 是可编辑字段的补丁：summary/tags/input/output/examples。省略保持原值，数组整体替换；可选字段 null 清除，tags 清为空数组，summary 不接受 null。saved 不是可编辑字段，合法旧值原样保留。无头文件可补头，损坏头拒绝补丁。

两种形式都先校验最终文件，再临时写入并 rename。expectedDigest 不符报 DIGEST_CONFLICT，不写入；它只协调本次工具更新，不锁外部编辑器。没有输入/输出 schema 的程序仍可保存和运行。

### 5.3 保存来源与迭代

save 从有效来源头继承 tags/input/output/examples，本次显式字段覆盖，数组替换；summary 必须由本次请求给出。from 精确指定 `{run,segment,call}`，执行侧 Library 适配读取调用记录和不可变快照，不能从当前工作文件重建；来源被清理报 NOT_FOUND。

保存剥去来源头、写一个新头并 compileOnly，不执行代码。saved 仅在 from 路径由工具写入真实调用来源；直接 source 不冒充一次运行，旧 saved 不复制。只保存该脚本，不复制 input、输出、子程序或证据，不从一次运行推断 schema。

完整源码 update 与普通文件编辑一样，以新文件中的 saved 为作者提供的来源提示；运行溯源以 Runtime 调用记录和快照为准。元数据补丁不改脚本体。头变化可以改变文件摘要和行号；saved.digest 指来源字节，返回 digest 指落盘文件。删除库文件不删运行快照。

模型通过“试做 → 看结果 → 修改 → 保存 → 换场景复用”迭代。具体方法和默认值进入代码，适用条件与反例进入经验文件；保存不认证玩法有效。

from 由执行侧读取 readRecord(call)，核验 owner/run/segment 与源码摘要后读取快照；来源缺失则失败，不从当前工作文件补造。保存成功只证明文件已写入。

experience 的 text 是完整 Markdown 文件（含可选头）；完整替换不继承旧头。metadata 补丁只改合法头，省略保持、数组替换、null 清除；坏头只通过完整 text 修复。blueprint 只补丁 about.json；不通过 metadata 改 design/target 字节，坏 about 用普通文件编辑修复。所有写入先校验最终材料再临时写入/rename。

### 5.4 公开类型与端口

下列类型由 Library 唯一定义，Program 仅引用。工具请求复用同一请求类型；saved 来源由宿主生成，不接受模型自报。

```typescript
interface ProgramExample { input: JsonValue; output?: JsonValue }
interface ProgramHeader {
  summary?: string; tags?: string[]; input?: JsonSchema; output?: JsonSchema;
  examples?: ProgramExample[];
  saved?: { run: Ref; segment: Ref; call: Ref; digest: string; at: string };
}
interface ProgramSummary {
  name: string; summary: string | null; tags: string[];
  digest: string; path: string; updatedAt: string; headerError?: string;
}
interface ProgramDetail extends ProgramSummary {
  source: string; input?: JsonSchema; output?: JsonSchema;
  examples?: ProgramExample[]; savedFrom?: ProgramHeader["saved"];
}
interface ProgramSaveMetadata {
  name: string; summary: string; tags?: string[];
  input?: JsonSchema; output?: JsonSchema; examples?: ProgramExample[];
}
type SaveRequest = ProgramSaveMetadata & (
  | {source: string; from?: never}
  | {from: {run: Ref; segment: Ref; call: Ref}; source?: never}
);
interface ProgramMetadataPatch {
  summary?: string; tags?: string[] | null;
  input?: JsonSchema | null; output?: JsonSchema | null;
  examples?: ProgramExample[] | null;
}
type UpdateRequest = {name: string; expectedDigest?: string} & (
  | {source: string; metadata?: never}
  | {metadata: ProgramMetadataPatch; source?: never}
);
type ProgramDescription = Omit<ProgramDetail, "source">;
type LibraryKind = "program" | "blueprint" | "experience";
interface LibraryListQuery {kind?: LibraryKind; text?: string; tag?: string; limit?: number}
interface TextMetadata {summary?: string; tags?: string[]; applies?: string[]}
interface FileEntrySummary {
  name: string; summary: string | null; tags: string[]; path: string; updatedAt: string;
  size?: number; digest?: string; aboutError?: string; headerError?: string;
}
type LibrarySummary = ({kind: "program"} & ProgramSummary)
  | ({kind: "blueprint" | "experience"} & FileEntrySummary);
type LibraryDetail = ({kind: "program"} & ProgramDetail)
  | ({kind: "blueprint"} & FileEntrySummary & {
      about: JsonValue | null; files: string[]; digest: string; size: number;
      formatHint: string; target?: {schema: ExactRef; digest: string}})
  | ({kind: "experience"} & FileEntrySummary & {header: TextMetadata | null; text: string});
type LibrarySaveRequest = ({kind?: "program"} & SaveRequest)
  | {kind: "blueprint"; name: string; summary: string; tags?: string[]}
  | {kind: "experience"; name: string; text: string};
type LibraryUpdateRequest = ({kind?: "program"} & UpdateRequest)
  | {kind: "blueprint"; name: string; metadata: {summary?: string; tags?: string[] | null}}
  | ({kind: "experience"; name: string; expectedDigest?: string} & (
      | {text: string; metadata?: never}
      | {metadata: {summary?: string | null; tags?: string[] | null; applies?: string[] | null}; text?: never}));
interface LibraryPort {
  list(query?: LibraryListQuery): Promise<LibrarySummary[]>;
  get(kind: LibraryKind, name: string): Promise<LibraryDetail | null>;
  save(request: LibrarySaveRequest): Promise<LibrarySummary>;
  update(request: LibraryUpdateRequest): Promise<LibrarySummary>;
  delete(kind: LibraryKind, name: string): Promise<void>;
}
```

list/get 返回实际读取的文件与诊断；get 的程序分支含完整 source，describe 的 ProgramDescription 不带 source。二者复用同一文件读取与头解析，不维护第二份目录数据。

## 6. 错误与验收

错误码（都不进入段失败路径，直接回给调用者）：

| 码 | 何时 |
|---|---|
| `NAME_INVALID` | 名字不合规 |
| `NAME_EXISTS` | `save` 撞名 |
| `NOT_FOUND` | 条目不存在 |
| `DIGEST_CONFLICT` | update 的 expectedDigest 与工作文件不符，不写入 |
| `PROGRAM_CONFLICT` | 递归程序目录存在同名文件，返回所有路径 |
| `HEADER_INVALID` | 库写入的头/schema/about.json 不合法；读取保留原文与诊断；程序执行另报 PROGRAM_INVALID(reason=header)，不静默忽略输入合同 |
| `BLUEPRINT_SOURCE_MISSING` | 蓝图没有 `design.*` |
| `BLUEPRINT_AMBIGUOUS` | 蓝图有多个 `design.*` |
| `BLUEPRINT_CORRUPT` | 蓝图字节无法完整读取 |
| `TARGET_INVALID` | `target.json` 不被 Construction 的 schema 接受 |
| `SCHEMA_UNAVAILABLE` | 验证器当前不可用（不伪装成通过） |
| `AIR_POLICY_REQUIRED` | 从 Raw 解释 Target 时缺少空气策略 |
| `IO_ERROR` | 文件系统失败 |

验收：

1. 两个工程固定同一设计；修改库文件不改变它们的 Target。新 build 携带旧 expectDigest 时拒绝，新工程按显式新设计创建。
2. 截断的 `.schem` → `BLUEPRINT_CORRUPT`，不返回空 cells，不覆盖原文件。
3. `about.json` 非法 → `list` 标 `aboutError`，`get` 仍返回文件事实（可读、可施工性未知）。
4. 两个 `design.*` → `BLUEPRINT_AMBIGUOUS`；删掉一个后恢复。
5. 经验无头注释 → `list` 的 `summary: null`，`get` 返回正文。
6. delete 蓝图后 library.get 报 NOT_FOUND；已有工程仍可读取其固定 Target 和源摘要，不能偷偷使用新同名文件。
7. 三类条目同名互不干扰；`list {kind:"blueprint"}` 不扫描 `runs/`。

## 7. 实现边界

批 7 当前只实现程序只读材料和共用头解析，供 Program 执行消费；以下文件管理和统一发现接口仍属批 8，蓝图解释属于施工包。

只实现普通文件扫描、元数据和 CRUD。历史 Assets 的发布、版本链与证据副本方案见 [变更记录](../changelog.md)，不作为当前实现路径。Library 不控制身体、不运行游戏任务，也不维护另一份执行结论。

## 8. 发现

工具 describe 的统一搜索覆盖能力（含查询）、程序、蓝图与经验，返回 kind、callable、名字/引用、用途、必要路径与不可用原因；同名不同 kind 不遮蔽。动作能力/程序的 callable=true，使用 call；查询的 callable=false，使用 read。蓝图/经验供读取或作为领域输入，精确读取带 kind，不进入 call。

搜索仍按名称、摘要和 tags 的文本匹配，不暗做语义检索；候选默认最多 10 条，先精确名字再前缀再其余文本命中，同级按 kind/name 稳定排序。describe 无参数给家族概览，不注入所有库正文；精确程序描述给 input/output（或未声明）、完成范围、适用条件和可复制的完整 await 示例。事实来自同一元数据，不手抄第二份常驻说明。

Library 扫描三类文件并投影元数据，目录再与原生动作/查询 descriptor 合并。library.list 是按更新时间查看文件，describe.search 是按用途找工作；两者复用同一扫描/解析结果，不分别保存索引。

精确 describe 返回合同、适用条件、路径、诊断及完整调用示例，不默认返回源码或经验正文。读原文使用 library.get 或普通文件工具；蓝图字节使用文件路径，目标解释交 Construction。program 缺 schema/examples 时明确未声明；坏头仍可检索和读原文，但不可运行。

## 9. 扩展边界

1. **蓝图格式支持**：formatHint 来自唯一 design 文件的扩展名，仅为提示；DataVersion 与实际可解析性由 Construction 解码判定。
2. **区域导出**：把现场区域变成 `design.*` 的能力归 Construction/Driver；本文只规定落地位置与元数据。
3. **经验的检索质量**：只有 applies/tags 与子串匹配；如果经验积累到几百条，可由主脑按任务发现读取；若后续增加自动投影，应独立验证，不在库里预建学习队列。
4. **`target.json` 的版本**：Target schema 由 Construction 版本化；库只存 schema 身份与字节，schema 升级后的迁移策略归 Construction。
