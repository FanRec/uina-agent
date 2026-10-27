# 记忆系统技术调研

状态：调研报告，未施工，无代码决定。
调研日期：2026-10-27（GMT+8）。
配套：`docs/archive/proposals/cognition-extension-design.md`（已撤回的前一版设计）、`docs/proposals/subject-runtime-plan.md`（内核冻结约束）。
方法与边界：**分层清单 + 本机实测**。所有结论分两类标注——`实测` 表示本机跑出来的数字，`外部` 表示来自公开资料且未在本机复现。凡未标注来源的成熟度判断都属推断，置信度写在 §8。

---

## 0. 一页结论

三句话：

1. **在本项目的规模下，全文检索、向量检索、图遍历三类技术全部可以在一个 SQLite 文件 + 纯 JS 里完成，不需要任何外部服务。** 实测：1218 条真实 journal 正文建索引 114 ms，中文查询 0.4–1.5 ms，1218×1024 维暴力余弦 1.7 ms，三跳关系遍历 0.02 ms。
2. **唯一值得引入原生依赖的地方是嵌入模型**，而且它带来的是"语义近似"这一项能力，不是检索本身。嵌入必须放 worker，且在本机应走 CPU（GPU 已被常驻 TTS 占去 2.2 GB）。
3. **关系数据库（Kùzu 一类）和向量数据库（Qdrant/LanceDB 一类）在本项目全部属于"能上但不该上"**。前者已经被证明会死（Kùzu 2025-10 归档，团队被 Apple 收购），后者在 1 万条量级上是纯负债。

第四句是初版遗漏、必须补上的：**记忆不止"发生过什么"和"什么是真的"，还有"这类事怎么做"（程序性记忆）。而这一类在本仓库已经跑起来了——`.agents/skills/*/SKILL.md` 自带 `evals/evals.json` 验收集。它是全部三类记忆里唯一已经有验收机制的，见 §3.13。**

如果只记一条工程原则：**索引层必须可由 `journal + notes` 用脚本重建，删掉只损失时间。** 满足这条的技术都可以选，不满足的一律不选。

---

## 1. 本项目特有的硬约束

通用选型表在这里大部分失效，因为下面这七条把候选空间砍掉了九成。

| # | 约束 | 来源 | 后果 |
|---|---|---|---|
| C1 | 运行时是 Node + TypeScript，没有常驻 Python | `package.json` engines `>=22`；AGENTS.md | 排除所有 Python-first 的实现（FAISS、Chroma 服务、GLiNER、HanLP） |
| C2 | 扩展不得拥有内核概念的所有权 | AGENTS.md 内核 allowlist | 记忆层只能是 `src/extensions/` 或 `.uina/extensions/` 里的能力，不能往内核加概念 |
| C3 | 已有可注入的同步 SQLite（`node:sqlite`），且已有 worker 化先例 | 实测 + `.uina/worlds/minecraft/runtime/runtime-db-worker.ts` | 存储层零新增依赖；同步 API 必须进 worker，不能占主线程 |
| C4 | 单用户、单机、Windows、离线优先 | `~/.uina/` 布局 | 排除一切需要服务进程、多租户、鉴权的东西 |
| C5 | GPU 只有 8 GB，常驻 TTS 已占 2.2 GB | 本项目显存实测记录 | 嵌入/重排模型走 CPU；不能与 TTS 抢显存 |
| C6 | 语料以中文为主，且是口语、代号、错别字混杂 | journal 实测抽样 | 标准英文分词器全部失效（§2 已证） |
| C7 | 一次删除过 5646 行的记忆子系统 | `9503fa3` | 任何新增依赖必须先证明"现有技术做不到"，而不是"这个更好" |

---

## 2. 实测基线

以下是本机跑出来的数字，脚本在 `dev/memory-bench.mjs`（一次性取证，非产品代码；`dev/` 不入库，该脚本仅本机存在，删除后按本文表格可重写）。

### 2.1 语料规模

| 对象 | 规模 | 备注 |
|---|---|---|
| `~/.uina/session.jsonl` | 3.8 MB / 2474 条记录 | 957 message、998 event、474 input、44 custom_entry |
| 其中可检索正文 | 1218 条 | 去掉纯事件与非文本帧 |
| `~/.uina/session-bak.jsonl` | 44.2 MB / 18094 条 | 上一轮生命周期，无读路径 |
| `notes/legacy/` | 140 KB / 29 篇 md | 调研期间被整体归档，附 sha256 `.manifest` |

