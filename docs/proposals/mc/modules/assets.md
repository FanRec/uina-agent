# Assets：程序、蓝图与经验的详细设计

日期：2026-10-17（Asia/Shanghai）。状态：**详细设计，供评审；未授权据此实施代码，未经过真实 Minecraft 验收**。

本文只规定 Minecraft World 的 Assets 边界。它不把旧版资产专节当作既定答案，也不把尚未实现的 Runtime、Construction 或 Minecraft 执行能力写成已实现事实。

**Runtime 对齐（2026-10-17）**：Assets 的唯一发布合同是普通工作文件/导入 → 受管 staging → SQLite 目录/CAS + 不可变文件包。Runtime 只通过 `ProgramSourcePort`/`EvidenceExportPort` 导出指定不可变 record 的有限材料；不使用旧的 `RuntimeAssetSourcePort.capture`、跨库 owner O/C 或资产侧 retain/release。本文保留“从运行段发布”的业务场景，但其来源是一次固定导出，不是 Runtime 的长期资产事务。

## 1. 四个根本裁决

### 1.1 存储结构

采用 **SQLite 目录与 CAS + 普通文件内容**：

- SQLite 保存仓库身份、资产名称、当前 head、不可变版本元数据、CAS 条件、依赖、来源索引、证据索引和可选的操作终局结果。
- 普通工作文件由宿主文件能力保存；Assets 文件系统只管理已发布不可变包、证据副本和本次发布的临时输入。Program 源码是普通 `program.js`；`.schem`、`.litematic` 等按原始字节保存；Experience 使用 JSON，可带 Markdown 说明。
- SQLite 不保存源码或蓝图 BLOB，也不冻结 1 MiB 分块、固定 WAL/FULL 或最大附件大小。文件流已经是该问题的成熟机制，只有实测出现瓶颈才重新考虑压缩、内容寻址或共享对象。

三条路线的裁决如下：

| 路线 | 解决的问题 | 引入的问题 | 裁决 |
| --- | --- | --- | --- |
| 全 SQLite（含普通或分块 BLOB） | 目录与内容可在一个数据库事务中提交 | Draft 仍可用普通文件编辑，但发布内容需复制入库，运行和导出依赖数据库读取；不利于保留独立普通文件包 | 不采用 |
| 全文件、无 SQLite | 编辑和迁移最直接 | 名称头、整数版本、依赖查询、CAS 和并发目录都要自己扫描/维护 | 不采用 |
| SQLite 目录 + 文件包 | 保留文件生态；小而稳定的目录事实由 SQLite 管理 | 两个存储没有共同原子 COMMIT，需要内容先稳定、发布后核对和 orphan 报告 | **采用** |

文件工作区加 SQLite 发布内容同样可以满足编辑与字节保真；本稿保留混合方案，是为了普通文件包可直接导出、检查和复用，并复用现有文件流处理大型原件。这是对透明性与单事务便利性的取舍，不是文件必然更快或 BLOB 无法保真的结论。文件与数据库的边界公开承认，不用分布式事务协议伪装成一个存储。

### 1.2 对象关系与所有权

```text
Asset（逻辑名称、kind）
  └─ Revision（不可变成果版本）
       ├─ Payload（manifest 与内容文件）
       └─ Evidence（独立关联的事实副本/来源）
工作文件 / Draft（Workspace 的可变编辑状态；不归 Assets 管理，不属于版本历史）
```

- **Asset** 只拥有逻辑名称和内容种类。
- **Revision** 只在调用者明确发布成功时创建。工作文件修改、调试和实验不会自动生成版本；若要把源码、领域内容、Manifest 或作者元数据变化正式保存，就发布新 Revision。已发布标题、描述和标签不可直接修改。
- **Draft** 只是工作区里尚未发布的普通目录，可从空白、导入文件或确切 Revision 复制得到；没有 Assets Draft ID、所有者、表或生命周期，不是可运行版本。
- **Payload** 是 Revision 的文件字节。文件包内的 manifest 是内容合同；SQLite 是目录和索引事实，不是第二份完整内容模型。
- **Evidence** 关联 Revision，但不改变 Revision 的内容摘要。新增运行记录、测试记录或当前引用不强迫创建新成果版本。

所有权保持单向：Assets 管理内容生命周期和目录；Runtime 管理执行事实；World 管理世界观察和世界身份；Construction 管理 Raw 到 Target 的解释、现场计划和工程事实。Assets 不判断代码是否完成目标，不把现场进度写入蓝图，不把运行返回值认证成结论。

### 1.3 最少持久状态

必须持久化：

- 当前资产 head 和不可变 Revision 元数据；
- 确切依赖、弱来源和独立 Evidence 索引；
- 可选 `(可信调用者, operationId) → 已提交结果`，只与发布在同一事务提交，不持久保存未提交操作的状态。

不持久化 Assets 专属 pending、任务调度器、分支/合并状态、引用计数、自动 GC、证据评分器或知识图谱。没有可靠 `operationId` 时不承诺恰好一次；COMMIT 后回执丢失报告 `unknown`，不假装失败并盲目重放。

### 1.4 人和 Uina 的工作方式

人类通过 VS Code 等编辑器、Uina 通过已有文件工具，在同一工作目录编辑 Manifest、源码、蓝图和 JSON；未来前端复用这些文件操作，不在 Assets 新建编辑状态。只有明确调用 publish 才创建 Revision。Assets 的 library 只负责发现、读取与受权限约束的发布/证据关联，不提供文件编辑入口。发布捕获的私有副本只属于当前调用，不是持久 Draft 或任务。

## 2. 范围、非目标与术语

### 2.1 必须支持

| 场景 | 必须成立的行为 |
| --- | --- |
| 编辑程序 | VS Code、Git、diff 和 Uina 已有文件工具修改普通工作文件；函数体静态检查由 Program 适配 |
| 发布 | 得到不可变的 `name@整数`，保存源码摘要、manifest、依赖和来源 |
| 运行 | Runtime 固定确切版本、依赖和实际执行源码字节 |
| 导入蓝图 | Raw 原件字节可原样导出；解析失败不替换为空建筑 |
| 原生蓝图 | `set/clear/preserve/unknown` 四态不混淆；Construction 再解释为施工计划 |
| 经验修订 | 判断、适用条件或反例改变才新版本；新 Evidence 独立关联 |
| 故障 | 能区分未提交、已提交但回执丢失、文件损坏、数据库损坏和未知事实 |

### 2.2 明确不做

不执行 JavaScript、不控制 Bot、不获取身体资格、不保存执行栈；不把 Blueprint 变成库存/顺序/服务器事务；不实现多人协同编辑、Git 分支、公共市场、向量检索、自动学习、自动下载 URL 或无请求的后台整理。

## 3. 引用、名称与格式 Schema

### 3.1 仓库局部引用

本仓库使用可读整数版本：

```text
<name>@<positive-integer>
例如：user.parkour@3
```

同一名称只能属于一个 `kind`，避免 `castle@1` 在 Program 与 Blueprint 之间歧义。版本从 1 开始，已提交版本不删除、不复用；回退是复制旧内容发布为新版本，例如从 `@2` 产生 `@4`，不移动 head。

名称规范：

```text
^[a-z0-9][a-z0-9._-]{0,95}$
```

名称统一小写，允许 `.`、`_`、`-`；禁止 `/`、`\\`、控制字符、`@`、空名称、`..`、尾随空格/点以及 Windows 保留设备名（大小写不敏感的 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9` 作为路径首段）。展示用中文或长标题放在 `title`，不进入路径。

`name@version` 只在一个仓库内有意义。跨仓库引用使用结构化值：

```typescript
interface RepositoryRef { repositoryId: string; name: string; version: number }
```

### 3.2 格式 Schema 不是资产

格式 Schema 只表示内容编码合同，不创建一个额外资产：

```typescript
interface FormatSchema { family: string; version: number }
type AssetKind = "program" | "blueprint" | "experience";
type ExactRef = `${string}@${number}`;
type Digest = `sha256:${string}`;
type Ref = string;
type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
interface Vec3 { x: number; y: number; z: number }
```

`FormatSchema` 的解析器可以不可用；这时原件仍可保管和导出，不能把“当前不能解释”报告成“内容损坏”。

## 4. 文件布局与权威关系

```text
<worldDataDir>/assets/
  catalog.sqlite
  objects/<objectId>/manifest.json
  objects/<objectId>/program.js|source.schem|experience.json
  evidence/<copyId>/...
  tmp/<attemptId>/...
