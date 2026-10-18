# Library：蓝图与经验

状态：详细设计，待实施。本文件原名《Assets：程序、蓝图与经验的详细设计》；2026-10-18 起，Program 归 [`program.md`](program.md)，仓库机制（SQLite 目录、不可变包、发布 CAS、证据副本）整体删除，本文只保留**库的文件约定**与**蓝图/经验的领域语义**。文件名沿用 `assets.md` 只为不断链，模块含义已缩小为 Library。

## 1. 裁决

| # | 裁决 | 放弃的机制与理由 |
|---|---|---|
| 1 | 库 = `<worldDataDir>` 下的普通文件，三类条目在同一个根目录下、各自按 kind 命名 | SQLite 资产目录。目录要索引的查询（按名、按 kind、按 tag）在几百个文件规模上 `readdir` 就够；一旦有目录，就要处理目录与文件的一致性、孤儿、损坏，而这些正是它要解决的问题之外的新问题。 |
| 2 | 没有不可变版本、没有发布、没有 CAS | Revision/head/`expectedRef`/`intent`/operations 幂等表。版本服务的三个需求（复现、并行变体、依赖不漂移）在单作者场景里分别由"使用方记录 digest""复制文件""编辑即意图"覆盖，参见 program.md §4.6。 |
| 3 | 确切内容由使用方在入场时固定（程序快照、工程记录 digest），库不冻结 | 不可变包保存"发布时的字节"。工程/运行自己记录它实际用的那份字节的摘要，比"发布一个版本"更直接，也不阻断作者继续编辑。 |
| 4 | 证据是弱链接，不复制 | `EvidenceCopy`/`EvidenceExportPort`/`attachEvidence`。事实归 Runtime/World；库里的判断引用记录 id，记录被清理时如实出现断链，而不是在库里养一份可能过期的副本。 |
| 5 | 文本由 `library` 写，字节由文件工具放 | 通过 JSON 工具搬运二进制（base64）。蓝图原件几十 KB 到几十 MB，宿主已有文件能力；库只负责登记元数据、读摘要、读出字节流。 |
| 6 | 蓝图三分保持：Raw / Target / Project | 把原件、语义、工程现场混成一个对象。三分法是原文最有价值的部分，原样保留（§3）。 |

## 2. 目录、命名与分工

```text
.uina/world-data/minecraft/            # worldDataDir；有 profile 时为 profiles/<id>/state/world-data/minecraft/
  programs/<name>.js                 # 程序（program.md 拥有形态与执行）
  blueprints/<name>/
      design.schem                   # 原件字节（唯一必需；扩展名即格式提示）
      about.json                     # 元数据，summary 必填
      target.json                    # 可选：Construction 解释后的目标语义
  experiences/<name>.md              # 经验笔记
  world-history.db                   # World 历史（World 所有）
  runtime.db                         # Runtime 记录（Runtime 所有，runtime.md §4.3）
  runs/<run>/sources/<sha256>.js      # 源码快照（Runtime 所有，Program 只写 sources/；按内容寻址）
```

六个位置是同一数据根下的并列邻居，互不搬移、互不代管；只有 `runs/` 由 Program 与 Runtime 分工写。

- **命名**：三类的 `name` 统一 `^[a-z][a-z0-9_-]{0,47}$`（小写；Windows 大小写不敏感），在各自类别内唯一。同名不同类别允许（`blueprints/hut` 与 `experiences/hut` 不冲突），因为地址总是带 kind。
- **路径安全**：只允许上述固定结构；拒绝 `..`、绝对路径、反斜杠、保留设备名、忽略大小写后的重复项。`blueprints/<name>/` 内只认 `design.*`、`about.json`、`target.json`，其他文件忽略（不报错）。
- **分工**：`program.md` 拥有 `programs/` 的形态与执行；本文拥有 `blueprints/`、`experiences/` 的形态与语义，以及三类共享的命名、路径与错误约定。Construction 拥有蓝图解码、目标解释、现场计划；World 拥有工程记录与空间数据。

## 3. 蓝图

### 3.1 三分法

| | 是什么 | 谁拥有 | 不承诺 |
|---|---|---|---|
| **Raw** | `.schem`、`.litematic`、`.snbt` 等原始字节，逐字节保真（含 DataVersion、offset、palette、block entity、entity、biome 与未知标签） | Library 存字节 | 不承诺可解析，更不承诺可施工 |
| **Target** | Construction 可解释的局部设计语义（`target.json`） | Construction 定义 schema 与验证器 | 不承诺当前现场可施工 |
| **Project** | 绑定 world/dimension/anchor/旋转/镜像/现场观察/材料与进度的工程对象 | Construction + World | 不回写 Raw/Target |

Raw 不自动变 Target，Target 不自动变 Project，Project 不回写蓝图。**文件在 ≠ 能解析 ≠ 能施工**，三件事分别报告。

### 3.2 目标语义与 AirPolicy