> 观察到的副作用：调研进行中（01:15–01:21）`notes/` 的全部内容被移进 `notes/legacy/` 并生成 `.manifest`。本报告按"legacy 归档 + 新布局待定"两种状态都成立来写，不假设迁移方向。

### 2.2 关键实测

| 项 | 结果 | 意义 |
|---|---|---|
| `node:sqlite` 内置 SQLite 版本 | 3.51.2，FTS5 **可用** | 全文本检索零依赖 |
| `vec0`（sqlite-vec） | **不可用**（no such module） | 向量若要进 SQLite，必须自己加载扩展 |
| `loadExtension` / `allowExtension` | 均存在 | 技术上可以加载 sqlite-vec 的 dll |
| FTS5 `unicode61` + 中文 | **全 0 命中**（声音/答应/下周/帮我 四条探测全部 miss） | 默认分词器对中文完全失效 |
| FTS5 `trigram` + 中文 | 3 字可命中（第九场），**2 字全 miss**（声音、模糊） | 中文常用双字词无法检索 |
| `Intl.Segmenter('zh-CN')` + 预分词 | **全部命中**，含 2 字词 | 零依赖方案成立 |
| 建索引（1218 条，含分词） | **114 ms** | 重建成本可忽略 |
| 单查询（bm25 排序 + snippet） | **0.4–1.5 ms** | 按次调用不构成延迟 |
| 暴力余弦 1218×1024 | **1.70 ms**，内存 5.0 MB | 不需要向量索引结构 |
| 递归 CTE 三跳遍历 | **0.02 ms** | 不需要图数据库 |
| FTS5 空格语义 | 隐式 **AND**（"记忆 系统"=1，"记忆 OR 系统"=3） | 不会静默放大召回 |

`Intl.Segmenter` 的实际切分（可复现）：`他答应下周帮我改声音` → `他|答应|下周|帮|我|改|声音`。质量不如词典分词，但对检索足够。

---

## 3. 技术清单

每节末尾给结论：**采用 / 备选 / 观察 / 排除**。

### 3.1 全文检索（词法层）

| 技术 | 形态 | 成熟度 | 许可 | 本机成本 | 结论 |
|---|---|---|---|---|---|
| SQLite FTS5（`node:sqlite` 内置） | 库，进程内 | 稳定，SQLite 自带 | Public Domain | 0 依赖 | **采用** |
| SQLite FTS5 `trigram` | 同上 | 稳定 | 同上 | 0 | 备选（只适合 ≥3 字查询） |
| Orama v3.1.18 | 纯 TS 库，内存 radix tree + 向量 + hybrid | 11k★，2026-10 仍在提交 | **非 OSI（目录登记 Custom）** | 0 原生依赖 | 备选（许可需自核；放弃 SQL 联表能力） |
| MiniSearch / FlexSearch / Lunr / Fuse.js | 纯 JS 全文/模糊 | 稳定，维护弱 | MIT | 0 | 排除（都在内存里重建；无 SQL 过滤；中文需自带分词） |
| Meilisearch | 独立服务（Rust） | 成熟 | MIT（core） | 多一个常驻进程 | 排除（C4：为一个用户跑服务） |
| Typesense | 独立服务（C++） | 成熟 | GPL-3.0 | 同上 | 排除（许可 + C4） |
| Tantivy | Rust 库 | 成熟 | MIT | 无 Node 绑定 | 排除（C1） |
| Elasticsearch / OpenSearch / Vespa / Manticore | 集群级 | 重 | 混合 | 荒谬 | 排除 |
| ParadeDB | Postgres 扩展 | 2026 起可用 | AGPL/商用 | 要 Postgres | 排除（C4） |
| ripgrep 直接扫文件 | 二进制 + spawn | 项目已内置（`rg-installer.ts`，14.1.1 固定版） | MIT | 已有 | 备选（无排序、无 snippet、无字段过滤；1200 条够用，1 万条后不适） |

**结论**：FTS5 + 预分词。这是唯一同时满足"零依赖 / 可 SQL 联表 / 可重建 / 支持中文"的选项。

### 3.2 向量检索（语义层）