```

工作文件位于宿主 cwd 下调用者选择的普通目录，例如 `workspace/collect_wood/manifest.json` 与 `program.js`，不放进 Assets 私有存储；宿主已有项目工作区也可直接使用，无强制目录布局。`objects/<objectId>` 是不可变包，SQLite 保存 `name@version → objectId`。objectId、attemptId、copyId 由可信宿主生成且不复用；每次尝试独占 staging，不因 operation.id 相同共用可写目录。

工作目录中的 manifest.json 使用 AuthorManifest（§6.1），是作者元数据、领域定义及可选编辑来源声明的唯一编辑入口，不手填摘要。发布只从这次捕获的作者内容生成文件表，不另造领域模型：

```typescript
interface PayloadEntry {
  path: string; mediaType: string; byteLength: number; digest: Digest;
}
interface PackageManifest {
  packageSchema: 1;
  author: AuthorManifest; // 不含工作区 editing 声明
  payloads: PayloadEntry[];
}
```

包 kind、领域 format 和作者元数据从 author 读取；requires 由 Program 的资产依赖投影到数据库，不在 Manifest 再维护一份可竞争的依赖表。SQLite 的标题、摘要、标签是冻结 author 的查询投影，不能独立编辑。Manifest 与源码合同不一致时拒绝发布，不自动推断任意 JavaScript 的真实参数与依赖。发布成功不重写工作文件。复制历史版本编辑时，读取确切 Revision 的包 Manifest，将 author 写成工作 manifest.json，再复制声明的 payload；编辑来源可另存为工作区 Manifest 的 `editing` 声明，但它不进入 PackageManifest、`inputDigest` 或 `packageDigest`，也不表示程序语义。

摘要均使用 SHA-256。`J` 表示 UTF-8 JSON：对象键按 Unicode 码元序递归排序、无空白、数组顺序保留、字符串与有限数字按 ECMAScript JSON.stringify 编码，整数处于安全范围；不接受未表示为带类型字符串的大整数、NaN、Infinity 或重复 JSON 键。作者 tags 按集合排序去重，其他数组保留顺序。文件 mediaType 按 §5.2 的固定路径规则推导。

`inputDigest = sha256(J({domain:"assets-input/1", author, payloads}))`：author 是捕获后去除工作区 `editing` 元数据的作者 Manifest 规范值，payloads 是只含声明发布文件的真实路径、媒体类型、长度、原始字节摘要表，按 ASCII 相对路径字节序排序。作者 JSON 排版、editing 声明和未声明笔记不改变内容输入身份；源码和 Raw 原件的每个字节都参与摘要。这里没有工作区 treeDigest。editing 若参与 operation 的意图指纹，只作为 `sourceIdentity` 的来源声明参与，不成为成果内容身份。

包 Manifest 以 J 编码；`manifestDigest` 为这些实际字节的摘要，`packageDigest = sha256(J({domain:"assets-package/1", manifestDigest}))`。Manifest 中 payloads 的摘要和长度间接覆盖所有 payload 实际字节，读取时仍须逐项核对，不能仅 hash Manifest 就宣称内容完整。摘要不覆盖 objectId、逻辑版本、路径、head、createdAt、operationId、独立来源/Evidence 索引。摘要证明内容身份，不证明来源可信、执行安全或游戏目标完成。

## 5. 工作文件复用与发布捕获

### 5.1 现有能力与裁决

本轮直接核对的源码事实：

- `src/extensions/workspace-tools/index.ts` 注册 read_file、write_file 和 edit_file；Host 默认装配 builtin:workspace-tools，可用 workspaceTools=false 关闭。
- 文件路径使用 `resolve(api.cwd, path)`，可接受绝对路径；write_file/edit_file 用同目录临时文件加 rename。现有实现没有目录沙箱、摘要 CAS 或多文件事务，edit_file 的文本匹配也不是并发锁。
- `src/tools/broker.ts` 的 ScopedToolView 在 prepare/execute 时检查工具 include/exclude。Minecraft 的 ReadCallContext/CallContext 以 read/act 区分 Assets 能力；这些是可复用接缝，不等于 Minecraft 已实现新的 Assets API。

裁决：复用现有受信任文件能力编辑，**删除 DraftRepository、drafts 表及 Assets 的编辑锁/摘要/生命周期**。原先的单文件 CAS 并非现有文件工具的保证，本稿也不为了保留它建立另一个编辑系统。人机修改同一文件时须交接或自行使用独立普通目录；冲突控制由文件能力演进承担，不能把发布 CAS 宣称成编辑合并。

现有工具的访问控制是宿主选择可用能力，不是路径隔离。一般本机编辑者可被授予文件写入；受限 Minecraft read 脚本只取得 ReadLibrary，不获得通用文件工具、shell、Node fs 或完整 Repository。若宿主另行授予同一主体完整本机文件权，那是独立的可信能力，不能再宣称该主体整体处于只读沙箱。未来前端通过同一宿主文件操作处理文件，不复制 Assets 编辑业务；没有前端实现验收。

现有文本工具足以创建 Manifest、Program 和 Experience/Target JSON，write_file 会创建父目录。Raw 蓝图二进制原件搬运使用已有且明确授权的 shell/宿主导入流，解释和转换交给 Construction，不把二进制转成模型中的 Base64，也不新建文件平台。

### 5.2 调用身份与来源定位

Principal 由宿主依照真实 session/call scope 绑定，不能来自模型 JSON、Manifest 或脚本参数。稳定调用者 ID 用于 operation 键，临时 invocationId 不作为重试身份。每次写入及提交前检查 scope 仍有效和 act 访问权。Assets 不拥有 workspaceId、Draft owner 或文件锁。

```typescript
interface Principal {
  readonly id: string;
  readonly kind: "human" | "uina" | "runtime" | "construction" | "host";
}
interface WorkspaceSource {
  kind: "workspace";
  directory: string; // 相对宿主绑定 workspaceRoot 的普通目录；不是任意系统路径
}
```

可信接入把宿主已有 cwd/工作根绑定为 workspaceRoot；本 API 不接受模型指定新工作根。directory 及 Manifest 声明路径经规范化后必须留在该根内，拒绝绝对路径、路径穿越和符号链接/reparse point；工作根不能是仓库的 objects/evidence/tmp。此检查只约束 Publish 读入来源，不是通用文件工具沙箱，也不新建 Workspace 管理平台。根外文件经可信导入流显式传入。Repository 的宿主内部实现不向脚本公开其工作根或任意 Node 对象。

mediaType 按安全文件扩展名推导：.json → application/json、.js → text/javascript、.md → text/markdown，其余 application/octet-stream；导入声明匹配同一规则。它只是提示，不认证内容。未完成的 Manifest 不影响通用文件工具读写，但不能发布。

### 5.3 一次捕获与取消

1. 在本次调用的 `tmp/<attemptId>` 中把 Manifest 读取一次并固定；随后只解析此副本以确定作者定义、编辑来源和声明文件，拒绝重复/大小写冲突及非法路径。
2. 逐项把声明文件各读取一次到同一 staging，在接收过程中计算摘要与长度。不扫描额外笔记，不重新读取源 Manifest，不先复制到另一份导入临时包。
3. 关闭源句柄，此后只验证和发布 staging 内容；通过后生成包 Manifest，在同一文件系统 rename 安装。原工作目录无需保留到提交结束。

捕获没有与通用 write_file、VS Code 或任何外部编辑器共享的锁。它只保证校验并发布此次读到的固定字节，不保证文件系统某一原子时刻，也不能证明作者完成了一组修改。严格一致的发布要求调用者保存全部文件并停止编辑直到捕获结束；检测到缺项/读取失败/内容身份不符就失败，不自动重读混合成另一组内容。无需双扫描、文件锁平台或持久 pending。

删除工作目录只影响未捕获的源，不能撤销已经捕获或已提交的版本；取消在途发布使用该操作的 signal。捕获完成即可继续编辑，Assets 不回写或自动推进工作 Manifest 的 baseRef。

Runtime 导出和外部流直接接收至同一 staging，不强制先创建工作文件。可信端口应提供固定 bytes/可单次读取的流；接入计算 inputDigest 时已有完整字节可直接复用，必须落盘时复用本次 staging，不再复制第二份。流提供者从可变外部文件读取的原子性不能由接收端补足。

## 6. 版本、Manifest 与发布合同

### 6.1 请求与结果

```typescript
interface ImportedFile {
  path: string; mediaType: string; bytes: AsyncIterable<Uint8Array>;
  byteLength: number; digest: Digest; // 声明身份必须与接收的实际字节相符
}
interface AuthorMetadata { title: string; summary: string; tags: string[] }
type ImportDefinition =
  | { kind: "program"; metadata: AuthorMetadata; definition: ProgramManifest }
  | { kind: "blueprint"; metadata: AuthorMetadata; definition: BlueprintDefinition }
  | { kind: "experience"; metadata: AuthorMetadata; sourceFile: "experience.json"; notesFile?: "notes.md" };