Target 的四态由 Construction 定义并验证，Library 不重写这些语义：

| 目标 | 含义 |
|---|---|
| `set` | 设置确定 Block State |
| `clear` | 明确要求清空 |
| `preserve` | 明确保留现场；未声明范围不能自动变成拆除 |
| `unknown` | 来源缺测或无法解释，目标确实无法确定，附原因 |

对**来源已知为空气的格**：`set_air → clear`、`preserve → preserve`；未给策略时不产生半解释 Target，返回 `AIR_POLICY_REQUIRED`。**来源本来未知的格永远是 `unknown`**，任何策略都不能把它变成 clear 或 preserve。

解码、DataVersion 适配、Block State/NBT 转换、旋转镜像、材料统计与施工顺序全归 Construction；Library 只保存 Raw/Target 字节与其摘要，并把验证器不可用如实报成 `SCHEMA_UNAVAILABLE`。

### 3.3 完整性与损坏

- `library.get` 计算 `design.*` 的 `sha256` 与字节长度，返回 `{digest, size, formatHint, about, target?: {schema, digest}}`。
- 读取失败 → `BLUEPRINT_CORRUPT`；与工程记录里的 digest 不符 → `BLUEPRINT_CHANGED`；`target.json` 不合法 → `TARGET_INVALID`。**不返回空结构，不把损坏当空建筑**。
- 同一目录出现多个 `design.*` → `BLUEPRINT_AMBIGUOUS`，要求作者删掉其余。
- `about.json` 非法不阻止读取字节：`list` 里标 `aboutError`，`get` 仍返回文件事实。

### 3.4 工程引用

工程记录（Construction/World）引用蓝图的方式是 `{name, designDigest}`，不是版本号：

- 计划阶段固定 digest；施工中每次读现场差异时核对 digest，不一致报 `BLUEPRINT_CHANGED`，由主脑决定按新设计重算还是继续旧计划（旧字节已随工程记录固定，可复现）。
- 换设计 = 另建关联工程，不改旧工程的设计引用；旧工程完成量不搬到新设计上。
- 删除蓝图不影响既有工程记录：记录保留 digest，查询时报告 `NOT_FOUND` 与其摘要，不猜内容。

### 3.5 导入

二进制不进 JSON 工具。导入 = 两步，顺序固定：

1. 用宿主文件能力把字节放到 `blueprints/<name>/design.<ext>`（扩展名就是格式提示）。
2. `library.save {kind:"blueprint", name, summary, tags?, formatHint?}`：核对 `design.*` 存在且唯一，写 `about.json`。元数据最后写，所以中断只会留下"没有元数据的文件"，`list` 会把它列成 `summary: null`，不会留下"有元数据没有内容"的假条目。

外部下载、`git clone`、别的程序生成的结构文件都走同一条路。生成类能力（例如"把这片区域导出成蓝图"）属于 Construction/Driver 能力，可以直接写这两个位置，仍受同一命名与元数据规则约束。

## 4. 经验

### 4.1 形态

单个 markdown 文件，顶部是一个 `uina` 注释头（与程序头同一套语法：标记 + 一行 JSON），正文自由：

```markdown
<!-- uina {"summary":"苦力怕在白天也会爆炸；天亮不等于安全","applies":["mining","combat"],"tags":["creeper","day","安全"]} -->
挖矿时听到嘶嘶声先撤退，别赌它白天不炸。

反例：在雷暴天气的屋顶上，苦力怕是被闪电引来的，撤离路线要先看下方。
```

- 解析与程序共用同一段逻辑：找首行 `uina` 标记、`JSON.parse` 其后内容；坏 JSON → `HEADER_INVALID`，没有头合法（`summary: null`），正文照样可读。
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
| `save` | `{kind, name, ...}` | program：从运行段或源码创建（program.md §4）；blueprint：登记已放入的 `design.*` 并写元数据；experience：写文本与头注释。已存在 → `NAME_EXISTS`，改用 `update` |
| `update` | `{kind, name, ...}` | 改文本/元数据；program 可连源码一起换（program.md §4.1），blueprint 的 `design.*`/`target.json` 字节不在本操作内替换 |
| `delete` | `{kind, name}` | 删条目（program/experience 删文件，blueprint 删目录）。不删 `runs/` 快照 |

规则：

- **文本可写，字节不搬运**：`save/update` 只写 `.js`、`.md`、`about.json`；`design.*` 与 `target.json` 由文件能力或能力实现写入。
- `save` 对蓝图要求 `design.*` 已存在且唯一（否则 `BLUEPRINT_SOURCE_MISSING` / `BLUEPRINT_AMBIGUOUS`）。
- 三种 kind 都可 `delete`；删除不改变既有运行/工程记录，只让后续引用失败。
- 不提供 `rename`：改名 = `save` 新名 + `delete` 旧名。
- 不提供 `search` 排序与评分：子串 + tag 过滤足够；"哪个真的有用"由运行记录聚合回答。