| 技术 | 形态 | 成熟度 | 许可 | 本机成本 | 结论 |
|---|---|---|---|---|---|
| 纯 JS 暴力余弦（Float32Array / int8） | 内存数组 | 天然稳定 | — | 1.7 ms / 1218 条 | **采用（第一档）** |
| sqlite-vec | SQLite 扩展（C） | **pre-1.0**，0.1.9 稳定（2026-03），0.1.10-alpha 才加 ANN | Apache-2.0 / MIT | 需分发 dll（平台相关） | 观察（>10 万向量才需要） |
| LanceDB `@lancedb/lancedb` v0.40 | 嵌入式向量库（Rust/Arrow） | **pre-1.0**，2026-10-07 发布 | Apache-2.0 | 原生模块 + 列存目录 | 排除（C7：为千级向量引入 Arrow 栈） |
| Qdrant | 独立服务 | 成熟 | Apache-2.0 | 容器 | 排除（C4） |
| Chroma | 库或服务 | 成熟 | Apache-2.0 | Python 优先 | 排除（C1） |
| Weaviate / Milvus / Pinecone / turbopuffer | 服务 | 成熟 | 混合/商业 | — | 排除 |
| pgvector | Postgres 扩展 | 成熟 | PostgreSQL | 要 Postgres | 排除（C4） |
| hnswlib-node / usearch / voy | 原生 ANN | 成熟度不一 | 混合 | 原生模块 | 排除（本规模不需要 ANN） |
| FAISS | Python/C++ | 成熟 | MIT | 无 Node 路径 | 排除（C1） |

**结论**：第一档用 `Float32Array` BLOB 存进 SQLite 自己算；到 10 万向量（≈ 现在的 80 倍）再评估 sqlite-vec。**不要为 1218 条数据上 ANN。**

### 3.3 图与关系遍历

| 技术 | 形态 | 成熟度 | 许可 | 本机成本 | 结论 |
|---|---|---|---|---|---|
| 边表 + 递归 CTE | 纯 SQL | 与 SQLite 同寿 | — | 0.02 ms / 3 跳 | **采用** |
| Kùzu | 嵌入式图库（C++） | **已死**：2025-10-10 仓库归档，团队被 Apple 收购，2026-02 经 DMA 文件公开 | MIT（归档前） | — | 排除（反面教材） |
| LadybugDB | Kùzu 的 MIT 继承分支 | 年轻，单 RW 进程，无第一方记忆框架驱动 | MIT | 原生模块 | 观察（图成为主存储才考虑） |
| FalkorDB / FalkorDBLite | 图库（Redis 模块 / 子进程） | 成熟 | **SSPL** | 需服务或子进程 | 排除（许可 + C4） |
| Neo4j CE（含 Graphiti 生态） | 服务（JVM） | 最成熟 | GPLv3 | JVM 常驻 | 排除（C4/C5） |
| Memgraph | 服务（内存） | 成熟 | BSL 1.1 | — | 排除 |
| ArcadeDB | 多模型嵌入式 | 活跃 | Apache-2.0 | JVM | 排除（C1） |
| Oxigraph | RDF/SPARQL（Rust） | 成熟 | MIT/Apache | 无稳定 Node 绑定 | 排除（C1；且 RDF 建模对口语记忆过重） |
| HyperGraphDB / TerminusDB | 超图 / 文档图 | 小众 | 混合 | — | 排除 |
| Datalog / Prolog 推理（tau-prolog 等） | 规则引擎 | 可用但小众 | 混合 | 纯 JS | 排除（"因果"当前缺的是出处，不是推理机） |

**结论**：图不是存储形态，是**查询形态**。一张 `edge(src, rel, dst, t_valid, source_span)` + 递归 CTE 就够，而且它天然可以随时重建。

### 3.4 中文分词

| 技术 | 形态 | 质量 | 成本 | 结论 |
|---|---|---|---|---|
| `Intl.Segmenter('zh-CN')` | Node 内置（ICU） | 够检索用，2 字词可切 | 0 依赖，0 下载 | **采用** |
| CJK bigram 化（相邻二字全出） | 纯 JS 变换 | 召回高、精度低；业界常用兜底 | 0 | 备选（与 Segmenter 并用做召回扩展） |
| `@node-rs/jieba` | Rust → N-API 预编译 | 精度更高，支持自定义词典（人名/代号） | 原生模块，~11 MB | 观察（若专名召回不足） |
| `nodejieba` | C++ → N-API | 更慢 | 原生模块 + 编译链 | 排除（被上者全面超越） |
| `jieba-wasm` | WASM | 启动快，精度次于 Rust 版 | ~300 KB | 备选（若不愿带原生模块） |
| SQLite `icu` tokenizer | 扩展 | 需另编译进 SQLite | 需换 SQLite 构建 | 排除（不能用内置库） |

**结论**：先 Segmenter，把专名写进自定义词表的需求出现后再考虑 jieba。**代价可量化**：换分词器要全量重建索引（114 ms），所以这不是一个需要现在决定的问题。

### 3.5 本地嵌入模型（CPU）

