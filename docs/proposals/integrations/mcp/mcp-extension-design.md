# MCP 扩展设计（外部能力接入）

状态：P0 代码实现已存在于 `.uina/extensions/mcp/`。本文保留实现合同和当时审查结论；列出的 MCP 测试本轮未运行。远端 SSE/server 行为、跨平台进程收尾及实际工具输出仍需按具体部署验收。参考实现：`E:/Uina/Research/pi-mcp-adapter`（MIT，仅作设计参考，不复制代码）。

## 0. 一句话定位

给 Uina 接入 MCP server 生态：一个 `mcp` 代理工具 + 按需启动的连接管理，内核五目录零改动，全部通过现有扩展接缝生长。代理折叠的是**认知接口**，不折叠权限身份。

## 1. 目标与非目标

### 目标（P0）

- 模型通过**单个** `mcp` 代理工具发现和调用 MCP server 的工具，不把工具定义注入上下文。
- 冷启动可自举：新配置的 server 通过 `list(server)` 完成首次发现，无死锁。
- server **按需启动**：首次调用/定向发现才拉起；无活动协议交互持续闲置一段时间后停止。
- 工具目录**咨询性持久缓存（Advisory Persistent Catalog）**：保存最近一次认知快照，fresh/stale 如实标记；`search/describe` 不需要活连接；不把工具定义注入上下文。
- 支持 stdio 与 HTTP 两种 transport 形态（HTTP = streamable-http，含兼容回退 SSE，见 §4 `httpTransport`）。
- 兼容广泛采用的 `.mcp.json` / `mcpServers` 配置约定（注意：是生态约定，不是协议标准）。
- **MCP `CallToolResult` 保真降级投影（Loss-aware Projection）**到 Uina 的工具结果（`text` / `image` / `audio` / `embedded resource` / `resource_link` / `structuredContent`，见 §8.2），不丢类型事实。
- 工具结果严格映射 Uina 五态（`succeeded/failed/cancelled/unknown/not_started`），五态全部有定义。
- **项目级配置 = 安全边界**：项目配置（`.uina/mcp.json` 或 `.mcp.json`）声明的 server 首次启动前必须经过用户信任确认。

### 非目标（明确不做，出现真实需求前不讨论）

| 砍掉的能力 | 一句话理由 |
| --- | --- |
| OAuth 授权流 + OS keychain | 起步只连本地/免认证 server；连云端 server 那天再做 |
| JEV 脚本沙箱（quickjs-wasi） | 批量操作的上下文优化，属第二阶段；依赖重 |
| 语义搜索（System One） | 工具少时目录浏览足够；工具多到搜不动再买 |
| MCP UI apps（server 下发 HTML） | 协议特性过新，支持的 server 寥寥 |
| 宿主配置导入 + 预设目录 | 从零配置起步，无可移民对象 |
| TUI 管理面板 | Uina 的 UI contract 不同；代理工具自身回报状态 |
| elicitation / sampling / prompts / tasks | 协议长尾；不注册 handler，SDK 自动按 capability 缺失拒绝 |
| McpRegistry / PolicyEngine / CatalogService 等新公共概念 | 职责由扩展内部模块清晰承担，不新增向内核或外部暴露的公共接缝 |

### 安全与防御策略基线（对齐 pi-mcp-adapter，不比它更严，也不比它更松）

安全/防御策略以 `pi-mcp-adapter` 为基线，**不比它更严，也不比它更松**。Uina 只保留因自身 ToolResult、生命周期、权限接缝不同而必需的适配，不自行追加"更保险"的限制。**所有已知的有意偏差必须在下方对照表（⚠️ 项）与 §15 分歧清单中显式登记，不存在未登记的静默偏差；未登记项一律视为承诺完全对齐。**

#### 参数与数值阈值对照表

| 维度 / 参数 | Uina 规格 | pi-mcp-adapter 当前行为 | 对齐说明 |
| --- | --- | --- | --- |
| `idleTimeoutMs` | 600,000 ms (10 min) | 600,000 ms (10 min) | ✅ 完全对齐 |
| `callTimeoutMs` | **默认不设置**，交 SDK（默认 60s）；允许显式覆盖 | 默认不覆盖，交 SDK（默认 60s）；允许显式覆盖 | ✅ 完全对齐 |
| `startupTimeoutMs` | **默认不设置**，connect/握手与请求同走 SDK 默认 request timeout（SDK v2 默认 60s）；允许显式覆盖 | `client.connect()` 走 request timeout，未配置时交 SDK（默认 60s），无独立 startup 配置 | ✅ 完全对齐（删除自设的 30s）；未建连超时仍归 `not_started`——五态映射只要求分相归属，不要求自设预算 |
| Catalog 默认 TTL | **无默认时间老化**（仅消费 server `ttlMs` 与指纹） | `maxAgeMs = 0`（无默认老化，仅消费 server `ttlMs`） | ✅ 完全对齐（删除自设的 24h） |
| `search` 展示数量 | **最多 12 条** | 默认 12 条 / page | ✅ 完全对齐 |
| raw details 限制 | 16 KiB 摘要落盘 | 16 KiB 摘要落盘 (`boundMcpResult`) | ✅ 完全对齐 |
| call 文本输出 | 50 KiB / 2000 lines 截断落盘 | 50 KiB / 2000 lines 截断落盘 | ✅ 完全对齐 |
| 单图限制 | **不设 MCP 专属限制**，遵循 Uina ImageContent 合同 | 图片不设 MCP 专属限制，直接通过 | ✅ 完全对齐（删除自设的 4 MiB） |
| 二进制资源 | 10 MiB / 单文件；100 MiB / 计量窗口累计；10,000 files / 计量窗口 | 10 MiB / file; 100 MiB / session; 10,000 files / session | ⚠️ **数值对齐，计量窗口暂有意不同**：Pi 按短命 CLI 进程的 session 计；Uina P0 扩展层尚无 session 生命周期接缝，暂按 activation 计（reload/重启即重置，超限拒绝该次写入并明确报错，非永久封锁，见 §6）。activation 跨多 session 累计，严格说比 Pi 严——扩展层获得 session 边界后切换 per-session 并随 session 回收临时文件（P1），此前不得宣称"完全对齐" |
| tools / server 上限 | **不设硬上限**，完整登记三元组集合 | 官方无硬上限 | ✅ 完全对齐（删除自设的 500 工具限制） |
| tool metadata / schema / catalog 字节 | **不设 MCP 专属硬上限**，展示层有界保护 | 无对应硬上限 | ✅ 完全对齐（删除自设的 16KB/256KB/4MB 限制） |

- **不额外强化（放宽至 Pi 基线）**：
  1. **stdio 环境变量**：采用 Pi 默认行为，`inheritEnv` 默认 `true`（全继承），用户可显式设为 `false`；不再默认隔离环境；
  2. **资源预算与 Output Guard**：直接向 Pi 的 Output Guard 靠齐（文本 50 KiB / 2000 行、details 16 KiB、binary resource 10 MiB / 单文件、100 MiB / 10,000 files 累计——数值对齐，计量窗口 P0 暂按 activation，见 §6；图片直传 `images[]`）；删掉 MCP 自行发明的 500 工具、16KB 元数据、256KB schema、4MB 目录、4MB 图片等额外硬限制；
  3. **Catalog 默认 TTL**：删除自设的 24h `catalogTtlMs`，对齐 Pi `maxAgeMs = 0`（默认无时间老化，仅尊重 server 声明的 `_meta.ttlMs` 与配置指纹）；
  4. **超时策略**：`callTimeoutMs` 与 `startupTimeoutMs` 默认均不设置，交 SDK 默认 request timeout（60s）处理（允许显式配置覆盖）；建连阶段超时 → 请求从未发出，状态归 `not_started`（五态映射只要求分相归属，不要求自设独立预算）；
  5. **`search` 展示数量**：对齐 Pi 默认值，展示上限由 20 调整为 12；
  6. **HTTP 凭据与重定向**：对齐 Pi——请求携带 configured sensitive credentials（如 Authorization header 或 query 凭据）时**拒绝一切 HTTP 重定向（含 same-origin，`redirect: "error"`）**；无敏感 credentials 由 transport / SDK 正常处理重定向。不额外发明二次信任确认协议；
  7. **工具审批**：走 Uina 统一的 `tools.beforeCall` 做名字级粗粒度拦截；annotations 仅作为执行后进入 `details` 的审计元数据（见 D11 与 §9），MCP 扩展内部不自造审批引擎。

- **完整保留（与 Pi 保持同等防御）**：
  1. **Project Server Trust**：项目级配置中的 stdio/HTTP server 首次启动需用户逐 server 确认；
  2. **Definition Change Reapproval**：server 定义哈希（`definitionHash`）变更后需重新确认；
  3. **Credential Redaction / Origin Protection**：展示与日志中的 URL query / basic auth 敏感参数全面脱敏，凭据绑定目标 origin；
  4. **Output Guard**：文本、details、二进制资源超限落盘保护（累计计量窗口 P0 暂按 activation，见上表）；
  5. **Approval Gate**：外层 broker hook 统一拦截；
  6. **Untrusted Server Metadata**：外部元数据不得注入 system prompt。

- **正交的运行时一致性（Runtime Consistency）**：
  单操作不可变快照（防 TOCTOU）、draining 连接优雅过渡（保护 in-flight，含目录刷新在途的连接，见 §7）、superseded 丢弃与严禁跨代跳跃、catalog 统一新鲜度判定（准入检查 + 指纹/TTL，见 §6）、`isLegacyTransportCompatibilityError` 谓词集中守门等，属于 Uina 长期运行主体与配置热重读的**正确性与一致性纪律**，与安全策略等级正交，全部完整保留。

## 2. 决策记录