## 6. 错误与验收

错误码（都不进入段失败路径，直接回给调用者）：

| 码 | 何时 |
|---|---|
| `NAME_INVALID` | 名字不合规 |
| `NAME_EXISTS` | `save` 撞名 |
| `NOT_FOUND` | 条目不存在 |
| `HEADER_INVALID` | 写入时 `uina` 头/about.json 不合法；读取时只记 `headerError`（`summary: null`），不阻塞正文 |
| `BLUEPRINT_SOURCE_MISSING` | 蓝图没有 `design.*` |
| `BLUEPRINT_AMBIGUOUS` | 蓝图有多个 `design.*` |
| `BLUEPRINT_CORRUPT` | 蓝图字节读不出或摘要与记录不符 |
| `BLUEPRINT_CHANGED` | 工程记录里的 digest 与当前文件不符 |
| `TARGET_INVALID` | `target.json` 不被 Construction 的 schema 接受 |
| `SCHEMA_UNAVAILABLE` | 验证器当前不可用（不伪装成通过） |
| `AIR_POLICY_REQUIRED` | 从 Raw 解释 Target 时缺少空气策略 |
| `IO_ERROR` | 文件系统失败 |

验收：

1. 两个工程引用同一蓝图；改文件后旧工程记录 digest 不符 → 报 `BLUEPRINT_CHANGED`，不静默换设计；新工程用新字节。
2. 截断的 `.schem` → `BLUEPRINT_CORRUPT`，不返回空 cells，不覆盖原文件。
3. `about.json` 非法 → `list` 标 `aboutError`，`get` 仍返回文件事实（可读、可施工性未知）。
4. 两个 `design.*` → `BLUEPRINT_AMBIGUOUS`；删掉一个后恢复。
5. 经验无头注释 → `list` 的 `summary: null`，`get` 返回正文。
6. `delete` 蓝图后，既有工程的查询报 `NOT_FOUND` 并带上原摘要，不猜内容。
7. 三类条目同名互不干扰；`list {kind:"blueprint"}` 不扫描 `runs/`。

## 7. 删掉的机制

| 机制 | 为什么删 |
|---|---|
| `catalog.sqlite`、`objects/<objectId>` | 目录与内容的一致性、孤儿、损坏治理成本高于"几百个文件"的检索需求 |
| `packageDigest` / `inputDigest` / `manifestDigest` 链 | 程序用源码摘要、蓝图用文件摘要即可；包摘要服务的是发布事务，这里没有发布 |
| `PublishRequest/Result`、`expectedRef`、`intent`、CAS | 防的是并发发布合并；单作者编辑即意图 |
| `operations` 幂等表 | 发布幂等的前提是发布；没有发布就没有这张表 |
| `Revision`/`head`/`previousRef`/`derivedFrom` | 复现由使用方记录 digest 承担，并行变体由复制文件承担 |
| `EvidenceCopy`/`attachEvidence`/`EvidenceExportPort` | 弱链接 + 记录所有者已足够；副本会过期，且要有 GC |
| `ProgramSourcePort`/`publishFromRun` | 由 `library.save {from:{run,segment,call}}` 直接读那次调用的快照（program.md §4.2） |
| `ReadLibrary`/`WriteLibrary`/`AssetRepository` | 脚本不需要仓库对象；需要的是 `build.plan@1`/`build@1` 这类能力 |
| `inspect` 的 `verified/corrupt/unknown` 状态机 | 读到就报事实（摘要、长度、能否解析），没有"检查"这一独立动作 |
| `RepositoryRef`、`name@version` | 库是本地的；跨仓库共享不在需求里 |

## 8. 与 program.md 的分工

- `programs/` 的形态、执行、保存规则 → `program.md`。
- 三类共享的命名、路径、错误与 `library` 工具形状 → 本文（program.md §4.1 引用这里的 kind 约定）。
- 蓝图与经验的 `library.get` 输出形状 → 本文；程序的输出形状（源码+头注释）→ program.md。
- 程序要用蓝图时传 `{from:{kind:"blueprint", name}}` 给 `build.plan@1`/`build@1`；解码、旋转、绝对坐标归 Construction（capabilities.md §4）。

## 9. 未决

1. **蓝图的 `formatHint`**：现在靠扩展名。是否要允许 `about.formatHint` 覆盖（例如 `.schem` 的不同 DataVersion）由 Construction 决定。
2. **区域导出**：把现场区域变成 `design.*` 的能力归 Construction/Driver；本文只规定落地位置与元数据。
3. **经验的检索质量**：只有 `@applies` 与子串匹配；如果经验积累到几百条，可能需要按场景自动挑几条进上下文——那属于投影层策略，不在库里做索引。
4. **`target.json` 的版本**：Target schema 由 Construction 版本化；库只存 schema 身份与字节，schema 升级后的迁移策略归 Construction。