type AuthorManifest = ImportDefinition;
type WorkspaceManifest = AuthorManifest & {
  editing?: { baseRef: RepositoryRef | null }; // 作者可编辑的来源声明，不是可信历史
};
interface ImportSource {
  kind: "import";
  definition: AuthorManifest;
  files: ImportedFile[]; // 仅 payload，不能注入已发布 Manifest
  label?: string;
}
type PublishSource = WorkspaceSource | ImportSource;
interface PublishOperation {
  id: string; // 可信接入生成并在传输重试中复用，模型不填
  inputDigest: Digest; // 本次声明发布文件的不可变输入身份，不能只 hash 流对象或路径
}

interface PublishRequest {
  operation?: PublishOperation;
  name: string;
  kind: AssetKind;
  expectedRef: ExactRef | null;
  intent?: "revise" | "replace_current"; // 默认 revise
  source: PublishSource;
  sourceLinks?: SourceLink[];
}
interface PublishResult {
  ref: ExactRef;
  previousRef: ExactRef | null; // 发布前的 head，表示线性历史前驱
  derivedFrom: RepositoryRef | null; // WorkspaceManifest.editing.baseRef 的声明投影，不证明实际派生
  packageDigest: Digest;
  objectId: string;
  packagePath: string; // 由 objectId 派生的只读路径
  head: { ref: ExactRef; changedFrom: ExactRef | null };
}
```

`expectedRef=null` 只用于不存在的资产；创建得到 `@1`。修订必须携带当前 head 的确切引用，成功得到下一个整数。CAS 检测发布期间的 head 冲突，不自动 rebase 或合并；旧编辑基准的处理另由下述作者声明与显式意图规则约束。source 明确给出宿主工作根下的目录，或定义和确切输入流；不是抽象来源分类。

发布 kind 必须与固定 author.kind 相同；资产名称由请求明确指定，未发布目录名不充当资产身份。默认 intent=revise 时，若存在 editing.baseRef，必须与本仓库 expectedRef 的 repositoryId/name/version 相同；创建可省略，修订缺少声明或声明不符返回 REVISION_CONFLICT。不相同或修订缺少声明返回 REVISION_CONFLICT。从旧版回退、跨仓库复制或用新内容替换已有名称须显式 intent=replace_current，仍必须对当前 head 执行 expectedRef CAS。

这条基准检查只防止**尚未修改的旧来源声明**被忽略，不证明作者真的合并了变化。编辑者可以改写 baseRef；本设计不能识别伪造的来源声明，不能延续“Assets 已核验实际派生历史”的承诺。previousRef 是数据库确认的发布前 head；derivedFrom 是从本次 WorkspaceManifest 读取后写入来源索引的声明投影，不在 PackageManifest、inputDigest 或 packageDigest 中，也不是可信派生外键。Runtime record 与可信来源仍由 Runtime 独立导出，不从编辑文字认定。

发布后 baseRef 不自动变化，避免文件写入与 SQLite 再形成双存储状态。继续修改时，由编辑者读取发布结果、检查未发布改动后更新 Manifest；手工合并和回退均由调用者负责，不建立分支、合并或签名来源平台。

**导入 Manifest 由领域适配生成并验证。** 输入仅包含带作者元数据的领域定义和带长度/摘要的 payload，仓库不从扩展名推断 Program descriptor 或施工目标。适配器将 `AuthorManifest` 按 §4 的 `J` 编码成作者 `manifest.json`，它与声明的发布 payload 共同定义 inputDigest；捕获后再生成包 Manifest 的 payload 表。工作文件、Runtime 导出与 import 最终走同一组领域验证函数，不建立通用 Prepare 框架。发布请求不再重复传标题、描述或标签；这些值只从固定的作者 Manifest 读取。

- Program：必须提供完整 ProgramManifest；检查 descriptor/schema、sourceForm、源码 UTF-8/语法、资产 dependencies/bindings 的结构。不执行代码，不要求当前运行环境可调用才允许保存。工作区 Manifest 可另有 editing 字段，但归一化为 PackageManifest.author 时必须删除。
- Raw Blueprint：只保存 `representation=raw`、sourceFile、可选 formatHint 的内容定义；详细 decoder 和转换规则由 Construction 提供。
- Target Blueprint：由 Construction 提供目标 Schema 验证结果；Assets 不实现第二套 Block/NBT 解析器，验证器不可用时不能声称已验证 Target。
- Experience：读取 experience.json 并验证判断/条件/来源引用的结构；不验证判断为真。可选 notes.md 作为普通 payload。

ImportSource 的 payload 必须与领域定义引用的集合一致；缺项、多项、重复路径、大小写冲突、保留路径 `manifest.json`、长度/摘要不符均拒绝。普通工作目录可以保留未声明文件，但发布仅选声明 payload；不得因缺项而改选别的文件。数据库 requires 投影从 Program dependencies/bindings 中已确认属于本仓库 Program 的确切引用派生；原生或尚不能识别的 Callable 依赖仍完整保留在 ProgramManifest，由 Runtime 检查，不伪造成本仓库资产外键。Experience 的 appliesTo/support 是语义关联，不是存储依赖。`sourceLinks` 是作者声明的弱出处，不提升为 Evidence。Evidence 在版本发布后独立关联，失败不撤销发布。

### 6.2 从运行段发布

`run_segment` 不伪装成通用 Prepare/Publish 框架，而是一个可信适配操作：

```typescript
interface RunSegmentRequest {
  operation?: PublishOperation;
  name: string;
  expectedRef: ExactRef | null;
  run: Ref;
  segment: Ref;
  record: Ref; // Runtime 的不可变截面；不能重试时重新选择“最新段状态”
  intent?: "revise" | "replace_current";
  authorMetadata: AuthorMetadata;
}
interface ProgramSegmentExport {
  implementation: "program";
  sourceBytes: Uint8Array | AsyncIterable<Uint8Array>;
  manifestBytes: Uint8Array | AsyncIterable<Uint8Array>;
  effectiveBindings: ProgramBinding[];
  nativeEnvironment: Ref;
  record: Ref;
  sourceDigest: Digest;
  sourceRef: Ref;
}
interface NativeSegmentExport {
  implementation: "native";
  descriptor: CallableDescriptor; // 执行时冻结的完整 descriptor，含确切 ref
  nativeEnvironment: Ref;
  record: Ref;
  implementationDigest: Digest; // Runtime 当时使用的实现身份，不是包装源码摘要
}
type ProgramExport = ProgramSegmentExport | NativeSegmentExport;
interface ProgramSourcePort {
  exportSegment(request: { run: Ref; segment: Ref; record: Ref }, signal?: AbortSignal): Promise<ProgramExport>;
}
```

`publishFromRun` 由 Runtime 的可信 `ProgramSourcePort` 导出指定段的不可变输入，再由 Assets 内的程序格式适配生成发布内容，进入同一个发布事务；不调用 Program 引擎执行或认证代码。Program 段导出执行时冻结的源码字节、manifest 和 effectiveBindings；原生段导出执行时冻结的 descriptor、确切原生 ref 与实现身份，不要求存在 JavaScript 源码。不能从当前同名 head 或当前原生目录补全，不能把“成功”文字当源码，不能把整段运行历史自动塞入 Program。

调用者先选择 Runtime 返回的确切 record；可信接入用 `authorMetadata` 与适配后的固定内容构造作者 Manifest，再从该 Manifest 和发布源码计算 inputDigest，不要求模型 hash 代码。Program 段的 manifestBytes 按实际 ProgramDefinition 构造：`effectiveBindings` 转为唯一 `bindings` 字段。nativeEnvironment/record 保存在可信来源记录，不增加第二份解析表。

原生段采用唯一的简单包装：Program 适配器用严格 UTF-8 编码生成 `return await mc.call(<JSON 字符串编码的确切原生 ref>, input);`，保留固定换行；descriptor 完整复制冻结 descriptor 后去掉 ref/implementation，dependencies 为空，bindings 为显式空数组（包装没有裸名调用）；确切原生 Callable ref 只存在于生成源码的 `mc.call(...)` 字面量和可信来源 metadata，不伪装成 Assets 依赖。不复制原调用参数、返回值或 checkpoint 作为新程序默认值。包装源码有自己的 sourceDigest；原生 implementationDigest/nativeEnvironment/record 属于来源，不能冒充包装执行证据，也不保证未来环境仍提供相同原生实现。新包装尚未执行，运行可用性和权限仍由 Runtime 检查。

publishFromRun 不从 record 猜测作者编辑基准，生成 author 时不填写 editing.baseRef；创建可用默认 intent，替换已有名称须显式 replace_current，仍只需一次 expectedRef CAS。运行来源、scope、descriptor 与 record 的对应由 Runtime 核验；不能提供完整冻结输入的段返回 `ASSET_SOURCE_UNAVAILABLE`，不能猜测包装。来源被清理且无可导出副本时失败；Assets 不为此增加持久 capture/pending 协议。

### 6.3 发布顺序

```text
核验宿主身份/权限，规范化请求；若有 operation，先查询既有成功结果
→ 从工作文件、import 或固定 Runtime 导出捕获一次至 tmp/<attemptId>
→ 校验作者 Schema、领域内容、声明基准与 intent，以及实际 inputDigest（如提供 operation）
→ 在同一 staging 生成包 Manifest，计算 packageDigest，关闭并同步文件
→ BEGIN IMMEDIATE；重新查询 operation，同意图已有成功结果则返回它
→ 再次核验宿主准入、当前 head 的 expectedRef CAS 条件和 kind
→ n = COALESCE(head_version, 0) + 1；生成不复用的 objectId
→ rename 安装全新 objects/<objectId>，禁止覆盖
→ 从固定 author 投影元数据、格式和依赖；插入 Revision（previous_version=原 head）与来源
→ 以原 head 为条件更新 head；若有 operation 则同一事务保存 intentDigest 与最终结果
→ COMMIT 确认后返回确切版本；不修改或删除原工作目录
```

内容先稳定、目录后可见，所以 DB 未提交留下的包只是未索引候选；它不对外可读。SQLite 和文件系统没有共同断电 COMMIT：数据库已提交而包后来缺失或摘要不符时，保留已提交 ref 并报告 `ASSET_CORRUPT`，不补空、不换版本。

单一 Assets writer 串行提交，读可并行；长捕获/验证不放在 Driver 反馈循环或模型回合线程。可变输入在捕获后无需保持存在，没有需要回写的 Draft 基准或工作区记录；取消只结算本次调用，不隐式删除已安装或可能已提交内容。

### 6.4 操作幂等、取消和回执丢失

`operation` 可选，键作用域为 `(宿主绑定 ownerId, operation.id)`。接入产生 ID，保存并复用整个 operation token 与原请求；不把模型调用参数、invocationId 或流句柄当可靠重试记录。相同 ID 只保证**至多一个发布成功**，不承诺最终必成功或首个未提交尝试的意图永久占有 ID。

`intentDigest = sha256(J({domain:"assets-publish/1", repositoryId, ownerId, method, name, kind, expectedRef, intent, inputDigest, sourceIdentity, sourceLinks}))`。ownerId 是宿主绑定的稳定调用者身份，没有 Draft owner；省略 intent 规范化为 revise。sourceIdentity 对 workspace 为规范化 directory；对 import 为规范化 definition、文件声明和 label；对 run 为 run/segment/record 与 authorMetadata。inputDigest 已覆盖 author 与声明 payload；API 自行计算 intentDigest，模型不能提交它。

普通发布不要求 operation，也不为生成 token 预先扫描整个工作区。需要内容绑定幂等时，可信接入须先掌握固定 author/文件字节或其完整身份；import 可用已声明的文件摘要，Runtime 可用固定 record 导出，工作文件可用接入已经持有的确定内容身份。实际捕获后必须核对 inputDigest；不符为 ASSET_SOURCE_CHANGED，实际流长度/声明摘要不符为 ASSET_INVALID。不能用路径、mtime、局部源码摘要或可变流对象代替完整内容身份。

接入若需先接收或落盘才能算摘要，复用同一份接收缓冲/本次 staging，不再复制一次给 Assets；这是宿主内部所有权转移，不是模型可填写的 staging 路径或持久 Prepare 句柄。若接入无法预先固定输入，正常路径省略 operation，或只保留可核验的结果查询，不能暗示失败后可安全重读当前文件作为原请求。至多一次保证依赖成功行与内容绑定 token，不建立 pending 或任务账本。

查到同键且 intentDigest 相同的成功行时，在当前身份授权允许查询的前提下返回原 PublishResult，**先于当前 head CAS 和源读取**；不消费重传流，也不重新验证可能已删除的工作目录/run。重传流若实际不同也不会发布它，返回值明确为原操作结果。查到同键不同 intentDigest 则 `OPERATION_CONFLICT`。同键并发调用可都 staging，但事务内第二次查询确保只提交一次；失败/cancelled 结果不写 operations，也不保留未提交意图。

`getOperation(id)` 在健康数据库读取时返回 `committed` 或 `absent`；absent 只表示该次查询尚无提交记录，可能另一个调用仍在进行，不表示终局失败。查询/COMMIT 无法核实返回 `unknown`。COMMIT 的成功行与 Revision/head 原子提交：即使 head 后来推进，仍返回原结果；返回结果中的 head 是提交当时的 head。缺行时可用**原 token、原 expectedRef 和同一不可变输入**再尝试，不能重新读当前工作文件当成原重试。

| 时点 | 对外事实 |
| --- | --- |
| 开始读取前取消 | `not_started`，无版本 |
| 输入复制/校验中取消 | `cancelled`，tmp 可回收，无版本 |
| COMMIT 已确认 | `succeeded`，取消不能删除版本 |
| COMMIT 后回执丢失 | 有 token 则 getOperation/同请求重传；存储无法核实时仍 `unknown`；无 token 不可用 digest/head 唯一归因到本次调用 |
| expectedRef 或 revise 的作者基准声明不符 | `failed/REVISION_CONFLICT`；不修改源文件，重新派生/合并或显式 replace_current |

取消在进入最终文件安装/事务提交临界区前检查；进入后不因 signal 中断事务，先结算 COMMIT/ROLLBACK。COMMIT 成功返回 succeeded；确认回滚才可返回 cancelled/failed；无法确定提交事实则 unknown，不能删可能已发布的包。不新增持久 pending；operations 只保存成功结果，调用失败回执与成功重放不是同一保证。数据库丢失/重建或任意历史备份回滚后，不能维持跨灾难的至多一次承诺。

## 7. SQLite Schema、索引与恢复

<a id="storage"></a>

### 7.1 最小 Schema

下面是实现所需的最小表族。SQLite 连接必须开启 `PRAGMA foreign_keys = ON`；具体 journal/synchronous 参数留给实测和运行环境。

```sql
CREATE TABLE repository (
  repository_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE asset_heads (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('program','blueprint','experience')),
  head_version INTEGER NULL CHECK (head_version IS NULL OR head_version > 0),
  created_at TEXT NOT NULL,
  UNIQUE (name, kind),
  FOREIGN KEY (name, head_version) REFERENCES asset_revisions(name, version)
);