| 决策 | 内容 | 依据 |
| --- | --- | --- |
| D1 协议层用官方 SDK | 依赖官方 `@modelcontextprotocol/client`（**锁死确切版本 `2.x.y`**，不用 `2.x` 浮动版本）；**不直接依赖 core**——Pi 的 server-manager 也只 import client，core 是给 wire 级网关用的 | 协议是商品；client 是 client 使用者的唯一入口；深度依赖 v2 特定补丁行为（如无参 auto-pagination、auto 协商），必须确定性锁定 |
| D2 代理工具模式 | 只注册一个 `mcp` 工具（def 约 200 token），server 工具不进 `defs()` | 契合 `agent/context.ts` 投影纪律；参考实现有同形代理表面 |
| D3 lazy lifecycle | `list(server)` / `call` 才启动 server；**无活动协议交互**闲置默认 10 分钟停止 | 不为闲置能力付进程成本 |
| D4 咨询性持久目录（Advisory Catalog） | 全局目录文件保存最近一次认知到的 MCP 能力快照；定位为 **Advisory Cache**（经验性咨询缓存，非分布式强一致镜像）；stale 仍可发现但标记；`call` 不负责冷发现，必须在 catalog 中精确匹配三元组；普通业务执行失败（`isError:true` / 403 / 文件不存在等）只如实返回 failed，绝不污染目录 freshness；仅当能力层明确失配（如 server 报错工具不存在、Method not found）或收到 `list_changed` 时才标记为 stale；模型若怀疑目录过时可通过 `list(server)` 显式重新校准（`list()` 仅查本地 catalog，`list(server)` 始终访问 server 重新发现并刷新目录） | 离线可检索、防工具定义污染上下文；Server 本身拥有合同与能力的最终裁决权，不为强一致维护复杂的多代同步系统 |
| D5 放置位置 | `.uina/extensions/mcp/`，作为项目外部扩展由现有 loader 发现与装载 | 内核与 Host 组合根零 MCP 专用装配 |
| D6 目录命名 | 工具全名 = `{serverName}.{toolName}`，**catalog 内部保存三元组，路由只做精确匹配，绝不 split 字符串**（MCP 工具名合法含 `.`，如 `admin.tools.list`）；同名冲突在目录登记时报错 | 消除歧义路由 |
| D7 重试 | 不做自动重试，失败如实报 | 消除静默自欺；模型可自行决策重试 |
| D8 isError 语义 | MCP `isError:true` → Uina `failed`，错误正文完整提供给模型 | "API authentication failed" 状态却是 succeeded 属于自欺；Pi 同样按错误处理（`host-managed.ts:488-490`）；与 exec_command 退出码语义一致 |
| D9 cancelled 语义 | 以 **tools/call 是否已发出**为分界：未发出被取消 → `cancelled`；已发出被取消/失联/超时 → `unknown` | 副作用未确认不得推断；取消发生在自己进程内是可确认的 |
| D10 协议状态机归 SDK | 扩展只定义 `ensureClient(server)`；握手细节、底层 wire 兼容与能力协商全部交给官方 SDK，扩展不复刻协议层 wire 状态机；但 Uina **清楚理解并诚实消费所依赖的 MCP capability 语义**（如 auto 模式、`ClientOptions.listChanged` 跨时代抽象、`ttlMs/cacheScope` 咨询提示）。**显式设置 `versionNegotiation: { mode: "auto" }`** 以探测现代特性，协议演进由锁定具体补丁版本的 SDK 吸收 | Pi `types.ts:507-512` 明确默认 legacy，auto 必须显式设；不自欺宣称"完全不持协议知识"，而是明确切分：wire 兼容归 SDK，能力语义归消费方 |
| D11 权限身份与审批接缝 | 逻辑 action identity = `mcp:<server>.<tool>`。**真实调用时序分两层**：① 外层 broker pipeline 在进入 proxy run 之前触发 `tools.beforeCall`——钩子入参只有 `{ name: "mcp", args }`（`src/tools/pipeline.ts:8-15`），**仅能做名字级粗粒度拦截**（从 `name` + `args.tool` 字符串推导 `actionIdentity` 判定放行/拦截，拦截则直接 `not_started`）；② 内层 proxy run 随后执行信任门、建连、refresh 与 re-resolve。identity 最终进入 `details.effects`（沿用 exec_command 模式）与 trace/审计。**annotations 的诚实定位**：server 声明的 `readOnlyHint` / `destructiveHint` 等**只在执行后进入 `details.annotations`**，作为审计与后续策略的记录——`tools.beforeCall` 发生在进入 MCP 扩展之前，结构上拿不到注解，P0 **不存在**注解参与的事前审批引擎，MCP 扩展内部也绝不自造第二套审批系统（Pi 的 `approveTools: "destructive"` 得以工作，是因为 Pi 按工具注册真实工具、def 自带 annotations；代理工具架构下事前拿不到，如实承认这一差异） | 统一权限管辖，代理折叠认知接口但不折叠权限身份；hook 合同以 `src/tools/pipeline.ts` 实际签名为准，不虚构接缝能力 |
| D12 项目配置信任 | 项目配置（`.uina/mcp.json` 或 `.mcp.json`）的 server（stdio 命令与远端 origin）首次启动前必须用户确认；确认记录 = 项目根 + server 名 + 定义哈希 | 仓库能声明本机执行什么命令是最大攻击面；机制采 Pi `project-server-trust.ts` 简化版 |
| D13 Output Guard（数值对齐 Pi 基线） | 输出保护对齐 Pi 的 Output Guard 边界：文本 50 KiB / 2000 行截断落盘（`fullOutputPath`）、details 16 KiB 摘要落盘、binary resource 10 MiB 落临时文件；图片直接直传进入 `images[]`（遵循 Uina 原生 `ImageContent` 合同）。不为 MCP 自行发明额外的超细防御预算矩阵（删去 500 工具/16KB 元数据/256KB schema/4MB 目录等额外硬限制）。**计量窗口（暂定，如实标注）**：累计计数（100 MiB / 10,000 files）P0 暂按扩展 activation 生命周期（reload/重启即重置），超限拒绝该次资源写入并明确报错，绝不造成工具永久封锁；**这是"数值对齐、窗口未对齐"的已知偏差**——Pi 按 session 计且 session 短命，activation 跨多 session 累计严格说比 Pi 严。扩展层获得 session 生命周期接缝后切换 per-session 并随 session 回收临时文件（P1） | 保护模型上下文与会话落盘；与 Pi `mcp-output-guard.ts` 数值同基线；窗口差异如实标注，不宣称"完全对齐" |
| D14 instructions = untrusted MCP metadata | server instructions 作为 untrusted metadata 对模型**有界可见**：`list(server)` 返回时附 bounded preview（若有，明记为 untrusted server metadata）；**绝不进入 system prompt / trusted context**。不做独立 instructions action（需求出现再议） | 对齐 Pi：Pi 把 instructions 当 untrusted discovery data 给模型（`mcp({ server })` 附截断 preview，`proxy-modes.ts` executeList），不进 system prompt；"因 prompt injection 完全不给模型"是与 Pi 基线的无据分歧，删除。Uina 注入纪律体现在**信任地位**（永不 trusted），不体现在可见性 |

## 3. 边界合规自检

- 新代码全部在 `.uina/extensions/mcp/` + `package.json` 依赖；Host 复用现有外部扩展 loader，不增加 MCP 专用装配。
- **不触碰** `src/agent`、`src/session`、`src/core`、`src/tools`、`src/runtime`。
- 扩展不 import UI 实现，只用公开 UI contract（信任确认走 `pi.ui.confirm/select`）；`pnpm check:boundaries` 必须通过。
- 工具通过 `pi.registerTool()` 注册，注册随 ActivationScope 生命周期，reload 不泄漏。
- 注意：`src/host/host.ts` 当前工作树有用户未提交修改，实施时只做增量装配，不动现有行。

## 4. 配置

### 全局目录规范（统一函数，防路径歧义）

Uina 现有代码约定（`src/ai/config.ts:118-122`、`src/cli/session-path.ts:40`）：**`UINA_HOME` 环境变量是用户主目录的测试替身，`.uina` 目录由代码追加**。本文档所有"全局文件"一律落在：

```ts
getGlobalUinaDir() = join(process.env.UINA_HOME ?? homedir(), ".uina")
```

- 配置：`join(getGlobalUinaDir(), "mcp.json")`（即默认 `~/.uina/mcp.json`）
- 信任记录：`join(getGlobalUinaDir(), "mcp-trust.json")`
- 工具目录缓存：`join(getGlobalUinaDir(), "mcp-catalog.json")`

严禁实现成 `join(UINA_HOME ?? homedir(), "mcp.json")`——那会把文件直接写进用户主目录根（`~`）。

### 发现层级（P0 两层架构，同名 server = **整个定义原子替换**，不做 deep merge）

1. **项目级配置（不受信任的输入，优先专有目录）**：
   - **首选路径**：`./.uina/mcp.json`（套入 `.uina/` 专有文件夹，收拢项目元数据，保持项目根目录整洁，与 `.uina/extensions/`、`.uina/worlds.json` 一致）；
   - **兼容回退**：若 `./.uina/mcp.json` 不存在，则回退检查根目录 `./.mcp.json`（兼容外部开源仓库的标准生态配置文件）；
   - **单项目权威性**：一次启动仅按上述顺序选定唯一一个存在的项目配置文件路径作为项目级配置源（`projectConfigPath`），两者不进行项目内交叉合并，杜绝跨文件配置撕裂；若两者皆不存在则项目级配置为空。
2. **全局级配置（受信任的输入）**：`getGlobalUinaDir()/mcp.json`——用户亲手写的，受信任。

deep merge 的危险反例（必须避免）：global 定义 `command=A, env={TOKEN: secret}`，project 写 `command=B`，合并结果变成 `command=B + global secret`——陌生仓库借走你的密钥。

### 发现时机与安装动线