| 模型 | 参数 | 维度 | 上下文 | 许可 | 量化体积 | 结论 |
|---|---|---|---|---|---|---|
| ibm-granite/granite-embedding-97m-multilingual-r2 | 97M | 384（MRL） | 32k | Apache-2.0 | int8 ONNX ≈ 98 MB | **首选**（体积/质量最平衡，MMTEB retrieval 60.3） |
| Qwen/Qwen3-Embedding-0.6B | 600M | 1024（MRL 32–1024） | 32k | Apache-2.0 | q8 ONNX ≈ 585 MB | 备选（质量更高，需 `last_token` pooling + 指令前缀） |
| BAAI/bge-m3 | 568M | 1024 | 8k | MIT | int8 ≈ 570 MB | 备选（稠密+稀疏+ColBERT 三合一；已被上面两者在 MMTEB 上超过） |
| intfloat/multilingual-e5-large-instruct | 560M | 1024 | 512 | MIT | — | 排除（512 上下文太短） |
| Xenova/multilingual-e5-small | 118M | 384 | 512 | MIT | ≈ 90 MB | 备选（最省，质量明显低一档） |
| EmbeddingGemma-2 | 740M | 768（MRL） | — | Gemma 条款 | int8 ≈ 314 MB | 观察（外部实测 CPU p50 168 ms/条） |

运行时：

| 技术 | 形态 | 许可 | 结论 |
|---|---|---|---|
| `@huggingface/transformers` v4 + `onnxruntime-node` | 进程内 ONNX，CPU/WebGPU | Apache-2.0 / MIT | **采用**（唯一成熟的无 Python 路径） |
| llama.cpp / `node-llama-cpp` | GGUF 推理 | MIT | 备选（适合生成，不适合批量嵌入） |
| Ollama 本地服务 | 服务 + HTTP | MIT | 备选（多一个常驻进程；但模型管理最省心） |
| Python `sentence-transformers` 边车 | 子进程 | Apache-2.0 | 排除（C1：引入第二套语言栈） |

> 显存：本机 8 GB，常驻 TTS 已占 2.2 GB，桌面基线 1.8 GB。嵌入走 CPU；`onnxruntime-node` 的 DirectML/CUDA 路径不要开。

**结论**：granite-97m 起步。0.6B 只在实测召回明显不足时换，且换模型必须全量重嵌入（这是唯一一处"变更代价不可忽略"的地方）。

### 3.6 重排

| 技术 | 形态 | 成本 | 结论 |
|---|---|---|---|
| `Xenova/bge-reranker-base` / `bge-reranker-v2-m3` | ONNX cross-encoder | +1 进程 / 模型常驻 | 观察（第二阶段，且必须独立子进程） |
| Qwen3-Reranker-0.6B | ONNX | 同上 | 观察 |
| 无重排，只靠 bm25 + 余弦 RRF 融合 | 纯 JS | 0 | **采用（第一档）** |

**结论**：重排解决的是"相似 ≠ 相关"。在拿到假阳性率实测之前不上。

### 3.7 抽取（实体 / 关系 / 事件 / 因果）

| 技术 | 形态 | 成本 | 结论 |
|---|---|---|---|
| 用现有 Provider 做结构化抽取（JSON schema） | 一次模型调用 | 走已有账单 | **采用** |
| GLiNER / GLiNER2 | 本地 NER（Python 优先） | 新语言栈 | 排除（C1） |
| REBEL / DeepKE / OneKE | 关系抽取 | 同上 | 排除 |
| 规则 + 正则 + 时间解析（`chrono-node`） | 纯 JS | 0 | **采用**（时间、人名、承诺动词这类高频模式不需要模型） |
| 句法分析（HanLP/CoreNLP） | JVM/Python | — | 排除 |

**结论**：抽取是**离线批处理**，不是读路径的一部分。抽错了不阻塞召回；抽出来的每条必须带 `source_span`（记录 id + 字符区间），否则视为推断。

### 3.8 时序与双时态建模

这一项没有库，只有模式。

| 技术 | 说明 | 成本 | 结论 |
|---|---|---|---|
| 双时态边（`t_valid` + `t_recorded`） | 事实何时为真 vs 何时被写入；Zep/Graphiti 的核心主张，SQL 两张时间列即可 | 0 | **采用** |
| 慢变维 SCD2（失效而非删除） | 同一实体的历史版本，`valid_from/valid_to` | 0 | **采用** |
| 事件溯源（append-only journal） | 项目已有（`session/jsonl-store.ts` + reducer） | 0 | **已有，复用** |
| CRDT / 多写入者合并 | 单用户单机不需要 | — | 排除 |
| 版本化数据库（Dolt / TerminusDB） | 过度 | — | 排除 |