CREATE TABLE asset_revisions (
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('program','blueprint','experience')),
  previous_version INTEGER NULL,
  format_family TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  object_id TEXT NOT NULL UNIQUE,
  package_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (name, version),
  FOREIGN KEY (name, kind) REFERENCES asset_heads(name, kind),
  FOREIGN KEY (name, previous_version) REFERENCES asset_revisions(name, version)
);

CREATE TABLE asset_dependencies (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  dep_name TEXT NOT NULL,
  dep_version INTEGER NOT NULL,
  PRIMARY KEY (name, version, dep_name, dep_version),
  FOREIGN KEY (name, version) REFERENCES asset_revisions(name, version),
  FOREIGN KEY (dep_name, dep_version) REFERENCES asset_revisions(name, version)
);

CREATE TABLE asset_sources (
  source_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  owner_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  description TEXT NOT NULL,
  CHECK (owner_kind IN ('runtime','world','file','external')),
  FOREIGN KEY (name, version) REFERENCES asset_revisions(name, version)
);

CREATE TABLE asset_evidence (
  evidence_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('runtime','world')),
  source_ref TEXT NOT NULL,
  schema_family TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_relpath TEXT,
  payload_digest TEXT,
  payload_byte_length INTEGER,
  completeness TEXT NOT NULL CHECK (completeness IN ('self_contained','partial','link_only')),
  metadata_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (name, version) REFERENCES asset_revisions(name, version)
);