- **配置按需重读与单次操作不可变快照（防 TOCTOU）**：
  - 每次代理工具操作（`list/search/describe/call/status`）执行入口**首先解析一次两层配置，生成当前操作的不可变快照**：`const snapshot = resolveMcpConfig()`。
  - 本次操作全链路（工具查找、信任检查、`ensureClient`、执行 dispatch）**从头到尾只使用该份不可变 snapshot**。
  - `server-manager` 显式接收 `ResolvedServerConfig + fingerprint`，自身不再读取磁盘配置。配置的修改在"下一次操作"入口统一生效，消灭同一次调用内的配置撕裂与 TOCTOU 竞争。
- **安装 = 往配置文件写一个条目**，没有 install action。写入者不限：用户手写，或模型经 workspace 写入工具编辑。模型写入的配置仍是项目级 = 不受信任输入，首次启动照样过 §4 信任门——discover ≠ trust ≠ execute 对"模型自己装 server"同样成立。
- 典型流程（以 tavily-mcp 为例）：写入 `{"tavily": {"url": "https://mcp.tavily.com/mcp/?tavilyApiKey=..."}}` → `mcp list(server="tavily")` → 用户确认信任 → 目录建立 → `search`/`call`。远程 HTTP 用静态 API key（非 OAuth）的 server 均为此形态；本地 stdio 同理（`npx -y tavily-mcp` + env）。

### 格式

```json
{
	"mcpServers": {
		"chrome-devtools": {
			"command": "npx",
			"args": ["-y", "chrome-devtools-mcp@1.6.0"],
			"env": { "FOO": "bar" },
			"inheritEnv": true
		},
		"remote-api": {
			"url": "https://example.com/mcp",
			"headers": { "Authorization": "Bearer xxx" },
			"httpTransport": "streamable-http"
		}
	},
	"idleTimeoutMs": 600000
}
```

- `mcpServers` 及其内部标准字段（command/args/env/url/headers）= 生态通用子集；只写标准键的文件可原样移植给其他宿主。
- `inheritEnv`（server 级可选，布尔值，**缺省默认为 `true`，对齐 Pi 基线**）：
  - `true`（默认）：直接继承宿主当前进程环境（`process.env`），并在此基础上叠加 `env` 显式声明的键。开箱即用，不因"也许会泄漏 API key"做人为环境隔离；
  - `false`：关闭全局继承，仅使用 SDK 平台最小默认环境变量集（PATH/HOME/SystemRoot 等），叠加 `env` 显式声明的键。
- **调优与超时配置消费合同（严格对齐 Pi 基线与 Uina 状态机适配）**：
  - `idleTimeoutMs`（默认 600000 即 10 分钟，**对齐 Pi 基线**）：作为无活动协议交互持续闲置的倒计时预算（见 §7）。
  - `callTimeoutMs`（可选，**默认不设置，完全交由 SDK 默认处理，对齐 Pi 基线**）：若用户未显式配置，Uina 不自行强加超时覆盖，直接交由 SDK 默认处理（SDK 默认 60s）；允许用户显式配置覆盖。一旦 dispatch 发出后超时，外部副作用未确认，状态严格记为 `unknown`。
  - `startupTimeoutMs`（可选，**默认不设置，对齐 Pi 基线**）：connect / 协议握手不设独立预算，与请求同走 SDK 默认 request timeout（SDK v2 默认 60s）；允许用户显式配置覆盖。若在 connect / 握手阶段超时，工具调用请求从未发出，状态明确记为 `not_started`。
  - **Catalog 默认 TTL 策略（对齐 Pi 基线：默认无时间老化，删除自设的 `catalogTtlMs`）**：Pi 源码明确标注 `maxAgeMs = 0`（0 means no age limit）。Uina 不自设默认时间老化，目录定位为持久咨询缓存（Advisory Persistent Cache）。仅当 server 在 `tools/list` 响应中显式返回 `_meta.ttlMs` 时记录 `expiresAt`，否则无时间老化，仅随配置指纹变更（`serverFingerprint` 不匹配）时失效。
  - `httpTransport`（可选，缺省默认为 `"auto"`）：
    - 缺省（`"auto"`）：优先尝试 `StreamableHTTPClientTransport`；若建连或协商发生传输层错误，**统一通过集中守门谓词 `isLegacyTransportCompatibilityError(error): boolean` 判定**。**仅当谓词返回 true（限 HTTP 404 端点不存在、HTTP 405 Method Not Allowed、或 Content-Type 不匹配）**时，使用**全新 Client** 平滑退避尝试 `SSEClientTransport`。**严禁对认证错误（401/403）、TLS 错误、连接超时（timeout）、网络不可达/DNS 失败或 5xx 远端故障做协议退避**（谓词严格返回 false），防止认证失败被误诊为协议不兼容。
    - `"streamable-http"`：强制 Streamable HTTP，绝不 fallback；
    - `"sse"`：强制传统 SSE，直接创建 `SSEClientTransport`。

- **解析失败与 Shadowing（严禁向低优先级静默降级）**：
  - **高优先级配置文件存在但解析失败（如 `./.mcp.json` JSON 语法错误）**：该层进入 `invalid` 状态。**绝对不允许向低优先级（全局配置）静默降级**（否则项目本想覆盖的敏感同名 server 会在瞬时语法错误时突然以全局配置复活，造成提权与误调用风险）。代理工具整体阻断并明确上报配置语法错误。
  - **高优先级配置声明了同名 server 但定义非法**：**依然产生 Shadowing（遮蔽）**——它继续覆盖低优先级同名 server，合并后的 server 状态为 `invalid`。
  - **核心纪律**：**配置错误应该导致能力不可用，而不是换一个同名能力继续执行。** 这与 Uina"不静默自欺"原则完全一致。单个非法 server 在 `status` 中如实显示 invalid 原因，调用时返回 `failed` 附配置错误说明，绝不 fallback 到全局同名 server。

### 项目信任（D12，机制采 Pi 简化版）

- **信任范围**：项目级 stdio server（可执行本机命令）和项目级远端 HTTP（首次连接以真实目标 origin 为身份）。
- **确认时机**：`list(server)` / `call` 即将真实启动该 server 之前。
- **确认方式**：有 UI 时走 `pi.ui.confirm`（展示 server 名、配置来源路径、脱敏后的 endpoint 描述）；确认后持久化，后续不再问。
- **信任记录**：`getGlobalUinaDir()/mcp-trust.json`，条目 `{ projectRoot, serverName, definitionHash, approvedAt }`；`definitionHash` = 定义规范化（键排序、去 undefined）后 sha256（Pi `hashProjectServerDefinition` 同法）；写文件用 temp + 原子 rename，权限 0600（Windows 无此步）。**同一指纹同时作为 catalog 的 `serverFingerprint`**（§7），配置/凭据变化 → 信任失效 → 旧目录同步作废。
  - **P0 保守安全设计（有意为之）**：`definitionHash` 同时绑定"信任身份"与"连接/catalog 凭据上下文"。当用户轮转 API key 或变更 env/headers 时，catalog 因鉴权上下文变更而失效重拉是完全合理的；但同时也会要求用户重新确认一次信任。这是 P0 有意采用的保守行为（避免初期引入 `trustFingerprint` 与 `serverFingerprint` 两套指纹的并发与状态机复杂度）。后续若真实使用中发现频繁 rotate key 造成确认扰民，再将二者解耦。
- **失效**：定义变了（哈希不匹配）→ 重新确认。
- **无 UI**：保持 blocked，`not_started` + 原因与解除方式。
- **敏感信息脱敏与 URL 净化（`sanitizeEndpointForDisplay`）**：
  - **Header / Env**：确认对话、`status`、错误信息永远不显示 Authorization header 值、env 值、token——但**必须显示 env/header 的键名**（如 `Authorization`、`NODE_OPTIONS`），否则用户只看到 `npx xxx` 不知道它还带着敏感环境。
  - **URL 内部秘密彻底脱敏**：生态中大量 HTTP MCP server 将 API key 放进 URL query（如 `https://mcp.tavily.com/mcp/?tavilyApiKey=...`）或 basic auth 中。统一通过 `sanitizeEndpointForDisplay(url)` 脱敏：
    - 屏蔽 `userinfo`（转为 `<redacted>@` 或 `user:<redacted>@`）；
    - 屏蔽所有 query parameter 的值（转为 `?key=<redacted>`）；
    - 屏蔽 fragment。
    - 示例：`https://mcp.tavily.com/mcp/?tavilyApiKey=SECRET` → `https://mcp.tavily.com/mcp/?tavilyApiKey=<redacted>`。
  - **全链路强制**：`status`、错误信息、trace、details、audit log 以及 `pi.ui.confirm` 信任弹窗**只能使用 sanitized URL**。原始 URL 仅限底层建立 HTTP transport 连接时内部使用，绝不外溢到展示层和日志。
- **HTTP 凭据与重定向保护（对齐 Pi 基线，不额外发明 trust protocol）**：
  - 若请求配置了敏感凭据（如包含 Authorization 等敏感 `headers`，或 URL 携带凭据）：**拒绝一切 HTTP 重定向（含 same-origin，`redirect: "error"`）**——任何 redirect 直接报错拒绝连接（对齐 Pi 对凭据请求的 fail-closed 行为：`server-manager.ts:308`、`mcp-auth-fetch.ts:50` "Credential-bearing redirects fail closed, including same-origin ones"）；
  - 若请求无敏感凭据：由 transport / SDK 正常处理重定向。
- P0 简化：projectRoot 用 realpath；不做 Pi 的 git worktree 共享审批（已知限制：同仓库 worktree 需分别确认，可接受）。

## 5. 模块切分（内部高内聚，不扩内核接缝）