**结论**：`时序是事实、因果是主张`这条规则，技术上就是"两张时间列 + 一条 `source_span`"。不需要图库，也不需要时间序列库。

### 3.9 版本、归档与完整性

| 技术 | 说明 | 成本 | 结论 |
|---|---|---|---|
| sha256 `.manifest` | 项目里刚出现（`notes/legacy/.manifest`），`sha256sum -c` 可校验 | 0 | **采用**（归档层） |
| `notes/` 纳入 git | 当前被 `.gitignore:15` 整目录忽略 → `git ls-files notes` = 0 | 0 | **建议**（这是"可读性 + 可回溯"最便宜的实现） |
| `simple-git` / `isomorphic-git` | 程序化提交 | 依赖 | 备选（若要与 git 交互而非 shell out） |
| copy-on-write revisions 目录 | 每次改稿留旧稿 | 0 | 备选（不进 git 时的替代） |
| Zstandard / `node:zlib` | 归档压缩（44 MB → 数 MB） | 0（内置） | 备选（冷归档） |

**结论**：版本与治理的底座不需要数据库——**需要的是不丢历史**。当前 `notes/` 连 git 都没有，这比"缺索引"严重。

### 3.10 运行时与并发

| 技术 | 说明 | 结论 |
|---|---|---|
| `worker_threads` + `node:sqlite` | 项目已有成熟先例（MC 的 `runtime-db-worker.ts`：WAL + synchronous=FULL + 幂等 apply + ACK 上界） | **采用同一套模式** |
| 主线程直接同步 SQLite | 114 ms 建索引会卡 UI；0.5 ms 查询不会 | 分界：查询可在主线程，建索引必须进 worker |
| `node:sqlite` 稳定性 | Node 22 = 1.1（active development），Node 24 = 1.2（RC），Node 26.11 把 `DatabaseSync` 改名 `Database`（doc-only 弃用别称） | 采用 `DatabaseSync` 名字，Node 26 LTS（2026-10-28）后再评估 |
| WAL + 单写入者 | 与内核 journal 的"单 writer"原则一致 | **采用** |

### 3.11 现成记忆框架（横向参考，不引入）

| 项目 | 范式 | 许可 | 为什么不直接接 |
|---|---|---|---|
| Mem0 | 抽取式事实 + 向量（+可选图），每次写入至少 1 次 LLM 调用 | Apache-2.0 | 它拥有一轮对话的记忆策略；本项目主体循环自己拥有。且引入即接受它的 schema |
| Zep / Graphiti | 双时态知识图，边有 `[t_valid_start, t_valid_end)` | Graphiti Apache-2.0；**Zep CE 2025-04 已废弃**，只剩 Cloud | 需要 Neo4j/FalkorDB；自托管路径实际是 Graphiti 裸用 |
| Letta（原 MemGPT） | OS 式分层：核心内存块 + 归档向量，自编辑 | Apache-2.0 | 要求采用它的 agent runtime —— 与 C2/C7 直接冲突 |
| Cognee | ECL 管道（图 + 向量 + 关系三存） | Apache-2.0 | 最重的基础设施 |
| LangMem / LangGraph | SDK 层记忆管理器 | MIT | 绑定 LangGraph 编排 |
| Supermemory / memobase / memU | 产品化记忆层 | 混合 | 服务化，C4 |
| Anthropic Memory Tool | 文件型记忆，模型按需读写 | 提供商原生 | **概念最接近本项目已有形态**（notes/ + 工具），值得借鉴而非引入 |
| Redis Agent Memory Server | 两层（工作 + 长期）+ 自动晋级 | Apache-2.0 | 需要 Redis |

**可借鉴的三条概念**（比代码值钱）：Zep 的双时态边失效、Letta 的"分层 + 自编辑"、Anthropic 的"文件即记忆 + 按需 JIT 读取"。

### 3.12 评测

| 基准 | 是否适用 | 理由 |
|---|---|---|
| LOCOMO | **不适用** | 已公开证伪：对话仅 16k–26k token，**全上下文塞进 prompt 的朴素基线就能超过专用记忆系统**。用它做验收等于自欺 |
| LongMemEval | 可参考 | 更长上下文 + 时序 + 知识更新；第三方数字显示时序图方案领先约 15 点 |
| 自建金标集（推荐） | **采用** | 从本机 1218 条 journal 出 30–50 条查询，分三类：精确（原话复述）、模糊（同义改写）、关系（谁在何时答应过什么） |