CREATE TABLE operations (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_name TEXT NOT NULL,
  committed_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, operation_id),
  FOREIGN KEY (committed_name, committed_version) REFERENCES asset_revisions(name, version)
);

CREATE INDEX asset_revisions_kind_idx ON asset_revisions(kind, name, version);
CREATE INDEX asset_revisions_text_idx ON asset_revisions(name, title);
CREATE INDEX asset_dependencies_dep_idx ON asset_dependencies(dep_name, dep_version);
```

`asset_heads.head_version` 是唯一可变 head 状态，没有 `nextVersion` 或任意回指字段；写事务锁定该行后用 `head_version + 1` 分配逻辑版本。`asset_revisions.object_id` 把逻辑版本映射到不可变物理对象，objectId 不复用。数据库索引只保存可查询的元数据和依赖投影，Manifest 仍是内容合同；索引损坏可重建，不能反向覆盖包。

创建先在该事务插入 head_version=NULL 的名称行；修订必须已有同 kind 名称行。先插入 Revision，再更新 head，因此两表相互引用无需延迟外键。组合外键保证 head 只能指向本资产已有 Revision，NULL 只用于创建事务内的临时名称行。CAS 采用 `UPDATE asset_heads SET head_version=:n WHERE name=:name AND head_version IS :expectedVersion`（创建时 expectedVersion=NULL），要求 changes=1；否则整笔回滚。Revision.previous_version 是数据库确认的提交前 head。derivedFrom 由本次 WorkspaceManifest 的 editing.baseRef 读取并写入来源索引，明确是作者声明；不设 derived_from_version 列或可信派生外键。

`operations` 中存在一行就表示对应版本成功提交，不再持久保存另一个 final_status。没有 drafts 表或 updated_at 编辑状态，也不跟踪外部编辑时间；文件编辑不与目录数据库同步。`asset_dependencies` 只投影确定属于本仓库的资产引用，不将 native Callable/environment 的 Ref 写进资产外键。

### 7.2 读取与完整性

`read(ref)` 只接受确切引用，读取数据库目录元数据及核对过的包 Manifest；derivedFrom 从来源索引的作者声明投影，缺失为 null；`readPayload(ref,path)` 逐文件流出 bytes，但只有流完整读到结束并核对实际长度与摘要后，调用者才可认为读取成功。错误可能在已经产出部分 chunk 后、流结束时报告；不能把首块或文件句柄打开当作成功。当前 head 解析只用于发现，Runtime 必须在受理时固定为确切 ref 和 packageDigest。

数据库行存在但 package 缺失、路径逃逸、manifest kind 不符、长度或 digest 不符，返回 `ASSET_CORRUPT`。格式解析器不可用返回 `SCHEMA_UNAVAILABLE`，原始文件仍可读。

### 7.3 备份、恢复与孤儿对象

具体备份与恢复步骤见 [Assets 维护合同](assets-maintenance.md)；本设计只规定一致性合同：使用 SQLite Backup API（或在静止窗口关闭全部连接并完成 WAL checkpoint）生成数据库快照，同时复制该快照引用的 `objects/<objectId>` 和 Evidence 副本，并核对长度与摘要。暂停 Assets writer 但仍只复制主数据库不构成有效备份。普通工作目录归文件能力管理，不属于 Assets 一致备份集合；若另行备份，外部编辑未停止时只承诺尽力工作副本。数据库快照、已发布对象和 Evidence 必须作为同一恢复集合，不能把不同时间点拼接。数据库或文件单边恢复只能报告不完整。

普通进程崩溃后，数据库未引用的对象目录和 tmp 候选保留为 orphan，启动或维护命令报告其 objectId、来源不明和占用空间；不自动删除、认领或影响新的逻辑版本分配。数据库已提交但对象缺失或摘要不符时，已提交引用保留并报告 `ASSET_CORRUPT`。数据库不可读时不靠文件树推断提交历史；离线重建只能生成恢复候选。

### 7.4 对象安装边界

对象安装先在同一文件系统写入 `tmp/<attemptId>`，按 §6.3 校验、关闭并同步后，在最终提交临界区 rename 为全新 `objects/<objectId>`，禁止覆盖已有对象。路径若意外已存在，本次失败，不检查后认领、不覆盖也不隔离；后续尝试使用新 ID。SQLite 事务随后插入 `asset_revisions.object_id` 并推进 head。若事务回滚，留下的对象只是未引用 orphan；下次发布生成新的 objectId，不复用或覆盖旧对象。逻辑整数版本只由 SQLite head 分配，物理目录不再占用或决定版本号，因此不需要版本目录隔离协议。同步采用实际 Node/Windows 支持并验证过的文件句柄操作，不依赖 fs.constants.O_SYNC 假设；写入顺序仍不等于跨存储断电原子性。

### 7.5 文件包与迁移

单独复制 objects/<objectId> 只得到内容包，没有资产名称、逻辑版本、head、operation 结果或独立来源/Evidence 关联；对象 ID 也不能证明曾正式提交。复制包后若要在另一个仓库复用，由普通文件/导入能力提取 author 与 payload，校验后明确发布为目标仓库的新身份。工作区的 editing.baseRef 若另行携带，只是作者来源声明，不能把它当作目标仓库的 head 或可信来源。

完整迁移使用维护文档的一致数据库/引用文件集合，保留原 repositoryId；外部弱链接是否仍可读取另行判断。不得把外仓库 Evidence 包装成当前 Runtime/World 自己导出的记录。工作目录单独迁移，不属于 Assets 目录事实。当前不建立自动跨仓库迁移器、去重、GC 或引用计数。

## 8. Program

### 8.1 内容结构

```typescript
import type { CallableDescriptor } from "../../../../.uina/worlds/minecraft/contracts/callables.js";
import type { ProgramBinding } from "../../../../.uina/worlds/minecraft/contracts/program.js";
type ProgramDescriptor = Omit<CallableDescriptor, "ref" | "implementation">;
/** 当前 contracts/program.ts 使用 ExactRef 作为字段形状；Assets 只允许其中能解析为本仓库 Program 版本的值。 */
type AssetProgramRef = ExactRef;
interface ProgramManifest {
  format: FormatSchema;
  descriptor: ProgramDescriptor;
  dependencies: AssetProgramRef[]; // 仅已发布 Program 资产依赖
  bindings?: ProgramBinding[]; // 提供时是唯一、闭合的裸名解析表
  sourceFile: "program.js";
  sourceForm: "async-function-body";
}
```

`program.js` 是源码权威，保留注释、空格、换行和原始摘要；manifest 不是第二份源码，也不执行模块导入。保存成功、JavaScript 语法合法、当前依赖可调用、实际运行成功是四个独立判断。

与当前 `contracts/program.ts` 保持字段适配：`ProgramDefinition.descriptor = manifest.descriptor`，`source = 严格 UTF-8 解码 program.js`；Assets 的 `dependencies` 在交给 Runtime 前转换为 `ProgramDefinition.dependencies` 的 `ExactRef[]`，并逐项验证确实是本仓库已发布 Program 版本。当前 `ExactRef` 与 Callable descriptor 的 `ref` 具有相同 TypeScript 字符串形状，但不是同一领域关系；原生 Callable ref 不得因为形状相同进入此列表。这里明确选择**函数体格式**：`program.js` 是 `async function(mc,input)` 的函数体，不是 ESM/npm 入口。文件编辑工具和语法检查使用同一包装上下文；不同时维护第二种长期源码格式，也不在 Assets 引入 npm/模块解析器。Descriptor 完整沿用 CallableDescriptor 的 input/output JSON Schema、access、completion、errors、requires 和 examples；Callable 投影仅补入已发布 ref 与 `implementation="program"`，不再创建另一个能力身份。

编辑适配由 Program 能力提供：将同一源码在内存/临时虚拟文档中包装为 `async function(mc,input) {\n<原始函数体>\n}`，校验和编辑器诊断按一行前缀映射回 program.js；不把包装写回资产。编辑器仍可直接 diff/Git/编辑原文件，但普通 JavaScript 文件模式可能对顶层 return 等函数体语法报错，不能承诺无需适配便有完整静态检查。mc 的真实合同继续来自当前 Runtime，Assets 不另造编辑语言或执行入口。修改参数、依赖等声明仍须一并编辑作者 Manifest。

`effectiveBindings` 只属于 Runtime 的真实 SegmentRecord/ProgramSegmentExport；资产只保留一个可选 `bindings` 表。publishFromRun 对 Program 段复制该段**入口自己的** effectiveBindings 到 bindings，不聚合子调用和实际后代，不把 nativeEnvironment 全目录变成 dependencies；原生段按 §6.2 生成只调用确切 ref 的包装，dependencies 为空、bindings 为空。普通创作可以手写闭合 bindings，但这属于声明，不是历史执行证据。

解析严格复用当前 Callable/Runtime 合同：未提供 bindings 时，以本程序 dependencies 与本次冻结原生环境建立表，显式依赖优先；提供时缺项报 `UNBOUND_CALL`，不回退当前环境。每项 name 为无版本完整名，refs 非空去重且名称一致；同名依赖与 bindings 冲突拒绝。同名多版本保留歧义，裸名报 `AMBIGUOUS_CALL`，确切调用仍可选择。每个子程序使用自己的表。保存不要求这些版本此刻健康，实际调用必须重新检查真实可用性和权限。

### 8.2 Runtime 固定

Runtime 受理顶层调用时解析当前 head 为确切 `name@version`，核对 packageDigest、依赖存在性、当前执行环境和权限，再把确切版本与实际源码字节绑定到执行段。执行期间不读取新 head 替换依赖；缺失依赖、环境不兼容或权限不满足在执行前失败。Program 资产没有第二个 Learned Skill 身份。

Runtime 必须从 `readPayload` 得到的源码流**完整读取一次**到自己的不可变字节缓冲（或自己拥有、不会再被外部修改的执行副本），在流结束成功后核对实际长度、source digest 和 packageDigest，再严格解码并编译同一份内容。任一流式校验错误都不得编译或报告可执行；禁止先校验磁盘文件后由 loader/import 再打开路径。校验后发布目录被外部修改，不改变已经捕获的执行内容；下一次读取失败报损坏。当前准入选择的 nativeEnvironment、入口 effectiveBindings、确切 asset ref 和源码 digest 写入 SegmentRecord；保存来源中的旧 environment 只是历史出处，不能冒充本次环境或授权。动态确切调用仍在自身派发前核验和登记，Assets 不冻结全调用图。

## 9. Blueprint

### 9.1 Raw、Target、Project 分界

- **Raw Blueprint**：`.schem`、`.litematic` 等原始文件字节，保留 DataVersion、offset、palette、block entity、entity、biome 和未知字段。
- **Blueprint Target**：Construction 可解释的局部设计语义。
- **Project/Plan**：绑定 world、dimension、anchor、旋转/镜像、现场观察、材料和施工顺序的工程对象。

Raw 不自动变 Target，Target 不自动变 Project，Project 不回写 Raw。格式能保存不等于能解析，能解析不等于能施工。

```typescript
type BlueprintDefinition =
  | { representation: "raw"; sourceFile: string; formatHint?: string }
  | { representation: "target"; schema: FormatSchema; targetFile: "target.json" };