```text
.uina/extensions/mcp/
	index.ts           activateMcp(services) —— 装配入口，返回 ExtensionActivation
	config.ts          两层配置发现、解析、原子合并、信任记录读写
	catalog.ts         咨询性目录快照（内存 + getGlobalUinaDir()/mcp-catalog.json）
	server-manager.ts  连接 supervisor：ensureClient / refreshCatalog / call / idle close / dispose
	proxy-tool.ts      mcp 代理工具定义（def + run + 输出预算）
```

## 6. `mcp` 代理工具规范

### schema（broker 走 ajv 结构校验，语义组合在 run 里校验）

```json
{
	"type": "object",
	"properties": {
		"action": { "type": "string", "enum": ["list", "search", "describe", "call", "status"] },
		"server": { "type": "string", "description": "list 时可选：定向发现该 server（缓存缺失/过期则启动并拉取目录）" },
		"query": { "type": "string", "description": "search 必填：关键词，匹配工具名或描述" },
		"tool": { "type": "string", "description": "describe/call 必填：工具全名 serverName.toolName" },
		"args": { "type": "object", "description": "call 时传入：工具参数对象（若工具无需入参可缺省，默认为 {}）" }
	},
	"required": ["action"],
	"additionalProperties": false
}
```

### 目录条目的统一状态判定（贯穿 list / search / describe / call）

任何操作在读取或消费 catalog 条目时，按以下顺序判定（先准入、再新鲜度）：

1. **准入检查**：`entry.serverName` 不在当前配置快照中（server 已被删除/改名）→ **unconfigured**（内部状态）。该条目对模型**不可见**：`search` 结果中过滤排除，`describe`/`call` 返回 `failed: server '<server>' 已从配置中移除`。**绝不进入"请用 list(server) 重新校准"分支**——指引模型去校准一个不存在的 server 是认知死锁。持久化时顺带清理 unconfigured 条目。
2. **指纹判定**：`entry.serverFingerprint !== snapshot.servers[entry.serverName]?.fingerprint`（配置/凭据变更）→ **stale [配置已变更]**。
3. **TTL 判定**：`entry.expiresAt !== undefined && Date.now() >= entry.expiresAt`（server 显式声明的 ttlMs 超期）→ **stale [已过期]**。
4. 否则 → **fresh**（指纹匹配且未超期，完全有效）。

**模型可见的状态名只有三个**：`fresh`（可用）、`stale`（需通过 `list(server)` 重新校准）、`missing`（未发现）。"配置指纹失配"与"TTL 超期"的内部区分只服务于诊断与日志——对模型而言两者的行动指引完全相同（缓存不可直接信任，先重新校准），暴露两个专业术语只增加认知负担。

### 行为与输出正文合同（含冷启动自举）

| action | 行为与输出正文契约 | 是否启动 server |
| --- | --- | --- |
| `list` | • **无 `server`**：**只看本地 catalog，不联网、不启动任何进程**；概览所有已配置 server 及目录新鲜度状态（按模型可见三态：`fresh (N tools)` / `stale (N tools)` / `missing (未发现)`；unconfigured 条目不展示）；末尾附指引：`可通过 list(server="<name>") 定向发现或重新校准工具`。<br>• **带 `server`**：**显式定向发现与重新校准（始终启动/复用连接并访问 server）**——信任检查 → ensureClient → `refreshCatalog`（拉取最新 tools/list 并原子更新本地 catalog）；更新完整 catalog 快照，并返回其有界展示（每行 `fullName: 一行简述`，受展示层预算约束）；若 server 提供 instructions，附**有界 preview**（明记为 untrusted server metadata，绝不进 system prompt，D14）；末尾附引导：`可通过 describe(tool="...") 查看参数，或通过 call(tool="...", args={...}) 执行`。使模型在怀疑能力变动时可直接重新校准，无需新增 refresh action。 | 后者是 |
| `search` | 大小写不敏感子串匹配目录（匹配 `fullName` / `title` / `description`）；**unconfigured 条目先过滤排除**；最多展示 12 条（对齐 Pi 默认 12 条/页，超限提示省略数）；匹配结果状态明确展示：两种 stale 统一标 `[stale: 配置已变更]` 或 `[stale: 已过期]`，并同样引导使用 `list(server)` 重新校准（原因后缀仅供诊断，行动指引与统一状态判定一致）；**0 命中时返回明确提示：`未检索到匹配 "{query}" 的工具。可通过 list 查看已配置的 server 或通过 list(server="<name>") 发现更多工具。`，绝不返回空字符串**。 | 否 |
| `describe` | 在当前 catalog 中精确匹配 `tool`：<br>• 所属 server 不在当前配置中 → `failed: server '<server>' 已从配置中移除`；<br>• 命中且 stale → 返回元数据并标注 `[stale: 配置已变更，请通过 list(server="<server>") 重新校准]` 或 `[stale: 已过期]`；<br>• 命中且 fresh → 返回单工具完整描述 + `inputSchema`（格式化 JSON）+ `outputSchema`（若存在）+ annotations（明记为 server 自报、未经验证）；<br>• 目录中不存在 → `failed: 工具 '<tool>' 未在目录中，请先通过 list(server) 发现或 search 检索`。 | 否 |
| `call` | **完整调用序列（外层拦截 + 内层调度）**：<br>① **外层 broker pipeline（进入 proxy.run 前）**：自动触发 `tools.beforeCall` hook，从 `name="mcp"` 与 `args.tool` 推导 `actionIdentity = mcp:<server>.<tool>` 做**名字级权限拦截**，被拦截则直接返回 `not_started`（此层只有 `{name, args}` 可用，注解不参与，见 D11）；<br>② **内层 proxy.run（D6 严格精确匹配，不猜、不 split）**：单次操作快照 → **首先在当前 catalog 中精确匹配 `fullName`**，然后按 §6 统一状态判定分派：<br>　• **catalog 中无此 entry**：直接返回 `failed: 工具尚未发现或未在目录中，请先通过 list(server) 发现或 search 检索`（**call 绝不负责从零冷发现未知工具，冷发现统一走 list(server)**）；<br>　• **unconfigured**（条目所属 server 已不在配置中）：`failed: server '<server>' 已从配置中移除`，**绝不进入重新校准分支**；<br>　• **stale**（指纹失配或 TTL 超期，两者同一处理路径）：从条目三元组取得 `serverName` → 项目信任检查（未通过则 blocked）→ `ensureClient(当前快照配置)` → `refreshCatalog`（拉取最新 tools/list）→ **在刷新后的权威 catalog 中再次精确匹配 `fullName`**（server 已不提供该工具 → `failed: 工具已失效`）→ SDK `client.callTool`（注入 `callTimeoutMs` 预算）；<br>　• **fresh**（指纹匹配且未超期）：从条目三元组直接取得 `serverName` 与真实 `toolName` → 项目信任检查 → `ensureClient` → SDK `client.callTool`；<br>③ **前置校准断路铁律**：stale 路径中若 `refreshCatalog` 失败（网络抖动、server 挂掉等），本次调用**立即** `failed: 目录重新校准失败: <error>` 终止并如实回报——**绝不回退用旧缓存条目盲目 dispatch**（catalog 数据本身保留，见 §7 刷新纪律，但本次调用不许带病继续）。<br>④ **结果投影（不自建 Schema 校验）**：Uina 只校验 `args` 为合法 Object，不跑本地 inputSchema 校验（Server 是唯一权威合同执行者）；接收 Server 返回结果并保真降级投影（含 `details.effects` 权限身份）。普通业务执行失败（`isError:true` / 403 / 文件不存在等）仅如实映射为 `failed`，绝不污染 catalog freshness；仅当 server 明确报错能力不存在（如 Method not found / unknown tool）或收到 `list_changed` 时才标记该 server 为 stale。 | 是（若命中未启动 server 或触发前置校准） |
| `status` | 每个 server 一组详情：配置来源（project/global）、信任状态（trusted/blocked/invalid）、目录新鲜度（模型可见三态：fresh / stale / missing）、连接状态（running [inFlight] / starting / stopped / draining / failed 原因）、脱敏端点（`sanitizeEndpointForDisplay`）。 | 否 |

认知动线闭环：**有哪些 MCP？→ list；看看 parallel 有什么？→ list(server)；找搜索工具？→ search；怎么用？→ describe；执行 → call。** 仍是单个工具、无新 action。

### 输入校验哲学（沿用既有纪律）

- 结构校验失败 → broker 返回 `not_started`。
- 语义组合非法（如 `call` 缺 `tool`、`search` 缺 `query`）→ `failed` + 可用值列表，**不得静默假成功**。
- `call` 的工具全名不在目录（或 refresh 后已删除）→ `failed` + 相近候选（前缀/关键词匹配），**不自动猜测 serverName 做冷发现**。
- 目录未缓存时 `search/describe` 如实报"未缓存，用 list(server) 发现"，不自欺。
- **零入参工具容错与 Server 权威合同**：
  - 对无参数工具，`args` 缺省时默认自动兜底为 `{}`：`const toolArgs = (args.args as Record<string, unknown> | undefined) ?? {};`，避免模型因省略空参数对象多跑一轮失败重试。
  - 若提供了 `args`，则必须是合法对象（`typeof toolArgs === "object" && toolArgs !== null && !Array.isArray(toolArgs)`），非法类型报 `failed: args 必须是对象`。
  - **P0 坚决不自建本地 inputSchema 校验器**：Server 是参数与 Schema 合同的唯一权威执行者。防止由于 JSON Schema 方言差异、自定义关键字或扩展特性造成"Server 支持但被 Uina 提前误杀"。参数合法性由 Server 判定并通过 `isError: true` / 错误响应返回，Uina 如实映射为 `failed`。

### Output Guard（D13，数值对齐 pi-mcp-adapter 基线；计量窗口 P0 暂按 activation，待 P1 切 per-session）