指标：`recall@5`、`MRR`、**假阳性率**（返回了但实际不相关——比召回不足更危险，因为它会被当成事实）。

### 3.13 程序性记忆（skill）与代码载体（JEV）

初版遗漏。记忆按**验收方式**分三类，不是按"像不像人"分：

| 类型 | 载体 | 验收 | 过期方式 | 仓库现状 |
|---|---|---|---|---|
| 事件（episodic） | journal JSONL | 一字不差的原文 + 时间戳 | 永不过期（只追加） | 已有 |
| 理解（semantic） | notes markdown + 关系边 | 出处可核，可被更强证据推翻 | 被新证据推翻（版本化） | 部分（无索引、无版本） |
| 做法（procedural） | skill markdown + eval 集 | **跑一组 eval** | 被更好做法替换（supersedes） | **已有且带验收** |

#### skill 与笔记的判别标准

不是"长短"，也不是"重要程度"，而是：**有没有可执行的验收标准。**

- 笔记回答"发生了什么 / 什么是真的" → 验收靠**读**：能核对出处、能被推翻。
- skill 回答"这类事怎么做" → 验收靠**跑**：给定输入，能判断做对没做对。

仓库里的现成样本：`.agents/skills/reality-first-development/SKILL.md`。

```yaml
---
name: reality-first-development
description: >-
  Use for consequential software architecture or refactoring decisions where
  current behavior or claimed improvements need verification. ...
---
# 正文：证据分层（Observed/Tested/Implemented/Assumed/Aspirational）…
```

配套 `evals/evals.json`：每条 `{id, prompt, expected_output, expectations[]}`，当前 10 条。

**这一点比 format 本身重要**：skill 自带金标集。§7 建议"自建 40 条金标查询"来验收召回——仓库里已经用同样的方法验收"怎么做事"了。这不是巧合，是可复用的模式：**任何"做法"都必须带一组能判对错的输入，否则它不是 skill，是一段意见。**

#### skill 的检索问题与记忆同构

`name + description` 常驻、正文按需加载，就是**渐进披露**。skill 只有 1 个时无所谓；到 30 个时把全部 `SKILL.md` 塞进 system prompt 是灾难。这与"常驻开销趋零、召回按次付费"是同一条规则——**skill 是记忆系统的一条读路径，不是另一套系统**。

代价未测：本仓库只有 1 个 skill，从没测过 30 个 skill 时 `description` 全集的 token 占用量级。这是 §8 的未验证项。

#### 归属：进 Notes 层，不另开第五层

层是**权威与可重建性**的划分，不是内容类型的划分。skill 可修订、人可读、每份一个当前版本——它落在 Notes 层，只是子类型：

```
Notes.kind = note | skill | profile | topic
skill 额外字段：when（触发条件 = cue） / verify（evals 路径或一条可执行检查） / supersedes
```

#### 代码载体（JEV / quickjs-wasi）：解决 token，不解决记忆

`quickjs-emscripten` 已是依赖（0.32.0），且已经跑起来：`.uina/worlds/minecraft/program/worker.ts` 用 quickjs 在 worker 里执行模型写的程序，`program/shim.ts` 捕获 intrinsic、冻结 checkpoint、结构化错误。MCP 设计文档把"JEV 脚本沙箱"列为非目标（"批量操作的上下文优化，属第二阶段；依赖重"）——**那个判断在 MCP 语境里成立（批处理在请求路径上），在记忆语境里要重算（记忆的批处理是离线的）**。

代码作为记忆载体有三种用法，价值差别极大：

| 用法 | 例子 | 判断 |
|---|---|---|
| 过程可执行 | "怎么从这堆日志抽出承诺" → 脚本跑一次出结果 | **值得**。省掉模型每次照文字重做，且不会抄错 |
| 结论可执行 | 把结论存成脚本，运行时算出来 | **危险**。结论变代码即不可读，人无法核对，出错静默 |
| 索引可重建 | 索引/抽取/校验脚本本身 | **必须**。这是"可重建"的落实方式 |

边界只有一条：**代码可以承载"怎么做"，不能承载"什么是真的"。**

理由不是洁癖，是失败模式不同：代码的错误表现是"跑出了结果但结果是错的"，只有测试能发现；文本的错误表现是"读一眼就发现不对"。前者需要 evaluator，后者需要一个读者。而记忆系统里最贵的读者就是她本人——不能让结论只有测试守护。