```

### 9.2 目标语义与验证归属

Target 使用 Construction 的版本化领域 Schema，Assets 只保存 schema 身份、target.json 字节，并调用其验证器。不在 Assets 重新定义 NBT 编码、Block State 数据库、palette 或几何解析器。Target 分支须在 BlueprintDefinition 中携带 `schema: FormatSchema`；Raw 使用固定封装格式 assets.blueprint.raw/1，其 formatHint 不是已确认的文件格式。Program 的格式取自 ProgramManifest.format，Experience 使用 assets.experience/1；格式 Schema 与逻辑资产版本独立。

跨模块必须保留以下语义：

| 目标 | 含义 |
| --- | --- |
| set | 设置确定 Block State |
| clear | 明确要求清空 |
| preserve | 明确保留现场；未声明范围不能自动变成拆除 |
| unknown | 来源缺测或无法解释，目标确实无法确定，附原因 |

Construction 验证器对重复/越界/非整数坐标、无效 Block State、palette 引用和 NBT 类型给出领域诊断；其不可用时返回 SCHEMA_UNAVAILABLE，不用 Raw 标志伪装 Target 已通过。Assets 只负责调用同一验证器、保存所验证的固定字节并返回有限诊断；领域验证结果不等于当前现场允许施工。

Raw 的保真保证是原始压缩文件逐字节一致，包含未知标签和无法解析的数据。Target 的类型、值以及 NBT 编码合同由 Construction 维护，转换须明确报告无法表示的数据及损失，不允许把 long 静默转为 JSON 浮点、丢失类型后声称无损。Target 不承诺重编码得到原件字节；需要原件时保留 Raw。Assets 不据此扩展自己的解析职责。

### 9.3 Air、解析与施工

外部文件中的 air 只有在 Construction 明确选择策略后才映射：

```typescript
type AirPolicy = "set_air" | "preserve";
```

对**来源已知为空气的格**，`set_air → clear`，`preserve → preserve`；未给策略时，Raw 的保存/导出不受影响，但 Raw→Target/施工解释返回 `AIR_POLICY_REQUIRED`，不产生半解释 Target。删除 `AirPolicy="unknown"`：它把“知道是 air 但还没选意图”错误混入认识上的未知。

**来源本来未知的格**（未扫描、未加载、数据缺失/无法解释）始终保留 `unknown` 和原因；任何 AirPolicy 都不能把这些格变成 clear 或 preserve。Construction 决定未知区域是否阻止当前工程，依据现场数据补齐时才可形成确定目标。Construction 继续负责 decoder、DataVersion 适配、Block State/实体朝向转换、旋转/镜像、现场差异、材料和施工计划；Assets 只保存 Raw/Target 内容。

## 10. Experience 与 Evidence

### 10.1 Experience 是可修订判断

```typescript
interface ExperienceDefinition {
  context: string;
  question: string;
  judgment: string;
  method: string;
  stance: "hypothesis" | "supported" | "disputed" | "withdrawn";
  appliesTo: { assets: ExactRef[]; conditions: string[]; minecraft: string[] };
  support: Ref[];
  counterexamples: Array<{ description: string; evidence: Ref[] }>;
}
```

一次成功只能成为带条件的支持材料；一次失败可以形成假设或反例。新运行事实由 Runtime/World 保存；新增 Evidence 关联只表示向既有 Revision 附上一条可复核材料，不自动采纳它为支持或反例。Experience.support 与 counterexamples 是作者发布时已经选择、解释的依据和反例，属于不可变判断内容，不是必须随附件同步的实时事实列表。

仅新增材料不创建版本；作者改变判断、适用条件、方法、stance、支持材料的采纳或反例解释时发布新版。即使后来附加的证据反驳旧判断，旧版也保持原文，使用者须同时查看材料；Assets 不自动改写立场、不生成 confidence 分数或学习规则。任何已发布 Manifest/作者元数据变化同样必须新版本。

### 10.2 Evidence 的边界

<a id="references"></a>

```typescript
interface SourceLink {
  owner: "runtime" | "world" | "file" | "external";
  ref: Ref;
  description: string;
}
interface EvidenceCopy {
  evidenceId: number;
  owner: "runtime" | "world";
  originalRef: Ref;
  schema: FormatSchema;
  payloadPath?: string;
  payloadDigest?: Digest;
  completeness: "self_contained" | "partial" | "link_only";
  capturedAt: string;
  observedAt?: string;
  unknowns: string[];
  metadata: JsonValue; // 来源端口输出的 provenance/coverage/status 等原始语义
}
interface AttachEvidenceRequest {
  ref: ExactRef;
  sourceRef: Ref; // 精确记录/观察引用；只表达选择，不证明归属或内容
  persistence: "link" | "copy";
}
interface TrustedEvidenceExport {
  owner: "runtime" | "world";
  originalRef: Ref;
  schema: FormatSchema;
  completeness: "self_contained" | "partial" | "link_only";
  observedAt?: string;
  unknowns: string[];
  metadata: JsonValue;
  payload?: AsyncIterable<Uint8Array>;
}
interface EvidenceExportPort {
  exportEvidence(request: {
    sourceRef: Ref; persistence: "link" | "copy";
  }, signal?: AbortSignal): Promise<TrustedEvidenceExport>;
}
```

普通来源只保存弱链接；只有需要长期复核时，才由 Runtime/World 的可信导出端口复制有限副本。副本保留原始 `observedAt`、覆盖范围和 unknown；`capturedAt` 不是新观察时间。Prediction 仍是 prediction，执行 `succeeded` 也不自动变成认证结论。Evidence 的新增、关联和读取由 Assets 管理，事实内容由 Runtime/World 提供。

`attachEvidence` **不接受** principal、owner、schema、completeness、observedAt、事实值或 payload。模型/脚本只能选择目标版本、确切 sourceRef 及保留意图。宿主根据可核验的 Ref 归属将请求直接路由到 Runtime 或 World 的可信端口；来源所有者验证记录身份、调用者访问范围以及不可变修订。不存在、不能固定或不能读取的引用失败，不能退化成模型自报事实。

上面的 `TrustedEvidenceExport` 仅为宿主进程内返回类型，绝不接受模型 JSON 反序列化为该对象。端口实例在组合根注入，并绑定可信调用上下文；结构类型相同不代表可信。即使调用者写入 Manifest/notes，声称“由 Runtime 验证”，也只属于作者文字。SourceLink 的 owner 仍为作者声称的弱出处，不用来选择可信实现或填 Evidence 行。

`link` 也先经所有者核验引用，返回 link_only；原记录被清理后可失效。`copy` 固定选定记录及必要材料后导出，覆盖/缺口/完整性均由所有者给出；Assets 只能计算实际字节摘要、长度和 capturedAt，不能把 partial 改为 self_contained。metadata 与 payload 共同保留原始来源、prediction/unknown、覆盖和状态语义；复制是真实记录的保留方式，不是世界事实的第二个可写权威。

复制流程是可信导出 → 私有 staging 完整接收 → 关闭/校验字节 → 安装到独立 `evidence/<copyId>` → 一次 SQLite 事务插入关联和可信 metadata。仅数据库引用的 Evidence 可见；异常退出可留下未引用副本。导出中断不登记完整证据。Evidence 附加失败不修改既有 Revision、head 或 packageDigest；同请求盲目重传可能产生重复关联，本版不为附件建立另一套操作账本。

## 11. 最小公开 API 与跨模块接缝

### 11.1 Repository 与 library

```typescript
interface AssetSummary {
  ref: ExactRef; name: string; kind: AssetKind;
  title: string; summary: string; tags: string[];
}
interface AssetRevisionView extends AssetSummary {
  previousRef: ExactRef | null;
  derivedFrom: RepositoryRef | null; // 仅投影作者声明
  format: FormatSchema;
  packageDigest: Digest;
  requires: ExactRef[];
  sources: SourceLink[];
  evidence: EvidenceCopy[];
  files: PayloadEntry[];
}
interface AssetInspection {
  ref: ExactRef;
  format: FormatSchema;
  integrity: "verified" | "corrupt" | "unknown";
  formatSupport: "available" | "unavailable" | "unknown";
  diagnostics: { code: string; message: string; path?: string }[];
}
type OperationResult =
  | { operationId: string; state: "committed"; result: PublishResult }
  | { operationId: string; state: "absent" | "unknown"; reason?: string };