输出保护对齐 Pi 的 Output Guard 边界（`mcp-output-guard.ts`），保护模型上下文与会话日志，**不为 MCP 自行发明额外的超细防御预算矩阵**（删去 500 工具、16KB 元数据、256KB schema、4MB 目录等未对齐 Pi 的人为硬限制）：

| 维度 | 规格 | 超限行为 |
| --- | --- | --- |
| call 文本输出 | 50 KiB / 2000 行 | 截断尾部，并将完整文本落临时文件；在正文末尾附 `[Output truncated. Full output saved to <fullOutputPath>]`（对齐 Pi 行为） |
| details 原始 MCP result | 16 KiB | 超限换为摘要并落盘临时文件（Pi `boundMcpResult` 模式） |
| 二进制资源（binary resource） | 10 MiB / 单文件；100 MiB / 计量窗口累计；10,000 files / 计量窗口临时文件（**数值对齐 Pi；计量窗口 P0 暂按 activation**——扩展层尚无 session 生命周期接缝，P1 切 per-session） | 单个资源超限或二进制资源落临时文件，正文保留类型/大小占位与 URI 提示；累计配额超出时**拒绝该次资源写入并明确报错**（如 `二进制资源累计配额已用尽，可通过 reload 重置（P1 起随 session 重置）`）——是本次写入被拒，不是工具或 server 被永久封锁 |
| 图片（image content） | 直接通过（不增设 MCP 专属硬限） | 原样直传投影进 Uina 的 `images[]`（遵循 Uina 原生 `ImageContent` 合同，与 Pi 一致） |

- **临时文件生命周期（防孤儿文件堆积）**：MCP 扩展在激活时于系统临时目录创建专属子目录 `join(tmpdir(), "uina-mcp-" + process.pid + "-" + activationSeq)`（activationSeq 防同进程多次 reload 碰撞）；所有截断落盘文件（`fullOutputPath`、details 摘要、二进制资源）集中在此目录下；扩展 `dispose()`（停机或 reload）时执行 `rmSync(dir, { recursive: true, force: true })` 整目录回收，不在操作系统临时目录里积压孤儿文件。
- **权威 Catalog 与展示层保护**：
  - **权威 Catalog 完整登记**：Server 声明多少工具，权威 catalog 就完整登记多少个工具的三元组身份，保证能力集合无遗漏；
  - **展示层有界保护**：`list` 概览为摘要行，`search` 默认最多展示 12 条（对齐 Pi 12 条/页，超限提示省略数），保护模型上下文窗口。
- **保护边界声明（Post-decode 保护）**：上述文本、details 与二进制落盘约束均在 SDK 反序列化后执行，保护模型上下文与 Session Journal 磁盘写入，不作为底层网络流式 anti-DoS 屏障（准入安全由 D12 项目信任门守护）。

### 描述文案约束

`def.function.description` 控制在 \~200 token：五个 action 用法、`serverName.toolName` 命名、"先 search 再 call"。写长等于白做。

## 7. 连接生命周期

### ensureClient(server) —— 扩展的唯一连接入口

```
ensureClient(server)
→ 信任检查（§4，未通过 → blocked，不启动）
→ 状态机：stopped → starting → running
→ SDK 建立 transport + Client，完成协议协商（握手细节、能力发现、版本兼容全部归 SDK）
→ 就绪后按需 refreshCatalog
```

Client 创建时**必须显式设置**（D10）：

```ts
new Client(
  { name: "uina-mcp", version: UINA_VERSION },
  {
    versionNegotiation: { mode: "auto" },   // 优先探测现代 era（获取 ttlMs/cacheScope hints 与现代 subscriptions），并自动 fallback 到 legacy
    listChanged: { tools: { onChanged: (err, tools) => ... } }, // SDK 统一抽象 legacy notification 与 modern subscription
    // capabilities: 只声明我们实际处理的；不声明的 capability 由 SDK 自动拒绝
  },
)
```

**扩展不定义也不复刻 MCP 协议生命周期**（initialize/initialized/session 之类的知识一律不进 Uina 代码）；协议演进由 SDK 版本升级吸收。`versionNegotiation: auto` 是选择 SDK 的兼容策略，不是复刻协议知识。

#### Transport 适配（stdio / streamable-http / sse）

- **stdio transport**：使用 `@modelcontextprotocol/client/stdio` 的 `StdioClientTransport`。Windows 下若 command 为 `npx` / `uvx` / `pnpm` 且无后缀，自动映射为 `.cmd`（防 ENOENT）。
- **HTTP transport（遵循 §4 配置合同）**：
  - 缺省（`httpTransport` absent / `"auto"`）：优先尝试 `StreamableHTTPClientTransport`；若建连或握手失败，**统一经由集中守门谓词 `isLegacyTransportCompatibilityError(error): boolean` 判定**，禁止在业务路径上随意 catch 或编写散落的字符串包含匹配：
    - **合法 Fallback 触发条件（谓词返回 true）**：
      - HTTP 404（端点不支持 Streamable HTTP 路径）；
      - HTTP 405 Method Not Allowed（端点只接受 GET/SSE，不接受 POST）；
      - Content-Type 明确不匹配（如端点返回 `text/event-stream` 却要求 Streamable JSON）。
      满足时，废弃当前实例，使用**全新 Client** 平滑退避尝试 `SSEClientTransport`。
    - **严禁 Fallback 的错误类型（谓词返回 false，立即阻断并如实上报失败）**：
      - 401 Unauthorized / 403 Forbidden 认证与权限错误；
      - TLS / SSL / 证书校验错误；
      - 连接超时、请求超时（timeout）、DNS 解析失败、网络不可达；
      - 5xx 远端服务内部故障。
  - `"streamable-http"`：强制 Streamable HTTP，绝不 fallback。
  - `"sse"`：强制传统 SSE，直接启动 `SSEClientTransport`。

#### stdio 子进程环境与生命周期（对齐 Pi 基线 + SDK 所有权）

- **环境变量继承（对齐 Pi 基线）**：
  - 默认 `inheritEnv: true`：直接继承宿主当前进程环境（`process.env`），并叠加 server 配置中 `env` 显式声明的键。与 Pi 默认行为完全一致，保证绝大多数依赖环境的 node/python/cli 工具开箱即用，不因"也许会泄漏 API key"而做人为环境隔离；
  - 显式 `inheritEnv: false`：关闭全局继承，采用 SDK 平台最小默认环境变量集（PATH/HOME/SystemRoot 等运行必需项），仅叠加 server 配置中显式声明的 `env`。
- 远端 HTTP 的 `headers` 只用于该 transport，不进入子进程环境。
- **stdio 子进程生命周期归 SDK**：stdio 直接子进程的生命周期完全由锁死版本的官方 SDK 管理（Uina 仅调用其公开的 `close()` 与 abort 信号）。Uina 不复刻底层进程退出序列，严禁在架构设计中替 SDK 背书内部退出信号（如不同平台/版本的关闭流或信号组合），严禁侵入 SDK 私有属性违背 D10。
- **Windows 实测加固与 Fallback（`killTree`）**：在 Windows 平台真实进程测试中，若证明如 `npx.cmd` 拉起的多级孙进程（如 `node.exe` 或外部浏览器）在 SDK close 后确实发生残留滞留，且能通过已有合法接缝（如 process-tracker 或已有公开句柄）安全获得 PID 时，才启用 Uina 的 `killTree(pid)` 进行整树清理兜底。不为了理论上的泄漏自制第二套 stdio process ownership。

### 状态机与连接失效（指纹绑定 + 防 poisoned Promise）

- 三态：`stopped` / `starting` / `running`
- **运行态连接与启动 Promise 必须绑定 `serverFingerprint`**：
  ```ts
  type ServerConnection = {
    serverFingerprint: string;
    client: Client;
    transport: Transport;
    childPid?: number; // 仅当 Windows 实测需要且有合法公开接缝获取时记录
    inFlight: number;  // 该连接上所有未完成协议交互的计数（见下）
    idleTimer?: NodeJS.Timeout;
  };
  ```
- **inFlight 的权威所有权 = 该连接上所有未完成的协议交互请求**：不只 `callTool`——**`refreshCatalog`（`client.listTools()`）同样先取 ticket（`++` / finally `--`）**。只要连接上还有任何协议交互在途（业务调用或目录刷新），idle 停止与 draining 关闭序列都**不得**关闭该连接。否则会出现：旧连接上唯一在途的是一次 `listTools()`、业务调用计数为 0，draining 监视器误判"已无任务"当场 `client.close()`，把正在进行的目录刷新拦腰掐断。
- **热重读配置后的连接失效与优雅下线纪律（draining 保护 in-flight）**：
  `server-manager` 的 `ensureClient(serverName, serverConfig, fingerprint)` 显式接收来自单次操作不可变快照的配置与指纹，内部不自行读磁盘：
  1. **已有 running client**：
     - 若 `connection.serverFingerprint === fingerprint`：复用。
     - 若 `connection.serverFingerprint !== fingerprint`（用户修改了 URL/env/command/args 等）：
       **旧连接转为 draining，绝不粗暴直接 kill 已发出的调用**：
       - 旧连接从活跃连接表中解绑，标记为 `draining`，**不再接收任何新调用**；
       - 旧连接上正在进行的调用与目录刷新继续在其已有连接上跑完自然结算；
       - 当旧连接的 `inFlight === 0` 时，执行连接安全关闭（见下文关闭序列）；
       - 活跃连接表立即基于新指纹建立新连接（或进入 starting），新调用立即使用新配置。
  2. **已有 startingPromise**：
     - 若 `startingPromise.serverFingerprint === fingerprint`：并发 `call` 共享该 Promise。
     - 若 `startingPromise.serverFingerprint !== fingerprint`（启动过程中配置突变）：
       旧 Promise 废弃，其结算结果在 settle 后若无 in-flight 则直接关闭丢弃，绝不能成为新配置的 running client；立即以新指纹创建新的 `startingPromise`。