结论：JEV 不作为记忆存储，只作为**离线批处理与校验**的执行器；是否复用 MC 那套 worker + shim，等 §7 金标集需要批量抽取时再定。

#### 先例：Voyager 的技能库

Minecraft 开放世界 Agent 的 Voyager（NVIDIA, 2023）是这条路的完整样本，三个设计正好对应本节的三件事：

1. 技能**存成可执行代码**（JavaScript 函数），不是文字描述；
2. 技能库用**描述文本的向量**做索引，不是拿代码本身做检索键；
3. 新技能只有在**自验证 + 环境反馈**通过后才入库。

它的失败模式也值得记：技能库里一旦进了错技能，后续所有组合调用都会继承这个错误，而且因为代码能跑，错误不会自己暴露。这正好印证了上一节的边界——**代码承载过程、不承载结论**，且"能跑"不等于"跑对了"。

本项目不需要引入 Voyager 的任何代码；需要的是它那条判据：**一条技能不能入库，除非它被跑对过一次，且有记录证明。**

#### 反向风险：skill 会把"偶然做对一次"固化成"永远这么做"

`reality-first-development` 是方法论，风险低。但"直播开场怎么说"这类 skill 一旦写死，就再也学不到新的开场。**skill 是学习的敌人，除非它自带退役机制。**

最小要求：每条 skill 记录 `last_success` / `last_fail`（来自实际执行，不是自评），连续失败 N 次进入 `retired`，且 `supersedes` 指向替代它的那条。没有这组字段的 skill 只是一段会腐烂的文字。

---

## 4. 排除清单（一次性列全）

**已被证明不能用作长期依赖**：Kùzu（2025-10 归档，团队并入 Apple；Graphiti 已把它的驱动标为 deprecated）、Zep Community Edition（2025-04 废弃）、Marqo OSS（官方标注 deprecated）、`sqlite-vss`（被 sqlite-vec 取代，依赖 Faiss）。

**形态不匹配**（不是不好，是不该在这用）：Elasticsearch、OpenSearch、Solr、Vespa、Manticore、Meilisearch、Typesense、Qdrant、Weaviate、Milvus、Chroma 服务、Pinecone、turbopuffer、Neo4j、Memgraph、FalkorDB、ArcadeDB、DuckDB（分析型，中文 FTS 无解）、Postgres + pgvector/ParadeDB、LMDB/RocksDB/LevelDB、Dolt、TerminusDB、Oxigraph。

**语言栈不匹配**：FAISS、GLiNER、HanLP、Stanford CoreNLP、REBEL、DeepKE、OneKE、sentence-transformers、Tantivy、Bleve。

**过度抽象**：CRDT、Prolog/Datalog 推理机、通用"学习框架"、多 Agent 互相评议、情绪评分器。

---

## 5. 三套候选组合与成本

### A 档：零新增依赖（建议起点）

`node:sqlite`（内置）+ FTS5 `unicode61` + `Intl.Segmenter` 预分词 + 边表 + 递归 CTE + 双时态列 + sha256 manifest。

- 新增 npm 依赖：**0**
- 磁盘：索引 < 1 MB（1218 条）
- 延迟：建 114 ms（worker）/ 查 0.5–1.5 ms
- 能力：精确召回、词形放宽、字段与时间过滤、多跳关系、时序、**skill 与 note 同层索引（渐进披露读路径）**
- 明确缺口：**语义近似**（"声音"查不到"音频"）、专名分词不完美
- 附带收益：skill 已有 `evals/`，A 档可以立刻拿到第一组验收数据，不必等金标集写完

### B 档：A + 本地嵌入

加 `@huggingface/transformers` v4 + `onnxruntime-node`，模型 granite-97m-multilingual-r2（int8，≈98 MB，首次下载）。

- 新增依赖：1 个原生模块（跨平台预编译）+ 模型文件
- 内存：常驻 ≈ 300–400 MB（含 ONNX runtime）
- 延迟：单条嵌入 CPU 数十至百余 ms → **必须 worker + 批量离线**；查询侧只嵌 1 条
- 存储：384 维 int8 → 1218 条 ≈ 0.5 MB
- 检索：FTS5 结果与向量结果用 RRF 融合（k=60）
- 新增风险：模型下载、原生模块分发、版本锁定

### C 档：B + 重排

加 cross-encoder（bge-reranker-base），独立子进程。

- 收益：把 top-20 的"相似"压成 top-5 的"相关"
- 成本：+1 模型常驻；每次召回多 100–300 ms
- 触发条件：B 档的**假阳性率**实测超过可接受阈值

### D 档（不建议）：外部服务

