# 批 8：Library 文件与发现复用

基线：`codex/phase0-baseline` / `346cfd0`；开工工作树干净，使用当前 checkout；初始实施不提交，后续按用户要求常规审查并提交，不推送。

## 范围与实现

- [x] 文件材料：三类统一命名、realpath 边界、递归程序扫描、头解析及可读诊断；执行入口把库错误转为 Program 领域失败。
- [x] 文件管理：program/experience/blueprint 的 list/get/save/update/delete、摘要冲突、同条目写入串行、无覆盖创建、临时文件替换。
- [x] 来源与发现：同引擎 compile-only；从已提交 Call 核对 run/segment/call/program 后读取摘要校验快照；四类统一发现和精确描述。
- [x] 正式接线：World façade → 固定 IPC → Companion → Library；Program 注入只读加载函数，Library 注入编译与来源函数。
- [x] 最终源码/产物/真实模型验收与收尾。

```text
WorldTool → Executor/IPC → Companion
                          ├─ Library（普通文件与元数据）→ 同源目录
                          ├─ Program（compile-only、执行、不可变快照）
                          └─ Runtime（已提交 Call 与所属身份）
```

Library 不持有完整 Program/Runtime 服务，不建资产数据库或第二份执行结论。改动限于 Minecraft World、测试、入口和相关文档；Core/Host/Session、真实 Provider 配置/认证/会话及 Pi 均未修改。

## 裁决与边界

- 蓝图 save 允许已放入原件但未登记 about.json 的目录；about 已存在则 NAME_EXISTS。design 必须是文件，不能用同名目录登记成功。
- Raw 只报告实际可读字节，不解码 `.schem`、不认证施工。Target 只读 JSON/schema 身份和摘要，并标 `validation:unavailable`；需要语义校验时仍由 Construction 明确 SCHEMA_UNAVAILABLE。
- update 的完整源码替换不继承旧头；metadata 补丁保持脚本体字节及合法 saved。save from 的 saved.digest 指执行字节，文件 digest 指新头及正文；二者可以不同。
- 同条目工具写入串行；expectedDigest 在发布前复核，不能锁外部编辑器。创建以临时文件 hard link 无覆盖发布，更新以 rename 发布；失败清理自有临时文件。
- 工具取消只结束本地等待；已派发文件写入继续结算。回执丢失/超时保留 unknown 并给 get 读回，不重试写入；收到完整远端拒绝时保留明确失败。
- 已固定的段内名字材料不因文件更新/删除改变，新段读取当前文件。删库文件不删 runs 快照；save from 在 SQLite 重开后仍能取得原调用材料。

## 独立审查与修复

独立只读审查发现四项问题，均用失败回归复现后修复：Program 加载丢失领域错误码；远端明确拒绝误报 unknown；非取消型写 RPC 使工具等待忽略取消；蓝图登记错误接受 design 目录。

前两项回归日志：Temp 下 `uina-mc-library-review-red.log`；后两项：`uina-mc-library-review-red2.log`。定点修复后 2 文件/11 项通过；最终回归另列下表。

## 验证记录

环境：Windows 11 x64 / Node 24.13.1 / pnpm 11.5.2 / Java 21.0.9 / Paper 1.21.11 build132 / offline UinaDev。文件、SQLite、Host 会话使用独立 Temp 数据根。

| 检查 | 当前证据 |
|---|---|
| `pnpm typecheck` | PASS（格式、9 条边界、TS） |
| MC 专项 vmThreads | 提交前最终 40 文件/305 项 PASS |
| 默认池 Host 相关 | 5 文件/27 项 PASS |
| `pnpm build` | PASS；含新增 Library、入口和现有 Worker/native |
| `pnpm dev:mc:library` | 最终正式源码/Paper **7/7 PASS**；独立数据 `uina-mc-native-Oaywh7` |
| 构建产物入口 | 最终 **7/7 PASS**；独立数据 `uina-mc-native-IJnZ1W` |
| 真实模型复用 | deepseek-flash **4/4 PASS**；独立数据 `uina-mc-model-ySWwK2` |