- **Promise 结算（成功或失败）后必须清掉**；失败回到 `stopped`——下次调用重新尝试启动，不做永久 poison（与"探活失败仅标记离线"同一纪律）。

### idle 停止（防杀 in-flight）

- 每个活跃 server 维护 `inFlight` 计数（所有权见上：call 与 refreshCatalog 都计入）：进入 `++`，finally `--`。
- **只有** `inFlight == 0` **且持续满** `idleTimeoutMs`（默认 10 分钟）才关闭。
- idle 的定义是"无活动协议交互持续 N 分钟"，不是"距最后一次调用开始 N 分钟"——15 分钟的合法长调用不能被第 10 分钟杀掉（对齐 Pi `isIdle`：`inFlight > 0 → false`，`touch` 在调用起止各一次）。
- 停止不清目录：`search/describe` 依旧可用，下次 `call` 重启（参考实现实测小 server 重启 0.1–0.3s）。

### 目录刷新（三条路径，原子替换）

1. **定向发现与重新校准**：显式执行 `list(server)` 时（始终启动/复用连接并访问 server 拉取最新 tools/list，原子更新本地 catalog）
2. **能力失配时修复**：调用前若 catalog 已标记为 stale 则前置刷新（失败即断路，见 §6 call ③）；或调用时 server 明确报能力不存在（如 Method not found / unknown tool）时置为 stale 并刷新
3. **连接期间主动通知**：订阅 `tools/list_changed`（SDK `ClientOptions.listChanged`，capability 存在才启用——Pi `server-manager.ts:1438` 同法）；收到通知 → refreshCatalog

refreshCatalog 实现纪律：

- **SDK 跨页聚合（不做手写循环）**：直接调用 `const result = await client.listTools()`。MCP TypeScript SDK v2 在不带 cursor 时会自动拉取所有分页（内置 64 页 `listMaxPages` 防护），扩展不手写分页循环，协议分页归 SDK。
- **并发去重（refreshPromise）**：同一 `(serverName, serverFingerprint)` 在进行中的刷新共享同一个 `refreshPromise`，避免连续收到 `tools/list_changed` 通知或并发调用时重复向同一 server 频繁打 `listTools()`。
- **权威连接与代际一致性检查（Authoritative Connection Guard）**：
  在拉取结果返回、准备提交落盘与内存替换**之前**，必须校验：
  `!this.disposed && this.connections.get(serverName) === connection && connection.serverFingerprint === currentFingerprint`
  - 若扩展已被 dispose：刷新整体中止，禁止产生新的持久化磁盘写。
  - 若连接已被移出活跃表（进入 draining）：其刷新结果**一律丢弃**，绝对不覆盖由新指纹连接生成的新 catalog！
  - **调用方结算契约（Caller Settlement，严禁跨代跳跃重试）**：
    - **核心铁律**：一次代理操作从头到尾只使用入口处生成的不可变快照，**绝不在操作中途从 snapshot A 跳到 snapshot B**，且严格遵循 D7 不做自动重试。
    - 若刷新是由后台 `tools/list_changed` 触发：Guard 拦截后直接静默丢弃；
    - 若刷新是由前台等待的主动请求触发（如 `list(server)` 或 stale `call` 前置刷新）：判定为 `superseded`，**绝不自动跳到新配置连接重试**：
      - 对 `list(server)`：若在旧连接上已成功拉取到 `tools/list`，可将该结果作为本次有界展示返回给模型，但不 commit 到全局持久 catalog；若拉取中途被中止，则返回 `failed: MCP 配置在操作执行期间已变更，请重新发起发现`；
      - 对 `call`：直接返回 `failed: MCP server 配置在调用期间已变更，请重新发起调用`，绝不跨代自动向新 server dispatch。
- **原子替换与完整快照（Complete Tool-set Snapshot）**：校验通过后 → 构建完整快照（Server 声明多少工具即登记多少，不自设人为硬上限）→ temp 文件 + 原子 rename → 内存 swap；**持久化时顺带清理 unconfigured 条目**（§6 统一状态判定第 1 条）；中途失败保留旧目录并标记 stale，绝不出现半个目录。注意：此处"保留旧目录"指 catalog 数据不丢，**不等于**本次调用可以带着旧条目继续 dispatch——前置刷新失败的调用按 §6 call ③ 断路。
- **绑定 server fingerprint 与 cacheScope**：catalog 条目结构为
  ```ts
  {
    serverName,
    serverFingerprint,   // = §4 definitionHash（规范化定义 sha256），配置/凭据变化即变
    stale?: true,        // 能力失配后保留旧快照，下一次调用先重新校准
    cacheScope: "public" | "private" | undefined,  // 来自 tools/list 的 _meta.cacheScope
    fetchedAt,
    expiresAt?: number,  // 仅当 tools/list 显式返回 _meta.ttlMs 时记录（fetchedAt + ttlMs）；缺省为 undefined（默认无时间老化，对齐 Pi maxAgeMs = 0）
    tools
  }
  ```
- **`cacheScope: "private"`**：明确不得跨 authorization context 复用——指纹即绑定当前凭据上下文，凭据变化导致指纹变化，自然失效。
- 过期不删除，标记 stale 仍可发现（unconfigured 条目除外，持久化时清理）。

### 连接关闭序列与 teardown（严格禁止 post-teardown 状态落盘）

**统一连接关闭序列（idle stop / draining settle / teardown 共享）**：
1. **Streamable HTTP**：优先发出会话终止通知 `await (transport as StreamableHTTPClientTransport).terminateSession?.().catch(() => {})`（best-effort 通知远端释放 server-side session；若 server 无 session id 则为 no-op；失败不改变原工具执行结果，仅作 reportError 调试记录），随后 `await client.close()`；
2. **stdio / SSE**：直接 `await client.close()`（stdio 由 SDK 管理直接子进程退出）；
3. **Windows stdio 兜底**：若在实测中证明存在孤儿孙进程泄漏，且已安全追踪到子进程 PID，才执行 `killTree(childPid)` 进行整树清理。

activation dispose（reload/退出）：
- **状态封锁**：置 `this.disposed = true`。所有异步任务（建连、refreshCatalog、通知回调）在最终 commit 前必须检查 `if (this.disposed) return;`，禁止在扩展卸载后向磁盘写回 catalog 或修改状态。
- **资源清理**：对全部活跃连接（含 draining 连接）执行上述关闭序列、清空 timer 与 refreshPromise、未完成调用收到 abort（结果记 `unknown`，不得改成 `cancelled`——外部副作用未知）。`exec-command` 的 `AbortSignal.any` 组合范式可直接参考。
- **临时文件回收**：递归删除本 activation 的专属临时目录（§6 Output Guard，`rmSync(dir, { recursive: true, force: true })`），不向操作系统临时目录遗留孤儿文件。

## 8. 结果语义

### 8.1 状态映射（五态全部有定义）

| MCP/SDK 侧情况 | ToolResultStatus | 说明 |
| --- | --- | --- |
| callTool 正常返回且 `isError` false/absent | `succeeded` | |
| **callTool 返回且 `isError:true`** | **`failed`** | MCP 规范：表示 tool call ended in an error；放进 JSON-RPC result 是为了让模型看到并自行修正，不等于"调用成功"。错误正文完整提供（D8） |
| MCP 协议错误响应 / 工具执行抛错 | `failed` | 附 server 返回的错误信息 |
| 参数组合非法 / 工具名不存在 / 目录未缓存 | `failed` | 附可用值/候选 |
| 项目 server 未获信任 | `not_started` | 附原因与解除方式 |
| server 启动/建连失败（建连阶段超时，无论 SDK 默认或显式 `startupTimeoutMs`） | `not_started` | 请求从未发出；附启动错误详情或超时说明 |
| **取消发生在 tools/call 发出之前**（启动中/排队中被 interrupt） | **`cancelled`** | 请求从未离开本机，取消是可确认事实 |
| tools/call 已发出后被取消 / 超时（`callTimeoutMs` 超时） / 连接中断结果未回 | `unknown` | 副作用未确认，不得推断成败 |
| 结构校验失败 / 工具未注册 | `not_started` | broker 兜底 |

实现注意：broker 对"run 内抛错且 signal.aborted"自动记 `unknown`（`broker.ts` executeToolCore），对"run 前已 abort"记 `not_started`；扩展自己负责的分界是——**dispatch 前检查 signal，abort 则显式返回 `cancelled`；dispatch 后让 SDK 的 abort 异常自然抛出**，交给 broker 归为 `unknown`。不得吞 abort。

`details` 必含 `{ server, tool, transport }` 与 `effects: [{ effectType: "mcp.call", externalOperationId: "server.tool", label }]`（权限/审计身份，D11）。

### 8.2 CallToolResult 投影（P0 合同，不是风险项）

| MCP content | Uina 投影 |
| --- | --- |
| `text` | `result` 字符串（多块拼接） |
| `image`（mime ∈ png/jpeg/gif/webp） | `images[]`（Uina `ImageContent` 合同，base64 直传） |
| `image`（其他 mime，如 svg） | 文本占位 + `details`（不伪装成支持的图片） |
| `audio` | 文本占位（"[音频 N 字节]"）+ `details`（Uina 无音频内容合同，不假装支持） |
| `embedded resource` | 文本可读的投影为文本；二进制的给类型/大小占位 + `details` |
| `resource_link`（MCP 2026-07-28） | 文本：`Resource link: <name> (<uri>)`（附可选 mimeType/description）+ `details.resourceLinks[]` 保留结构化对象 |
| `structuredContent` | `details.structuredContent`（受 details 字节预算约束） |
| 空结果 | `"(empty result)"` 文本（Pi 同款） |

没有这张表，"支持 MCP tools" 实际只是"支持返回字符串的 MCP tools"；补充 `resource_link` 覆盖了 2026-07-28 正式结果类型（Uina 不声明 resources capability，不在此做自动读取，如实向模型暴露这是外部资源链接即可）。