Qdrant / Meilisearch / Neo4j 任一。要为一个用户、一万条以内的语料维护一个带端口、备份、健康检查的进程。除"将来要多机共享"外没有理由。

---

## 6. 观察名单（带触发条件）

| 技术 | 现在的状态 | 什么条件下才回来考虑 |
|---|---|---|
| sqlite-vec | pre-1.0，0.1.9 稳定版只有暴力扫描，ANN 在 alpha | 向量数 > 10 万，或 1.0 发布 |
| LanceDB | v0.40，pre-1.0 | 需要多模态（图像/音频向量）且 SQLite 装不下 |
| LadybugDB | MIT，Kùzu 的活跃分支，单 RW 进程 | 图成为主存储（而不是索引的子结构） |
| `@node-rs/jieba` | 预编译可用 | 专名/代号召回不足被实测确认 |
| Qwen3-Embedding-0.6B | ONNX 可用 | granite-97m 的召回被实测证明不够 |
| `node:sqlite` 稳定性 | Node 22 = 1.1，Node 24 = 1.2 | Node 26 转 LTS（2026-10-28）后复核 API 与类型 |
| 重排模型 | bge-reranker / Qwen3-Reranker | 假阳性率实测超标 |

---

## 7. 唯一的验收基准

外部榜单全部不用。理由已经写进 §3.12：LOCOMO 被证明连"全上下文塞满"都打不过，而厂商之间还在互相指控对方配错了参数。

自建金标集的做法：

1. 从本机 journal 抽 40 条真实议题，人工写三类查询各 10–15 条（精确 / 同义 / 关系）。
2. 每条查询标注"正确答案的 journal seq 或 note 路径"，允许 1–3 个正确答案。
3. A 档、B 档各跑一遍，出 `recall@5` / `MRR` / 假阳性率三张表。
4. **判据**：若 A 档 recall@5 已达 0.8，B 档不上。若 A 档低于 0.5 且在"同义"类集中失效，B 档才有存在理由。

**格式不要自创**：直接复用 `.agents/skills/*/evals/evals.json` 的 `{id, prompt, expected_output, expectations[]}` 结构。理由是它已经在用、已经有工具链习惯、而且把"记忆验收"和"做法验收"合并成同一种资产——一套 evaluator 能同时回答"她记得对不对"和"她做得对不对"。这比维护两套格式便宜得多。

这套金标集同时也是"第 0 步：量化"的产物——没有它，任何记忆系统都无法证明自己有用。

---

## 8. 未验证项与置信度

**实测（本机可复现）**：§2.2 全部数字、FTS5 中文失效、trigram 短查询失效、Segmenter 可用、递归 CTE 延迟、余弦延迟。

**外部高置信**（多来源一致）：Kùzu 归档与 LadybugDB 继承、Zep CE 废弃、sqlite-vec pre-1.0、LanceDB pre-1.0、`node:sqlite` 稳定性分级与 Node 26.11 改名、LOCOMO 的方法学问题、各家许可。

**外部中置信**（单一来源或二手汇总，未复现）：MMTEB 分数（granite 60.3 / Qwen3-0.6B 64.64 / bge-m3 54.60）、EmbeddingGemma-2 的 CPU p50 168 ms、granite-97m 的 int8 ONNX 体积 98 MB。

**未验证**：本机 granite-97m / Qwen3-0.6B 的实际单条嵌入延迟与内存峰值（没下载模型）；onnxruntime-node 在 Windows + Node 22 的分发是否顺滑；中文口语语料上 embedding 与 FTS 的真实互补度；重排收益；**30 个 skill 时 `description` 全集的常驻 token 占用量级**（现在只有 1 个 skill，没有量级可测）；skill 的 `last_success/last_fail` 该从哪里取（实际执行回执 vs 自评，后者不可信）。

以上六项都可以在本机一天内测掉，且**都应在写任何记忆代码之前测掉**。

---

## 9. 与架构的关系（一句话）

技术清单只回答"用什么"；不回答"要不要"。四层（journal / notes / index / recall）与那条硬规则（索引可重建、不得拥有事实）在本调研里没有一处被推翻——**实测反而把它们从主张变成了已付费的结论：所有索引层技术加起来，成本是 114 毫秒和不到 1 MB。**

补上程序性记忆之后，四层不需要变成五层：skill 是 Notes 层的一个 `kind`，代码（JEV）是 Index 层的重建器与离线批处理执行器。**层的数量由"谁拥有权威"决定，不由"记忆有几种"决定**——后者无限可分，前者只有一条线。