interface ReadLibrary {
  resolve(name: string): Promise<{ name: string; kind: AssetKind; ref: ExactRef | null }>;
  read(ref: ExactRef): Promise<AssetRevisionView>;
  readPayload(ref: ExactRef, path: string): Promise<AsyncIterable<Uint8Array>>;
  inspect(ref: ExactRef): Promise<AssetInspection>;
  search(query: { text?: string; kind?: AssetKind; tags?: string[]; limit?: number }): Promise<AssetSummary[]>;
  listVersions(name: string, afterVersion?: number): Promise<AssetSummary[]>;
}
interface WriteLibrary extends ReadLibrary {
  publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResult>;
  publishFromRun(request: RunSegmentRequest, signal?: AbortSignal): Promise<PublishResult>;
  getOperation(operationId: string): Promise<OperationResult>;
  attachEvidence(request: AttachEvidenceRequest, signal?: AbortSignal): Promise<EvidenceCopy>;
}
// 唯一业务实现；下列视图仅委托到这个仓库，不复制状态或维护别名。
interface AssetRepository extends WriteLibrary {}
type Library = ReadLibrary; // 基础可读合同；写能力只在 WriteLibrary/act 接缝出现
```

宿主内部 Repository 是唯一业务实现。read Callable 收到的是真正只包含 ReadLibrary 方法的独立冻结包装对象，不能把完整 Repository 做 TypeScript 类型断言后直接传入；act Callable 才可取得 WriteLibrary，同样只公开列出的方法。`ReadCallContext.assets` 静态类型直接使用 `ReadLibrary`，`CallContext.assets` 静态类型直接使用 `WriteLibrary`；不在这两个合同中使用 `ReadLibrary | WriteLibrary` 联合类型，也不依赖运行时收窄后访问写方法。接线对应当前 ReadCallContext.assets/CallContext.assets，替换旧 ReadAssets/ScriptAssets 的相应合同，不新增另一套运行上下文。写入口每次准入和提交再次检查真实 scope；不会因为包装被保存或伪造请求字段而续期授权。getOperation 暂只在写视图提供，仍按稳定调用者过滤。

前端/Uina 的一般文件编辑通过已有 workspace-tools 完成，不经 Library。宿主通过现有 ScopedToolView 的工具 include/exclude 控制其能力，Runtime 脚本的 read/act 则沿用当前 CallContext 判别；两种执行上下文不能互相冒充。Library 不带 fs、shell、工具 Broker、原始数据库、工作区写入、可信端口注入或维护入口。模型 JSON 不包含 principal/workspaceRoot/operation，operation 只由可信传输接入添加。工作目录来源由可信宿主绑定的读取根核验；外部导入转换为 ImportedFile 流，不接受模型函数。

CLI/前端可把 publishFromRun 称为“从运行保存”，仍委托到同一发布机制。EvidenceExportPort/ProgramSourcePort 仅由组合根注入，脚本不能替换实例或通过对象结构伪造可信导出。

`inspect` 核对包 Manifest、文件集合、长度与摘要，返回独立的完整性和格式支持状态；verified 只表示包字节完整，不表示领域判断正确或当前可执行。可委托已安装领域适配器返回有限的格式/Schema 诊断，诊断项不携带任意解析 JSON。没有适配器则 formatSupport=unavailable，不将其报告为 corrupt；无法完成存储读取则 integrity=unknown。inspect 可返回 corrupt 及原因供诊断，普通内容读取仍按 §7.2 报 `ASSET_CORRUPT`。Blueprint 几何、材料统计、切片及解析后的领域视图由 Blueprint/Construction 接口按需提供；Repository 不提供通用 parsed 出口。

### 11.2 谁负责什么

| 动作 | 责任者 |
| --- | --- |
| 创建/编辑未完成内容 | 人类编辑器与现有 workspace-tools；宿主控制能力，Assets 不维护编辑状态 |
| 固定发布输入 | Publish 在本次 staging 单次捕获，只访问宿主授权读取根或可信导入流 |
| 导出运行输入 | Runtime 的 `ProgramSourcePort`，按确切 run/segment/record 导出 Program 源码或冻结原生 descriptor；Program 适配生成包装 |
| 导出可信 Evidence | Runtime/World 的可信导出端口 |
| 校验 manifest/名称/包完整性 | Assets |
| 校验 Program descriptor/依赖可调用性 | Program 适配与 Runtime |
| 校验 Blueprint Target、AirPolicy、旋转和现场兼容性 | Construction |
| 最终检查执行权限和当前环境 | Runtime/Callable 准入 |
| 保存世界事实和工程进度 | World/Construction，不写回资产 package |

Assets 不读取 Bot、World 内部对象或 Runtime 私有表；所有跨边界数据由明确端口导出为不可变值/流。

### 11.3 错误和资源定位

长读写通过签名中的 signal 或返回流的关闭进行取消；短目录读只做一次查询，不另造可取消任务。发布错误携带 `code`、五态边界中的 `status` 和可用的 `committedRef`；查询结果 unknown 不被转成“操作失败”。关键错误：

`ASSET_INVALID`、`ASSET_NOT_FOUND`、`ASSET_KIND_MISMATCH`、`REVISION_CONFLICT`、`ASSET_SOURCE_CHANGED`、`ASSET_SOURCE_UNAVAILABLE`、`ASSET_DEPENDENCY_UNAVAILABLE`、`AIR_POLICY_REQUIRED`、`SCHEMA_UNAVAILABLE`、`ASSET_CORRUPT`、`OBJECT_UNAVAILABLE`、`OPERATION_CONFLICT`、`ASSET_STORE_UNAVAILABLE`、`ASSET_RESOURCE_EXHAUSTED`。

`readPayload` 接受 manifest.json 及 Manifest 中列出的 payload 相对路径。内容路径只用小写 ASCII 安全组件及 `/`；拒绝空组件、绝对路径、`..`、反斜杠、保留设备名、符号链接/reparse point 及忽略大小写后的重复项。所有入口用同一规则，防止 Windows 大小写造成摘要表与实际路径不一致。大对象以 `AsyncIterable<Uint8Array>` 返回，不转 Base64，不强制整文件进入模型上下文。流消费方若要复用内容，应边读边写自己的私有缓冲并重新核算长度/摘要；未读完或校验失败的流不得交给 Runtime 编译。

## 12. 发现与复用

标准路径是：

```text
search
  → read/inspect 候选摘要与适用条件
  → 选择确切 name@version
  → Runtime/Construction 检查依赖、权限、环境和现场适用性
  → Runtime 固定确切版本并调用