## 9. 不可信数据纪律与注解消费

以下数据属于 **external/untrusted** 输入，**严禁进入 system prompt 或 trusted context**（防止 prompt injection 攻击）：
- server instructions（D14：可作 untrusted metadata 有界展示给模型，绝不进 system prompt / trusted context）；
- 工具 description / title / inputSchema 里的 description；
- 工具执行结果正文。

恶意 server 可以在 description 里投放注入指令——给模型看是使用的前提，但绝不能赋予系统级信任地位。

**Server 注解（annotations）消费纪律（诚实切分，不虚构接缝能力）**：
- `tools.beforeCall` 发生在进入 MCP 扩展之前，钩子只能看到 `{ name: "mcp", args }`（`src/tools/pipeline.ts:8-15`），**结构上拿不到 server 注解**。外层拦截是且仅是名字级粗粒度权限拦截（基于 `name` + `args.tool` 推导 `mcp:<server>.<tool>`）；
- server 声明的 `readOnlyHint`、`destructiveHint` 等 annotations **在执行完成后**透传记录到 `details.annotations` 中，作为审计与后续策略演化的元数据；
- **P0 不存在**基于注解的事前审批引擎，MCP 扩展内部也绝不自造第二套审批系统。（Pi 的 `approveTools: "destructive"` 能工作，是因为 Pi 按工具注册真实工具、注册时 def 自带 annotations——代理工具架构下事前不可得，如实承认这一架构差异，不假装对齐。）

## 10. 外部扩展装载

MCP 放在 `.uina/extensions/mcp/`，由现有项目扩展 loader 按目录自动发现；Host 不 import MCP，也不增加 `mcpTools` 专用开关。

- 扩展通过公开 `ExtensionAPI` 注册单个 `mcp` 工具，并由扩展 scope 持有连接、目录和临时文件的 teardown。
- 每次操作以不可变快照读取全局目录与 cwd（见 §4 发现时机），新增 server 无需 reload；解析失败 `reportError` 不炸启动。

## 11. 依赖变更

```diff
+ "@modelcontextprotocol/client": "2.x.y"  // 锁死具体测试验证过的补丁版本（如 2.1.1），禁止 "^" 或 "2.x" 浮动
```

- **确切版本锁定（D1）**：`package.json` 必须写死确切版本（如 `2.x.y`），禁止浮动版本。原因：Uina 深度依赖 v2 特定补丁行为（如无参 `client.listTools()` 自动跨页与 cursor 修复、`versionNegotiation: auto` 模式下的版本握手与 `_meta.ttlMs/cacheScope` 传递）。协议基础设施的可复现与行为确定性优先于自动引入未知更新。升级必须显式升级版本并全量跑通协议测试。
- **不直接依赖 `@modelcontextprotocol/core`**：client 使用者不需要（Pi 侧仅 ui-server/oauth——两个我们不做的功能——直接用 core）。
- 不加：keyring、quickjs、undici、cross-spawn、toml 解析（配置是 JSON）。

## 12. 测试计划

### 约定（遵循 dev/DECISIONS.md）

- vitest **默认池**；测试用临时目录/内存，不碰 `data/session.jsonl`；信任记录测试用临时 `UINA_HOME`（注意其语义是主目录替身，期望路径含 `.uina/` 段，见 §4）。
- CRAP 门不含 `extensions/`：改动后另跑 `--files=extensions/` 覆盖率。

### 单元

- config：两层发现、**单次操作不可变快照（防 TOCTOU）**、按需重读（下一次操作可见新 server）、**同名原子替换（验证无 deep merge）**、**`inheritEnv` 默认全继承与显式设 false 平台最小默认环境**、**非法层阻断（不向全局静默降级）**、**非法 server 产生 shadowing 阻断**、**信任记录读写与哈希失效**、**URL 敏感信息脱敏（`sanitizeEndpointForDisplay` 覆盖 query/userinfo）**、**敏感凭据拒绝一切重定向（含 same-origin）**
- catalog：回填、**统一状态判定顺序（准入检查先行：server 已删除 → unconfigured 过滤/清理，绝不给出"重新校准"指引；指纹失配与 TTL 超期 → stale；模型可见仅 fresh/stale/missing 三态）**、**完整登记工具集身份（不存残缺快照）**、**并发去重（`refreshPromise`）**、**权威连接防护（draining 连接与已 dispose 连接的刷新结果坚决丢弃，不写盘）**、**原子替换（中断保留旧目录）**、缓存 miss 如实报告、**同名冲突报错**
- proxy-tool：六种调用形态（含 `list(server)` 冷发现）、**stale 条目前置校准全路径（指纹失配与 TTL 超期同一路径：refresh 后重新 exact resolve 再 dispatch）**、**unconfigured 条目调 call 返回 `failed: server 已从配置中移除`（死锁回归测试）**、**前置 refreshCatalog 失败 → 调用立即 `failed: 目录重新校准失败`（绝不带旧缓存 dispatch）**、**零入参工具调用容错（args 缺省自动兜底为 `{}`）**、**search 检索最多展示 12 条（对齐 Pi）且 0 命中时返回清晰指引（不返回空串）**、**describe 完整展示（含 inputSchema/outputSchema/annotations 与 stale 提示）**、**outer beforeCall 名字级拦截与调用时序验证（broker 拦截直接返回 not_started，不触发 proxy.run）**、**stale 刷新后重新匹配与校验（工具被删除时报 failed 且不 dispatch）**、**CallToolResult 保真降级投影（覆盖 text/image/resource_link/structuredContent 等）**、语义组合校验（failed + 可用值）、候选推荐、**Output Guard 边界落盘（文本 50 KiB / 2000 行截断附 path、details 16 KiB 摘要落盘、binary 10 MiB / 单文件、计量窗口（P0 暂按 activation）累计 100 MiB / 10,000 files 限制与超限明确报错、图片直传 images）**、**临时文件集中落在专属子目录且 dispose 时整目录回收**
- server-manager：idle（**in-flight 时不触发**，注入假时钟；**refreshCatalog 在途同样阻止 idle 关闭与 draining 关闭**）、**`isLegacyTransportCompatibilityError` 集中守门谓词单元测试（严格验证 404/405/Content-Type 触发 fallback，401/403/TLS/timeout/5xx 坚决阻断）**、**startupTimeoutMs 与 callTimeoutMs 超时严格映射（建连超时 not_started、调用超时 unknown）**、**配置变更后旧连接转入 draining 状态（不 kill 已有 in-flight——含在途 listTools——等待其结算并在 inFlight===0 时关闭）**、新连接基于新指纹即时建立、**startingPromise 指纹绑定与切换**、并发启动去重、**startingPromise 失败后可重试**、teardown 清理（`disposed` 标志与禁止异步 commit、临时目录回收）、**refreshCatalog 丢弃时的调用方结算（superseded 严禁跨代跳跃，返回 failed 告知配置已变）**、**Streamable HTTP 优雅会话终止（terminateSession best-effort 调用）**、**Windows 下 stdio 进程退出与 killTree 实测加固**

### 协议（in-process，官方测试范式）

- SDK in-memory transport 挂内存 server fixture：`list`/`call`/isError/慢响应/`list_changed` 通知/SDK 跨页自动聚合，全走真实 Client 代码路径。

### 真实进程（P0 完成的必要条件）

- stdio fixture：最小 node 脚本 MCP server，真实 spawn、ensureClient、调用、idle 停止、**项目信任确认全流程（临时项目目录 + 临时 UINA_HOME）**。
- **Windows 必须真实跑通**（本机是主要平台）：`npx`/`uvx` 在 Windows 是 `.cmd`，spawn 不走 shell 时需解析到 `npx.cmd` 或要求用户写全名——P0 用最简处理（known-command 映射到 `.cmd`）；验证子进程在 idle/teardown 时的退出表现；若实测发现多级孙进程残留，验证通过合法接缝获得的 PID 触发 `killTree` 清理。

## 13. 交付切分

| 阶段 | 内容 |
| --- | --- |
| **P0** | 外部扩展核心可运行能力：config + 项目信任门、advisory catalog 持久快照、lazy ensureClient + in-flight idle（含目录刷新在途）、单代理工具（冷发现 + describe + call 三元组精确路由 + stale 前置校准断路）、结果五态 + loss-aware 降级投影、teardown（含临时目录回收）、测试三层 |
| P1（候选，非承诺） | 启动失败退避、per-server 超时/覆盖、git worktree 共享审批、stale 后台自动预热、**二进制累计与临时文件随 Uina session 计量与回收（待扩展层 session 生命周期接缝）** |
| 需求出现再议 | OAuth、elicitation、结果 schema 校验、instructions 显式查看命令 |

## 14. 未验证项与风险

1. `@modelcontextprotocol/client` 2.0.0 的导出面与关键行为常量已在当前依赖和类型检查中验证；startup/call 默认超时仍依赖 SDK 默认 request timeout
2. Windows 下 stdio + `npx.cmd` 已用本地 fixture 真实跑通；`uvx` 与多级孙进程滞留仍未有现场证据（优先依赖 SDK close，实测若有残留再以公开 PID 接缝启用 `killTree` 加固）
3. `StreamableHTTPClientTransport` 对自签/内网证书的行为（不引入 http-ca，出现需求再说）
4. 传统老旧 HTTP server 的真实 SSE fallback 端点仍未现场连接；代码和兼容错误谓词已覆盖 404/405/Content-Type 退避，401/403/TLS/timeout 不退避
5. `pi.ui.confirm` 在非交互模式下的行为：当前扩展在无 UI 时明确返回 `not_started`；真实有 UI 的项目 stdio 信任确认已覆盖
6. MCP v2 线协议演进（initialize/会话变动）：本设计已通过 D10 规避——扩展不持协议知识，但需在实现时确认 SDK 版本的行为