构建产物首次复跑在第二次采集失败：服务端明确记录 UinaDev 被 Zombie 击杀。保留失败数据 `uina-mc-native-tbhWRU` 与 `uina-mc-library-dist.log`，未把它算作 Library 验收通过，也未修改采矿完成判定。Library 场景的准备阶段增加白天/晴天与专用区域内残留实体清理，再进行正式复跑；被测采集与生产仍全部走正式生存操作。

游戏侧只在既有 16000 附近专用验收平台准备场景，不重置世界。文件级 Raw fixture 仅证明字节保真，不是有效蓝图或可施工性证据。

## 后续

仍为 10 查询 + 15 动作（25/51）。下一批为 World 可等待查询、Runtime/Program 决策与 continue、调度和 I2。反馈自保、Construction 语义、Microsoft 认证及其他协议版本不在本批交付范围。

首轮真实 deepseek-flash 已完成保存、源码替换、再生产（库存 4→8）和经验文件写读，但验收脚本随后把 WorldTool 的 details 当成原始数组，触发 TypeError；另修正完整 source 替换后必须保留 saved 头的错误假定。该轮保留为 `uina-mc-model-e8izwA`，不计作整体验收通过；最终模型校准使用修正后的检查。

第二轮模型同样完成了真实复用（8 木板），但最终检查仅取 runs.list 第一页（10 项，被场景准备调用占满），漏掉后续程序运行。保留数据 `uina-mc-model-rwtOfI`；只修正验收对 runs.list/calls 的分页读取，不改变成功、摘要或来源判据。

大输入来源保存补充：300000 字符输入的真实 Call 记录超过 Runtime 的 256 KiB 内联预算，会返回摘要校验的导出文件。回归先复现读取失败，再让来源适配消费正式 auto RecordReply（核对文件长度/sha256），随后校验 Call 身份与不可变源码。未改 Runtime 存储合同或预算。最终真实 SQLite/QuickJS 回归通过。

最终日志均在 Temp：`uina-mc-library-tests-complete.log`（40/303）、`uina-mc-library-host-final.log`（5/27）、`uina-mc-library-build-complete.log`、`uina-mc-library-source-final.log`、`uina-mc-library-dist-complete.log`、`uina-mc-library-model-verified.log`。模型实际执行原生发现、程序提交、缺料纠错、save from、get/describe、完整 source 更新、命名再执行和经验写读；库存实际从 4 增至 8 木板。modelRequests 只统计受控 stream，不用于真实 Provider 请求次数。

收尾：Paper 经正式 Executor/Runtime 的 chat@1 发送 `/stop`，服务端完成各维度保存，启动会话 exit 0，25565 无监听。没有强杀或重置世界；验收数据与日志保留。批 8 验收结束时改动留在基线分支的未提交工作树；后续按下节常规审查并提交，不推送。

## 常规审查与提交前验证

对 `346cfd0` 以来的完整批 8 改动进行独立只读审查，修复两项由失败回归确认的问题：

1. 普通首行 `// uina-helper` / `<!-- uina-related ... -->` 被误认为元数据头，连合法头后的普通注释也可能被当成重复头。现在只识别完整标记，普通注释及正文原字节保留。
2. saved 允许额外字段写入，而 IPC 的 savedFrom 返回合同拒绝额外字段，导致 update 成功后 get 报协议错误。统一按固定字段校验：非法更新返回 HEADER_INVALID 且保留旧文件；外部编辑的坏头仍返回原文与 headerError，执行明确拒绝。

两项均先失败后通过。提交前 `pnpm typecheck`、MC **40 文件/305 项**、默认池 Host 相关 **5 文件/27 项**、`pnpm build` 通过。实际构建产物的 Library/QuickJS Worker/头解析/IPC 返回校验专项入口通过，临时数据 `C:/Users/34150/AppData/Local/Temp/uina-mc-library-precommit-dist-grKXsm`。

日志：Temp 下 `uina-mc-library-precommit-tests-final.log`、`uina-mc-library-precommit-host.log`、`uina-mc-library-precommit-build.log`；产物验证脚本为 `uina-mc-library-precommit-dist.mjs`。本次修复不涉及游戏协议，沿用上节对应边界的真服/模型证据，未再次启动服务器或调用真实模型。无剩余已知审查问题。用户已要求提交，工作按同一批次收口，不推送。