```

`search` 只返回适量 `AssetSummary`，不返回整段源码，不保证跨查询长快照，不把排名当可靠性。`read` 按需展开元数据、文件列表和 Evidence 摘要，Manifest 通过 readPayload 获取；`inspect` 提供完整性、格式支持情况及有限诊断；领域视图另向 Blueprint/Construction 获取。确切 ref 可直接读取。Assets 提供发现机制，但不决定 Uina 什么时候搜索、该学会什么或应该做什么。

## 13. 关键验收

### 13.1 存储与发布

- 两个编辑者对同一当前 head 并发发布，只能一个 CAS 成功；组合外键拒绝 head 指向不存在或其他资产的版本。工作文件修改、实验运行和保存编辑器文件均不自动创建 Revision。
- author 声明 A@1 时，默认传 expectedRef=A@2 仍冲突；显式 replace_current 才能在当前 head CAS 成功后得到 A@3，previousRef=A@2，derivedFrom 仍只是 A@1 的声明。手工将 baseRef 改为 A@2 会被当成作者声明接受，不能据此宣称已验证合并或实际派生。
- Uina 用已有 read_file/write_file/edit_file 与人类编辑器操作同一普通目录；Assets 无 Draft CRUD/表、编辑摘要 CAS 或 updated_at。按现有工具的真实边界验收，不能把 rename 或文本匹配当作不丢写证明。
- ReadLibrary 的实际 JavaScript 对象没有 publish、attachEvidence、文件写入或 Repository 句柄；受限脚本也不能绕到通用工具/shell/Node fs。写 scope 失效时，即使持有旧 WriteLibrary 包装也不可提交。
- workspace 来源只允许宿主绑定读入根下的普通目录，拒绝路径越界与链接；一般文件工具的本机完整授权不被误报为目录沙箱。标题/描述/标签与领域合同均取自同一固定 author，不能由第二份请求 metadata 覆盖。
- 捕获只读取 Manifest 与声明文件一次；额外笔记不影响发布身份。外部编辑停止时验证一致的输入组合，编辑持续进行时只保证本次 staging 字节，不承诺原子快照。原目录在捕获后被删除不取消发布，signal 才控制取消。
- 对象已安装、数据库未提交时 kill：留下未引用 objectId，不占逻辑版本；下次用新对象，不隔离、覆盖或认领旧包。已提交对象被修改/丢失为 ASSET_CORRUPT。
- 回执丢失后同 operation token 返回原结果，先于源读取和 head CAS；改完整输入身份/意图返回 OPERATION_CONFLICT，实际流身份不符不提交。无 token 时不以 head/digest 唯一归因。absent 不等于终局失败，提交无法核实为 unknown。
- 数据库快照及引用对象/Evidence 成对恢复，不能只复制有未合并 WAL 的主数据库；单独复制对象包仅能恢复内容。跨仓库同名版本以 RepositoryRef 消歧。

### 13.2 内容与领域

- Program 保存、语法通过、当前可调用和执行成功分别报告；编辑工具与 Runtime 使用同一函数体包装，Runtime 编译的正是已核验字节。
- publishFromRun从指定 run/segment/record 导出冻结 Program 源码及入口 effectiveBindings；原生段从冻结 descriptor 生成确切 ref 包装。生成包装的 `dependencies` 与 `bindings` 均为空，原生 Callable ref 只在 `mc.call(...)` 与可信来源中出现；不能从当前 head 或环境补内容，包装源码摘要与原生实现身份分开，缺冻结输入即失败。
- `readPayload` 在流结束时才完成长度与摘要核验；流中途或结尾校验失败时，Runtime 不编译、不执行，也不报告 succeeded。Runtime 编译的字节必须是自己完整核验后保留的同一缓冲。
- inspect 只给完整性、格式支持和有限诊断；无 decoder 不等于损坏，几何/材料/切片由 Construction 输出。
- Raw .schem/.litematic 逐字节往返，包括未知数据；Target 的 Schema/NBT/坐标验证复用 Construction，验证器不可用即明确不可验证，不在 Assets 复制解析器。
- set/clear/preserve/unknown 不混淆：已知 air 经显式 AirPolicy 转为 clear 或 preserve，未选策略为 AIR_POLICY_REQUIRED；真正未知格在任一策略下保持 unknown。Target 转换损失由 Construction 报告，不声称原件字节无损。
- 新增测试或观察材料只增加独立 Evidence，Program/Blueprint/Experience 内容不变。Experience 采纳依据、改变判断/条件/立场或反例解释时发布新版，旧版 support/counterexamples 不自动同步附件。

### 13.3 Minecraft 闭环

在真实执行能力可用后验证：`现有文件工具/VS Code 创作 → 普通 Manifest 与源码 → 明确 publish → search/read/inspect → Runtime 固定 ref 执行 → attachEvidence → 编辑工作文件并再次明确发布`。运行导出和外部导入直接发布；源码无 JavaScript 的原生段仍按 §6.2 包装。当前文档只确认现有文件工具与权限接缝的源码存在，不宣称新的 Assets 发布链或前端已经实现。

### 13.4 当前约束下明确不能承诺

- 同文件并发编辑不丢写、外部编辑中的多文件原子快照，或文件工具已经具有目录沙箱/摘要 CAS；本稿不另造 Workspace 平台补这些保证。
- 作者可编辑的 baseRef 证明实际派生、已处理所有差异，或 expectedRef CAS 可以检测调用前已经存在却被作者忽略的修改。
- SQLite 与文件系统跨断电原子提交；暂停 writer 不代表 WAL 已合并。
- 缺 token、无法保留原输入、数据库丢失或回滚到旧备份后的操作级恰好一次；head/digest 不能唯一归因。
- 仅凭对象路径与内容重建原逻辑名称/head、Evidence 关联及 operation 提交历史；包复制不是完整迁移。
- Raw→Target 字节无损、可信记录等于认证结论，或保存成功等于当前可运行。

## 14. 实施顺序、重新评估点与证据边界

实施顺序：先文件包、manifest/digest、SQLite heads/revisions/CAS；再复用文件工具的 Program 创作/发布工作流；再 Raw Blueprint 保真和 Target 校验；随后接入 Runtime segment/Evidence export；最后接入 library、搜索和真实 Minecraft 闭环。

需要实际测量的内容包括发布延迟、峰值 RSS、磁盘写量、并发读取、临时目录占用、SQLite journal 配置的恢复边界和大型蓝图导入对 Driver 心跳的影响。没有这些测量，不宣称文件一定更快、SQLite 一定更安全或提交等于断电耐久。

本设计基于当前项目基线、Minecraft contracts/public API、World 存储边界和现有 `CellTarget` 四态语义；它没有修改实现，也没有把任何尚未存在的 Runtime/World/Construction 端口当成已实现能力。

本次修订包括本文件与配套 assets-maintenance.md，不修改实现或其他模块设计。实施时以这里的工作文件接入、发布和只读/写入视图及可信导出合同替换旧 public-api/assets 合同中的对应入口，不能把旧的可自报来源、请求体 principal、DraftRepository/drafts 表、可信 Draft 派生承诺、工作区 treeDigest 或持久 retain/pending 协议与本稿并行拼接；ProgramDefinition/CallableDescriptor 的解析与调用语义继续沿用现有合同。