## 15. 参考实现对照

| 继承的设计 | pi-mcp-adapter 位置 |
| --- | --- |
| 代理工具表面（search/describe/call/status 经 `mcp` 单工具） | `direct-tool-surface.ts`（`buildProxyDescription`）、`proxy-modes.ts`（executeCall/executeDescribe/executeSearch/executeList）。注意：Pi 的**主**表面是按 server/tool 注册真实 direct tools（`direct-tools.ts`），`mcp` 代理是管理/安装/auth/兜底调用通道；Uina 因上下文投影纪律反转为 proxy-only，D2 据此成立 |
| isError → 错误处理 | `host-managed.ts:488-490` |
| lazy 启动 + 闲置停止 + per-server idle 配置 | `lifecycle.ts:34-35, 412-414`；idle 判定 `server-manager.ts isIdle()` |
| 目录缓存（离线可发现，默认无时间老化，消费 server ttlMs） | `metadata-cache.ts` |
| stdio/http transport 用法（client-only） | `server-manager.ts:1112-1189, 1428-1438` |
| stdio 环境变量继承（`inheritEnv` 默认 true） | `lifecycle.ts`、`stdio.ts` |
| HTTP 敏感凭据拒绝一切 redirect（含 same-origin） | `server-manager.ts:283-308`（`redirect: "error"`）、`mcp-auth-fetch.ts:50-90` |
| `tools/list_changed` 订阅 | `server-manager.ts:1438`（`ClientOptions.listChanged`） |
| Output Guard（50KB/2000行、16KB details、10MB binary、100MB session binary、10000 files） | `mcp-output-guard.ts`（数值对齐；计量窗口 P0 暂按 activation，待 session 接缝切 per-session，见 §6） |
| instructions 作为 untrusted data 有界展示 | `proxy-modes.ts` executeList（`Server instructions:` 截断 preview）、`executeInstructions`（全文，Uina P0 不做对应 action） |
| 项目 server 信任（哈希 + 审批文件 + 原子写 + 不回显敏感值） | `project-server-trust.ts` |
| Windows npx 解析问题 | `npx-resolver.ts` |
| 超时/取消语义 | `abort.ts`、`errors.ts` |

**安全与防御策略基线以 Pi 为准**：除对照表 ⚠️ 项与下方分歧清单显式登记者外，全部对齐（不比它更严，也不比它更松）；已登记偏差随实现演进收敛（如计量窗口待 session 接缝）。

**分歧与适配（有意为之）**：
① **运行时一致性纪律（正交于安全策略）**：单操作不可变快照（防 TOCTOU）、draining 连接（保护 in-flight 自然结束，含在途目录刷新）、superseded 刷新丢弃不跨代跳跃、catalog 统一状态判定（准入检查 → 指纹 → TTL），服务于 Uina 长期运行主体与热配置 reload 正确性；
② **冷发现自举**：冷发现用 `list(server)` 按需触发，不做 Pi 的启动期批量预读（更契合 D3）；
③ **信任机制简化**：无 git worktree 审批共享；
④ **分页聚合交由 SDK**：利用 SDK v2 原生聚合（Pi 手写 `do..while nextCursor` 循环，Uina 遵循 D10 协议归 SDK）；
⑤ **计量窗口暂有意不同**：Output Guard 的 session 级累计 P0 暂按 activation 计（扩展层尚无 session 生命周期接缝；数值对齐、窗口如实标注，待接缝后切 per-session，见 §6）；
⑥ **注解审批差异**：Pi 可按注解事前审批（真实工具注册自带 annotations）；Uina 代理工具架构下事前不可得，annotations 仅后置入 details（D11、§9）；
⑦ **instructions 暴露面收窄**：Pi 另有独立 `mcp({ instructions })` 全文 action；Uina P0 仅经 `list(server)` 有界 preview 暴露（同为 untrusted data，全文 action 需求出现再议）。

不继承：一切 Pi 耦合（pi-ai/pi-tui peer 依赖、内置 MCP 接管、宿主配置导入、面板）与依赖重的能力（见 §1 非目标）。

## 16. 开发推进指南（依赖分层 · 实施顺序 · 防漏清单）

本节是 §5 模块切分的施工视图：开发时对照它确认"每根依赖线都有落点、每个落点都有归属"。

### 16.1 分层依赖（文字版依赖图）

```text
┌─ 宿主接缝（现有代码 · 只装配，不改内核五目录）─────────────────────┐
│  host.ts 装配   pi.registerTool   tools.beforeCall   ui.confirm/reportError  │
└──────┬──────────────┬──────────────┬──────────────┬───────────────┘
       │装配           │注册工具        │run 前拦截      │信任弹窗/报错
┌──────▼──────────────────────────────────────────────────────────┐
│  .uina/extensions/mcp/                               ┌────────────────────┐  │
│  index.ts（装配入口 · 临时目录创建）                  │  MCP SDK client    │  │
│    │注册                                             │  2.x.y 确切版本锁死 │  │
│  catalog.ts ←refresh提交─ server-manager.ts ────────►│  （唯一协议出口）    │  │
│    ▲三态判定            ▲ensureClient·call            └────────────────────┘  │
│    │                    │                                                    │
│  proxy-tool.ts（5 actions · 投影 · Output Guard）◄─ tools.beforeCall          │
│    │快照 resolveMcpConfig                                                     │
│  config.ts（两层发现 · 快照 · 指纹 · 信任门 · 脱敏）◄─ server-manager 经快照参数 │
└──────┬──────────────────┬─────────────────────┬──────────────────────────┘
       │读写               │读写                  │创建/使用/回收
┌──────▼─────────┐  ┌──────▼───────────┐  ┌──────▼─────────┐  ┌───────────────┐
│mcp-catalog.json│  │项目/全局 mcp.json │  │ mcp-trust.json │  │tmpdir/uina-mcp│
└────────────────┘  └──────────────────┘  └────────────────┘  └───────────────┘
```

**结构性不变量（实现时若发现需要打破任何一条，即为设计偏离，先回来改本文档再动代码）**：

1. **依赖箭头无环**：catalog ← server-manager ← proxy-tool ← index 单向向上；config 是所有模块的底层，经快照参数单向流入（虚线），任何模块不得反向调用 config 之外的盘读取。
2. **config.ts 是唯一读盘者**（两层 mcp.json + trust.json）；server-manager 与 catalog 只接收 `ResolvedServerConfig + fingerprint`，自身不碰磁盘配置。
3. **server-manager.ts 是唯一碰 SDK 的模块**（Client / 三种 transport / terminateSession）；协议知识不出此文件。
4. **proxy-tool.ts 是唯一同时面对外层 broker 拦截（beforeCall）与内层结果投影（Output Guard / 五态映射）的模块**；D11 两层时序由它体现。
5. **临时目录是三方协作点**：index 创建（activationSeq 防碰撞）→ proxy 使用（截断落盘）→ teardown 整目录回收——漏掉任何一方就是孤儿文件。

### 16.2 实施顺序（自下而上，每步以门禁收口）

| 步骤 | 内容 | 验收门 |
| --- | --- | --- |
| S0 骨架与依赖 | `package.json` 锁死 `@modelcontextprotocol/client` 确切版本（D1）；`.uina/extensions/mcp/` 目录骨架与类型定义 | biome + typecheck + boundaries 绿 |
| S1 config.ts | 两层发现与原子替换、单操作快照、shadowing、指纹哈希、信任门（pi.ui.confirm + trust.json）、`sanitizeEndpointForDisplay`、redirect: "error" | config 单元测试全绿 |
| S2 catalog.ts | 条目三元组、统一状态判定（准入 → 指纹 → TTL）、原子持久化与 unconfigured 清理、refreshPromise | catalog 单元测试全绿 |
| S3 server-manager.ts | ensureClient 状态机、inFlight ticket（含 listTools）、idle、draining、startingPromise 指纹绑定、superseded、terminateSession | 单元 + 协议 in-memory 测试全绿 |
| S4 proxy-tool.ts | 5 actions、stale 前置校准断路、五态映射、CallToolResult 投影、Output Guard、临时文件落点 | proxy-tool 单元测试全绿 |
| S5 外部扩展 index + teardown | `.uina/extensions/mcp/index.ts` 由现有 loader 装载、临时目录创建/回收、真实进程 stdio 测试、Windows `npx.cmd` 实测 | 全量门禁（含 CRAP 对 extensions/ 另跑覆盖率）+ 真实进程 + ls-remote 推送验证 |

### 16.3 防漏清单（最易遗漏项，按 16.1 分层索引）

- **宿主接缝层**：MCP 不在 `host.ts` 做专用装配；由现有 `.uina/extensions` loader 发现，`beforeCall` 结构上拿不到 annotations，不要在该层实现注解审批。
- **config 层**：全局路径必须走 `getGlobalUinaDir()`（`.uina` 由代码追加，防写进 `~` 根）；测试中 `UINA_HOME` 语义是主目录替身，期望路径含 `.uina/` 段；redirect 对**含 same-origin 在内的一切重定向**拒绝。
- **catalog 层**：状态判定准入检查在指纹之前（防"校准不存在的 server"认知死锁）；持久化原子写并顺带清理 unconfigured 条目。
- **server-manager 层**：inFlight ticket 覆盖 `refreshCatalog` 的 listTools，不只 callTool；SDK 版本浮动 = 违反 D1。
- **proxy-tool 层**：stale 前置校准失败立即断路 failed，绝不带旧缓存 dispatch；零入参 `args` 兜底 `{}`。
- **S5 收尾**：Windows `npx.cmd` 已用真实 fixture 验收，`uvx` 与孙进程滞留仍需真实环境证据；确认泄漏后才启用 `killTree`（不过度设计）；biome 不剥 BOM，批量编辑后复核。
