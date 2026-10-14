# Uina 桌面感知 MCP 开发指导与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:executing-plans` 按任务执行；只有用户明确选择委派后才使用 `superpowers:subagent-driven-development`。下面的 checkbox 用于跟踪验证结果，不代表本轮已经实施。

**Goal:** 交付可被 Uina 现有 MCP 代理使用的 ListTargets、Screenshot、Snapshot；不依赖 Skill，不操作用户桌面。

**Architecture:** 一个独立 Python stdio MCP 包，使用统一目标解析和 Observation 结果。协议主进程持目标引用和可取消任务边界，原生查询先用短命进程隔离；按真实延迟证据允许优化快路径。Uina 仅复用现有 MCP 生命周期/图像投影，限定修改通用诊断投影中的重复图片落盘问题。

**Tech Stack:** Python 3.12 x64、官方 MCP Python SDK、Pillow、uiautomation/comtypes、ctypes；pytest；Uina TypeScript/Vitest。

**Spec:** `E:\Uina\Uina\docs\proposals\integrations\mcp\screen-mcp-design.md`（含 2026-10-05 四项修订）。本文是开发步骤，不重新定义产品范围。新增的实现落点、暂用依赖和测试名字在此固定。

**Status:** 开发指导已写；尚未创建 Python 包、安装依赖或修改产品代码。执行前由用户评审本文；默认本线程顺序实施，不默认创建其他聊天、子代理、worktree 或提交。

## 0. 全局约束与评审重点

### Global Constraints

- 三个工具名称精确为 `ListTargets`、`Screenshot`、`Snapshot`，不增加 `get_app_state` 或别名。
- 两个观察工具省略 target 均为 desktop；Snapshot `includeImage=true`、`scope=window`、`maxNodes=1200`、`maxTextChars=500`。
- PNG 首版唯一格式；`maxDimension` 为正整数或 `original`，省略使用有限默认长边，不是原尺寸。
- 开发暂用长边 1920，仅作为矩阵候选；发布前按设计 5.4 节实测并冻结，不宣称 1920 已验收。
- window/active_window 默认 surface；visible 必须显式请求，不能偷偷替代 surface；不启动/聚焦/恢复/移动/输入/点击/滚动。
- Snapshot 有任何有效请求组件返回即 `isError=false`，缺失或截断为 observation.partial；没有有效结果才 failed；取消不被 partial 覆盖。
- backend 仅诊断；模型正文保留 surface、来源、范围、尺寸、完整性。组件 not_requested 不计缺失。
- 坐标统一虚拟桌面物理像素 `[left,top,right,bottom]`，允许负原点；区域部分越界也报错。
- password 检查必须先于 value/TextPattern/Legacy value；无法确认保护属性则跳过值。
- 不加 World、backend registry、direct tool promotion、worker pool、遥测、长期监听、自动图像归档或额外安全系统。
- 不改真实 Provider/auth/profile/session；不改用户已有 `E:\Uina\Uina\src\agent\context.ts` 修改；不修改 Pi。
- 全量图像可能进入 session/Provider；Server 不自行归档不等于端到端无持久化。
- 本地 proposal 目录被 Git 忽略。设计与指导保持本地，不改忽略规则强制提交它们。

### Review Focus（必须分配到测试，不是口头提醒）

1. SDK 2.x 已发布，但设计研究的是 SDK v1 接口；安装版本不能漂移，复合 schema/显式 partial 不被 SDK 重写。（Task 1、5）
2. 窗口关闭/句柄复用、取消恰好发生在排队或原生调用时；必须不观察错误窗口、不留 helper。（Task 2、3、6）
3. Screenshot 返回图片但语义 unavailable；模型头部必须 PARTIAL，Uina 顶层仍 succeeded。（Task 1、7、10）
4. UIA/IA2 混合 DPI、密码属性查询失败、浏览器无当前页根；不泄露值、不编造可见性/DOM/滚动 false。（Task 7、8）
5. 默认大图成本和 worker 启动慢；必须有冻结的尺寸/延迟 gate，不能临交付只汇报实际数值。（Task 4、9、12）

## 1. 执行前的事实、环境和安全工作区

### 1.1 已核实的当前入口

- Uina HEAD 研究基线 `8467fc262d690a5d968a411a8b6fae02b56bac9a`，执行时重新核实。
- MCP 外部扩展：`E:\Uina\Uina\.uina\extensions\mcp\`。
- 现有测试：`E:\Uina\Uina\tests\mcp-proxy-tool.test.ts`、`E:\Uina\Uina\tests\mcp-stdio-real.test.ts`、`E:\Uina\Uina\tests\image-content.test.ts`。
- `E:\Uina\Uina\tests\image-content.test.ts` 已示范 `UinaHost.create → start → submitText → dispose`、localhost wire、journal reopen。
- `E:\Uina\Uina\tests\mcp-stdio-real.test.ts` 已示范隔离 UINA_HOME、stdio 子进程和项目 server 信任。
- 当前不存在 `E:\Uina\Uina\packages\screen-mcp\`。本指导不是声称这些未来文件已经存在。
- 本轮只读检测到 Python 3.12.12 与 `E:\Work\uv\uv.exe`；版本/路径执行时重查，不默认其永远有效。

先读项目规定的 FACTS/DECISIONS/BASELINE/current-runtime，再执行：

```powershell
Set-Location -LiteralPath 'E:\Uina\Uina'
git status --short
git rev-parse HEAD
python --version
Get-Command uv
pnpm exec vitest run tests/image-content.test.ts tests/mcp-proxy-tool.test.ts tests/mcp-stdio-real.test.ts --maxWorkers=1
```

基线失败必须先定位是新任务问题、用户已有修改还是环境问题。不能为了绿灯清理用户文件；不能把历史 52 tests passed 当当前运行的结果。

### 1.2 候选依赖：可安装不等于通过验收

为避免指南中的 API 和安装物不同，首轮固定如下候选，Task 1 真实安装/协议测试后用 `uv.lock` 锁完整依赖：

| 类别 | 候选固定版本 | 核查范围 |
| --- | --- | --- |
| mcp | 1.30.0 | 官方发布 metadata 及同名 Git tag 源码；不浮动到已发布的 2.3.0 |
| Pillow | 12.3.0 | 官方发布 Python >=3.10；仍需 Windows 像素验收 |
| uiautomation | 2.0.29 | 发布依赖 comtypes；不能抄 Windows-MCP 的 vendor 全集 |
| comtypes | 1.47 | 官方发布 Python >=3.9；UIA 实测验证 apartment |
| jsonschema | 4.26.0 | 独立请求/output 验证 |
| pytest / pytest-asyncio | 9.1.1 / 1.4.0 | 开发测试组，官方发布 Python >=3.10 |

pyproject 的运行要求固定 `>=3.12`；公开支持范围暂为 Windows 10/11 x64 + Python 3.12，不能凭依赖 metadata 推断其他版本都支持。生产依赖按平台声明 Windows UIA 库；pure tests 可在无桌面环境运行。Task 1 如发现真实不兼容，只调整有证据的那项并记录理由，不批量升级整个栈。

### 1.2.1 Task 1 的最小 packaging 配置

以下是未来 pyproject.toml 的必需字段，不是本轮已经落盘的项目；先写安装/stdio红测试，再创建：

```toml
[build-system]
requires = ["setuptools==80.9.0"]
build-backend = "setuptools.build_meta"

[project]
name = "uina-screen-mcp"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "mcp==1.30.0",
  "Pillow==12.3.0",
  "jsonschema==4.26.0",
  "uiautomation==2.0.29; sys_platform == 'win32'",
  "comtypes==1.47; sys_platform == 'win32'",
]

[project.scripts]
uina-screen-mcp = "uina_screen_mcp.__main__:main"

[dependency-groups]
dev = ["pytest==9.1.1", "pytest-asyncio==1.4.0"]

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
markers = [
  "desktop: explicitly authorized real Windows desktop tests",
  "provider: explicitly authorized real provider tests",
]
```

`__main__.main()` 是零参数同步入口，用 asyncio.run 启动官方 stdio；worker 的 `-m uina_screen_mcp.worker` 是另一个仅执行一次的入口，不误进 Server。非 Windows 启动正式Server直接报告unsupported_platform，pure模块/测试仍可导入，不自动fallback为别的平台。

Task 1 首次安装本包及 dev 组、真实握手后生成 uv.lock；后续命令都用 --frozen。安装失败或build API不兼容要在进入native任务前解决，不把metadata兼容当真实安装证据。

### 1.3 官方 SDK 的具体注册路径

设计提及官方 FastMCP 封装；本计划核查 `mcp==1.30.0` 后选官方公开 low-level `Server` 注册三个工具。这是**SDK 接口落地校准**，不是另造 MCP 实现：

- `Server.list_tools()` 返回我们自包含的 Tool.inputSchema/outputSchema。
- `Server.call_tool()` 返回显式 `CallToolResult`，保留 text/image/structuredContent/isError。
- 用官方 `stdio_server()` 和 `Server.run()` 处理握手、JSON-RPC、取消、错误与关闭。
- 不进入 FastMCP `_tool_manager` 等私有字段，不写自制 MCP wire parser。
- v1.30.0 直接返回 CallToolResult 的路径会提前返回，不能依赖它替我们验证 outputSchema。`render_mcp()` 显式校验 Observation，再构造 CallToolResult。
- 使用 `call_tool(validate_input=False)`，在 handler 用同一公开 schema 显式验证，保证参数非法时也有设计规定的结构化业务错误和不启动 native 的证据；JSON-RPC 本身非法仍由 SDK 处理。

### 1.4 两个上游项目：强制参考顺序与借鉴边界

**本项目明确要求借鉴两个上游项目；开发者不得只按本指导从零重写，也不得把两个项目整体拼接进来。**每个相关任务开始前，先读对应固定 commit 的源码、测试和许可证，再决定是：

1. **直接摘取**：代码可以独立搬入，依赖边界清楚，许可证/NOTICE 已记录，并有本项目测试覆盖；
2. **局部改写**：只保留算法/数据处理，去掉上游操作能力、全局状态和无关依赖；
3. **只借鉴行为**：上游实现与 Uina/Python 边界不兼容时，重新实现同一可验证行为；
4. **明确不采用**：会引入桌面操作、额外权限、错误语义或不必要复杂度。

代码审查/提交说明必须在 `THIRD_PARTY_NOTICES.md` 或对应任务报告中写出每个摘取文件的：上游 URL、固定 commit、原始许可证、是否改写、进入 Uina 的理由。**“上游已经这样做”不是采用理由；每一段复制都必须解决本项目已确定的问题。**

#### A. Windows-MCP：Windows 截图、Snapshot、工具自解释

仓库：[https://github.com/CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)  
固定参考：[commit `8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3`](https://github.com/CursorTouch/Windows-MCP/tree/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3)

必须优先检查：

- [Screenshot/Snapshot 工具描述与参数](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tools/snapshot.py)：学习无需 Skill 时如何告诉模型“何时用 Screenshot、何时用 Snapshot、区域参数如何解释”；不直接复制其工具名称、全量长描述或控制动作规则。
- [截图 backend 与结构检查](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/screenshot.py)：学习 Pillow/DXCam/MSS 的降级经验、虚假/不可解码 frame 检查和黑屏不等于失败；优先局部改写，不搬其 backend registry、control overlay、永久 degraded 状态。
- [Desktop service 的显示器、区域和截图路径](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/service.py)：学习虚拟桌面原点、显示器选择、区域验证和快速路径；本项目要按自身 `surface/visible` 与严格区域合同重新实现。
- [UIA Snapshot 遍历](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tree/service.py)：学习元素预算、父节点、滚动状态、字段级失败隔离和 password marker；不得把其控制方法、watchdog、全量 UIA vendor 层带入。
- [Firefox MSAA/IA2 fallback](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tree/ia2.py)：只在 Task 8 的 page 模式需要时摘取；必须标明 `browser_msaa_ia2` 来源，不得称为完整 DOM。
- [截图回归测试目录](https://github.com/CursorTouch/Windows-MCP/tree/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/tests)：优先借鉴其 screenshot fallback、display filter、snapshot budget 的测试思想和失败样本。

#### B. open-computer-use：get_app_state 的应用级观察组合

仓库：[https://github.com/iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use)  
固定参考：[commit `93b817501e0b9fa04fba155face2630bfcd0322e`](https://github.com/iFurySt/open-codex-computer-use/tree/93b817501e0b9fa04fba155face2630bfcd0322e)

必须优先检查：

- [Windows get_app_state 结果组合](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/apps/OpenComputerUseWindows/main.go)：学习应用标题/进程/窗口状态、文字和 image content 作为同一次观察结果返回；在 Uina 中落到 `Snapshot(target=window)`，不新增第四个 `get_app_state` 工具。
- [Windows 应用解析、窗口边界和 UIA 元素](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/apps/OpenComputerUseWindows/runtime.ps1)：学习应用→窗口→bounds→元素的调用链、坐标转换和元素字段；必须修正其 First-1 模糊选择，不得静默选第一个窗口。
- [跨平台应用 Snapshot 组合与窗口捕获](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/AccessibilitySnapshot.swift)：学习 text/image 结果组织、窗口标识和尺寸换算；不得把 macOS activation/recovery 策略带入 Uina，默认不聚焦/恢复/移动窗口。
- [工具定义与参数说明](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/ToolDefinitions.swift)：学习工具用途与参数边界的描述；实际 text/image content 顺序以 Windows `main.go` 的 result 实现为准，不从工具声明推断结果结构；不复制 click/type/drag/action session。
- [open-computer-use Skill](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/skills/open-computer-use/SKILL.md)：只提取其中可以放入工具 description/schema/result 的观察规则；不要复制“每回合必须先 get_app_state”或“下一步必须执行动作”的 Computer Use 操作协议，因为 Uina 当前没有 Skill 且本项目只观察。

**融合规则：**Windows-MCP 提供 Windows 实现和 Snapshot 语义素材；open-computer-use 提供应用级观察结果的组织方式。两者最终必须收敛为 Uina 的 `ListTargets + Screenshot + Snapshot`、统一 Target、Uina partial/isError 合同；禁止把 `Screenshot + Snapshot + get_app_state` 三套接口原样暴露。

### 1.5 目录和命令变量

之后的文件 map 均相对于下列明确根，但实际引用使用完整路径。实现期间不要创建独立 Git 仓库或写进真实 `.uina` 数据：

```powershell
$Repo = 'E:\Uina\Uina'
$Screen = Join-Path $Repo 'packages\screen-mcp'
```

Task 1 创建 Python 包后才运行：

```powershell
uv sync --project $Screen --python 3.12 --group dev
$Py = Join-Path $Screen '.venv\Scripts\python.exe'
& $Py -m pytest (Join-Path $Screen 'tests') -m 'not desktop and not provider' -q
```

不在本轮执行安装。包自己的 `.gitignore` 忽略 `.venv/`、`__pycache__/`、`.pytest_cache/`、`build/`、`*.egg-info/`、`.artifacts/`；lock/源码/合成 fixture 则可版本化。截图、真实页面输出和 credentials 不加入测试 fixture 或 Git。

## 2. 文件地图与必要接口

### 2.1 Python 包：固定写入范围

所有路径的共同前缀为 `E:\Uina\Uina\packages\screen-mcp\`：

| 完整路径 | 责任 |
| --- | --- |
| `E:\Uina\Uina\packages\screen-mcp\pyproject.toml` / `uv.lock` / `.gitignore` | 安装、固定依赖和包内产物边界 |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\__init__.py` / `__main__.py` | 包入口；stdio 默认，不启动窗口 |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\contracts.py` | schema、固定工具 descriptions、默认值与字典数据形状 |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\render.py` | 聚合状态、同一事实的文本/结构化输出、SDK result |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\targets.py` | 实际目标解析、ref 字典、rect 校验 |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\capture.py` | Win32/Pillow 捕获、光标、缩放和 PNG |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\worker.py` | 一次原生查询入口与可取消 QueryRunner |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\semantics.py` | 单次 UIA 遍历，字段隔离、结构/滚动状态 |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\browser.py` | 页面根选择和按需 IA2 |
| `E:\Uina\Uina\packages\screen-mcp\src\uina_screen_mcp\server.py` | ScreenService 编排和官方 SDK 注册；不持活 COM |
| `E:\Uina\Uina\packages\screen-mcp\scripts\smoke.py` / `measure.py` | 真实 MCP 冒烟；尺寸/分阶段测量，不替代 Uina 指标 |
| `E:\Uina\Uina\packages\screen-mcp\README.md` / `THIRD_PARTY_NOTICES.md` | 命令、数据流、能力和来源 |

函数短时允许相关逻辑放同一个文件；不为每个 dataclass 再建服务层。

### 2.2 Uina 限定写入范围

- 新建 `E:\Uina\Uina\tests\fixtures\screen-mcp-observation.mjs`：合成 text/image/partial 的协议 fixture，无真实桌面。
- 新建 `E:\Uina\Uina\tests\mcp-screen-roundtrip.test.ts`：真实 stdio → MCP → Host → Provider wire → 恢复。
- 新建 `E:\Uina\Uina\tests\mcp-screen-live.test.ts`：显式启用时调用真正 Python Server，仍使用隔离 HOME。
- 新建 `E:\Uina\Uina\scripts\measure-screen-mcp.mts`：Uina proxy/结果投影边界计时，不是裸 Python 自测。
- 条件修改 `E:\Uina\Uina\.uina\extensions\mcp\output-guard.ts` 和 `E:\Uina\Uina\tests\mcp-proxy-tool.test.ts`：Task 11 的唯一产品层修正。
- 默认不改 Host/Core/Agent/Provider/Session、MCP config/proxy/server-manager 或根 package.json。若测试揭示必须改，先说明真实缺口及最小修改，不能顺手重构。

### 2.3 邻接接口（写代码前统一名称）

使用 dataclass/TypedDict 与普通函数即可，不建立继承框架。以下为接口签名表（不是可直接执行的完整 Python 文件）：

```text
# contracts.py
# JsonObject = dict[str, Any]; Rect = tuple[int, int, int, int]
validate_arguments(tool_name: str, args: JsonObject) -> JsonObject
build_tools(default_max_dimension: int) -> list[mcp.types.Tool]

# render.py
aggregate_components(components: dict[str, JsonObject]) -> Literal['ok', 'partial', 'failed']
render_mcp(observation: JsonObject, png: bytes | None) -> mcp.types.CallToolResult

# targets.py
class TargetResolver:
    remember_window(self, facts: JsonObject) -> str
    resolve(self, target: JsonObject, inventory: JsonObject) -> JsonObject
validate_region(rect: Rect, display_rects: list[Rect]) -> Rect

# capture.py（仅任务进程/图像单元测试中加载）
capture_pixels(bounds: Rect) -> PIL.Image.Image
capture_window(hwnd: int, bounds: Rect) -> PIL.Image.Image
prepare_png(image: PIL.Image.Image, max_dimension: int | Literal['original']) -> tuple[bytes, tuple[int, int]]

# worker.py
class QueryRunner:
    async run(self, operation: str, payload: JsonObject, timeout_s: float) -> JsonObject
    async close(self) -> None

# semantics.py / browser.py（仅任务进程加载）
read_window_semantics(hwnd: int, bounds: Rect, options: JsonObject) -> JsonObject
read_page_semantics(hwnd: int, bounds: Rect, options: JsonObject) -> JsonObject

# server.py：一个拥有引用与执行资源的具体对象，不是 service framework
class ScreenService:
    async call(self, name: str, args: JsonObject) -> mcp.types.CallToolResult
    async close(self) -> None
build_server(service: ScreenService) -> mcp.server.lowlevel.Server
```

`validate_arguments` 先验原始显式参数的形状/互斥，再填该请求实际需要的默认值；includeImage=false不能因为内部补入maxDimension默认而被错误拒绝。实际窗口/显示器/rect 校验归 TargetResolver。`QueryRunner.run` 的 operation 只允许 enumerate/capture/semantics/page；实际payload携带HWND/PID/创建身份/预期bounds，不只带字符串ref。capture/semantics任务进程在访问目标前核对这些facts，不能拿主进程刚才resolve结果代替实际执行前重验证。不把传入字符串当可执行代码。Server 可以注入 runner fake 测 orchestration，但不能因此宣称 native 已验证。

Worker 只接一条版本固定的 JSON 请求、返回一条 JSON 结果；png 仅在 capture reply 用 base64 传递，到 MCP 前解码为 bytes，并通过 render 再编码一次。stdout 不混日志，stderr 不写图像/页面正文。worker facts 的顶层固定 `{ok, payload, diagnostics, error}`；未编码完成的图像不能送回旧帧。

## 3. 实施任务（按依赖推进；每项都有独立红绿门）

执行依赖：Task 1–5 → Task 9 的初测部分 → Task 6–8 / Task 10–11 → Task 9 的冻结与复测部分 → Task 12。Task 9 分成两个实验时点，不是先冻结未经完成的功能；性能初测必须早于完整Snapshot收尾。以下编号用于责任与证据索引，不强制把初测拖到Task 8之后。

### Task 1：结果合同、描述和纯逻辑最小包

**上游检查点：**先读第1.4节 Windows-MCP `tools/snapshot.py` 和 open-computer-use `main.go` 的 `get_app_state`/result；抽取观察层的 description、text+image 和应用状态组合，用本项目对称 partial 合同替换上游错误语义。

**Files:** 新建本包 pyproject/lock/gitignore、contracts.py、render.py、入口骨架、`E:\Uina\Uina\packages\screen-mcp\tests\test_contracts.py`、`test_render.py`。入口骨架不得启动真实捕获。

**Interfaces:** 产出 validate_arguments / build_tools / aggregate_components / render_mcp；后续任务只使用这套固定结构。

- [ ] 先建立最小可安装的包入口与可导入的接口stub，stub不执行native，也不返回伪造的真实截图。建立测试只需要的入口，安装命令失败必须单独修复，不能充当逻辑红测试。
- [ ] 写红测试 `test_tool_names_and_descriptions`：只有三个工具；描述包含 Screenshot vs Snapshot、无操作、page 非 DOM、partial、original；schema 无外部引用；default 来自同一常量（开发 1920）。
- [ ] 写参数红测试：五 Target 正例；ref+match/空match/未知字段/boolean rect失败；scope=page+desktop失败；includeImage=false+显式图像选项失败；正整数/original合法，0/负值/all非法。
- [ ] 写 `test_partial_is_symmetric`：两侧失败互换均 false+partial；not_requested不算缺失；空的完成语义树为ok；错误消息/标题不算有效观察；全部失败才true。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_contracts.py') (Join-Path $Screen 'tests\test_render.py') -q`，确认断言红，不用 import错误、skip或安装失败当红测试证据。
- [ ] 实现 envelope 的 kind/status/target/time/components/warnings/diagnostics，error仅整体失败；description从设计10.1节复制，schema从附录生成。以纯聚合逻辑驱动 MCP isError，不硬编码哪个组件“更主”。
- [ ] 文本首行 Observation，target/surface/bounds/originalSize/outputSize/source/truncation放前；正常文本没有backend；结构化diagnostics有backend；输出Schema验证失败时不要返回伪成功。
- [ ] 同命令转绿；测试 `render_mcp` 解码PNG字节相同、文本/结构化内容来自同一事实、partial component原因不丢。此阶段不需要屏幕或真实Provider。

**代表性断言（其余用参数化，不复制第二套聚合规则）：**

```python
def test_partial_is_symmetric():
    for components in (
        {'image': {'status': 'ok', 'valid': True}, 'semantics': {'status': 'unavailable'}},
        {'image': {'status': 'failed'}, 'semantics': {'status': 'ok', 'valid': True}},
    ):
        assert aggregate_components(components) == 'partial'
```

valid是聚合器内部已验证标记，不必暴露给模型。空语义只有完成查询才valid；不得按payload是否非空猜valid。

**Exit:** 纯合同绿；无native副作用。未达此门不进入截图实现。

### Task 2：显示器、窗口清单与精确目标解析

**上游检查点：**先读 Windows-MCP `desktop/service.py` 的 display/region 解析和 open-computer-use `runtime.ps1` 的 Resolve-App/Get-WindowBounds；保留前者的坐标事实，拒绝后者的 First-1 选择。

**Files:** targets.py、worker.py的enumerate分支；`E:\Uina\Uina\packages\screen-mcp\tests\test_targets.py`、`tests\desktop\test_inventory.py`。

**Interfaces:** 产出 TargetResolver / validate_region；inventory返回display facts与window facts（HWND、PID、进程创建身份和bounds）；对外ref隐藏HWND。

- [ ] 红测试 `test_match_zero_one_many`、`test_ref_rejects_reused_handle`、`test_title_change_keeps_ref`、`test_region_requires_full_containment`、`test_mixed_dpi_does_not_rescale_pixels`、`test_display_gap_is_not_a_physical_monitor`。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_targets.py') -q` 确认断言红。
- [ ] 用 EnumDisplayMonitors/GetMonitorInfo 与 EnumWindows/GetWindowRect/GetWindowThreadProcessId 取得当前交互桌面目标；当前前台句柄一次固定。以设备名为display身份，不以排序当永久身份；应用匹配精确、标题子串。
- [ ] 进程创建身份读取失败时，不发可长期复用的“可靠ref”；返回该目标身份不可确认并允许重新枚举，而不是拿缺失身份冒充安全重验证。保留窗口字段 null和原因，不丢整份清单。
- [ ] 使用独立 `ctypes.WinDLL(..., use_last_error=True)` 绑定和标准wintypes结构；不污染全局 windll共享函数签名。任务开始先设置一致DPI awareness；UIA/pixel测量使用同一物理坐标。
- [ ] 纯测试转绿；真实desktop测试验证负原点、多窗歧义、窗口关闭/最小化、未读取UIA、没有focus变化；记录foreground前后不变。ref只存主进程字典，重启失效。

**Exit:** ListTargets可以准确找目标，精确重验证有效；不宣称capturable/semanticTree成功。

### Task 3：原生查询的超时、取消和资源回收

**Files:** worker.py；`E:\Uina\Uina\packages\screen-mcp\tests\test_worker_lifecycle.py`、`tests\fixtures\worker_hang.py`、`E:\Uina\Uina\packages\screen-mcp\tests\fixtures\worker_reply.py`（合成，不持用户内容）。

**Interfaces:** QueryRunner.run/close；server只拿序列化结果，COM/Win32句柄不跨进程。先开发短命基线，不优化常驻。

- [ ] 红测试 `test_timeout_reaps_child`、`test_cancel_while_waiting_never_spawns`、`test_cancel_during_native_reaps_child`、`test_close_waits_for_active_child`、`test_repeated_cancel_still_reaps_child`、`test_next_call_works_after_timeout`、`test_stderr_does_not_become_protocol`。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_worker_lifecycle.py') -q` 确认红。
- [ ] 使用asyncio.create_subprocess_exec和sys.executable，参数数组，不经shell；Windows helper设置CREATE_NO_WINDOW。锁仅负责native任务串行，等待锁时可取消；finally terminate/kill+wait并读完pipe，主进程响应MCP。
- [ ] operation启动后限时capture=5s、semantics/page=10s（开发operational值）；enumerate也限capture预算。参数可由Server启动选项调整，不添加LLM工具timeout开关。排队时间单独记录，client整体timeout仍有效。
- [ ] worker入口只lazy import需要的native模块，捕获路径不加载UIA/浏览器；子进程不再spawn孙进程。worker异常返回固定错误，不捕获BaseException吞取消。两次连续取消也必须完成cleanup：独立cleanup等待通过shield等机制保持可观察，不能仅shield后立即返回而把回收留后台；父进程退出必须等待所拥有子进程的实际退出。
- [ ] 转绿；验证100次合成成功/失败/取消后无增长的活子进程、stdout协议干净；无法确认进程已退出时不报告回收成功。

**Exit:** 无桌面情况下可证明生命周期；真实卡死任务在desktop门另外验证。线程future timeout不算此门通过。

### Task 4：桌面/显示器/区域快速截图

**上游检查点：**先读 [Windows-MCP screenshot.py](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/screenshot.py) 及其 screenshot tests；摘取结构检查和 fallback 的测试意图，不复制 backend registry。

**Files:** capture.py、worker.capture；`E:\Uina\Uina\packages\screen-mcp\tests\test_capture.py`、`tests\desktop\test_pixels.py`。

**Interfaces:** capture_pixels / prepare_png；payload携带已解析bounds及maxDimension；返回PNG+实际bounds/两组size，surface=desktop_pixels，backend只diagnostics。

- [ ] 红测试 `test_prepare_png_bounded_default`：2560×1440、开发默认1920 → 1920×1080；1400×900保持；original保持；不放大；按actual比例计算两个轴。
- [ ] 红测试 `test_crop_preserves_negative_origin`、`test_black_image_is_valid`、`test_invalid_frame_is_error`、`test_cursor_uses_hotspot_and_crop_origin`；使用Pillow合成画布，不读取真实桌面。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_capture.py') -q` 确认红。
- [ ] Pillow.ImageGrab.grab(all_screens=True)作为首个桌面像素路径，按物理origin裁剪；捕获前重新核对display布局，布局变化不能用旧origin产生静默错误。
- [ ] 可选cursor用GetCursorInfo/GetIconInfo与实际hotspot叠加；DrawIconEx或小量DIB转换只保留一种实现，DeleteObject等句柄finally回收。includeCursor=false不画假高亮。
- [ ] PNG结构/可解码/尺寸检查；图像编码耗时计入诊断，不引入OCR或black-content判断。转绿。
- [ ] `& $Py -m pytest (Join-Path $Screen 'tests\desktop\test_pixels.py') -m desktop -q` 验证真实单屏/负坐标/4K/混合DPI，保留本次测试控制的样本，不截无关私人桌面作为公开fixture。

**Exit:** 快速路径只做目标和图像，不扫描语义；原尺寸/默认候选/自定义尺寸可对比。

### Task 5：正式 stdio Server 和 Screenshot 第一条纵向切片

**上游检查点：**先读 Windows-MCP `tools/snapshot.py` 的 description 组织、open-computer-use `ToolDefinitions.swift` 的参数说明及 Windows `main.go` 的 text/image 结果；把关键使用规则写入本项目 description/schema/result，不依赖 Skill。

**Files:** server.py、__main__.py、scripts/smoke.py；`E:\Uina\Uina\packages\screen-mcp\tests\test_server_stdio.py`、`test_service.py`。

**Interfaces:** ScreenService.call/close、build_server；SDK Tool与schema来自Task1，native由Task2–4负责。

- [ ] 红测试 `test_stdio_lists_exact_contracts`、`test_screenshot_emits_text_image_structured`、`test_invalid_arguments_never_run_query`、`test_snapshot_semantic_only_never_capture`（先通过fake runner明确最终合同）。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_service.py') (Join-Path $Screen 'tests\test_server_stdio.py') -q` 确认红。
- [ ] 官方SDK list/call注册，显式输入与输出schema验证；ScreenService依次resolve→capture→可选semantics→render。所有返回分支使用同一render，不在server复制isError逻辑。
- [ ] 进程启动 `& $Py -m uina_screen_mcp`，仅等待stdio，不弹窗；lifespan finally关闭runner。Snapshot在native功能未完成时不是假空树：正确返回unavailable或fake test注入结果；不得当完整交付。
- [ ] 转绿；用真实SDK ClientSession+stdio_client冒烟三工具schema与Screenshot；`scripts/smoke.py --tool Screenshot --args '{}' --check-only`只报告size/status，不把base64打印到shell。工具业务isError令smoke退出非零；partial退出0并明显显示partial。

**Exit:** 第一个真实Server可启动、发现、截图、关闭；Task9初测现在启动，不等Snapshot全部完成才发现Screenshot很慢。

### Task 6：应用窗口surface/visible与身份变化

**上游检查点：**先读 open-computer-use Windows `Capture-WindowPngBase64`；确认其 `CopyFromScreen` 只是桌面像素裁剪后，再实现 Uina 的 `surface` 与显式 `visible` 双语义。

**Files:** capture.py、targets.py、server.py；`E:\Uina\Uina\packages\screen-mcp\tests\test_window_capture.py`、`tests\desktop\test_windows.py`。

**Interfaces:** capture_window；无active_window会话缓存；captureMode由同一schema判定。

- [ ] 红测试 `test_surface_failure_never_falls_back_to_visible`、`test_visible_clip_reports_actual_bounds`、`test_minimized_visible_fails`、`test_cursor_surface_rejected`、`test_active_window_is_resolved_once`、`test_geometry_change_is_reported`。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_window_capture.py') -q` 确认红。
- [ ] PrintWindow(surface)只在worker执行，首轮flags=0（整个窗口）；检查BOOL/API结果并回收HDC/HBITMAP，恢复被选入DC的原GDI对象后再DeleteObject；画布和GetWindowRect一致，不默认仅客户区。不把Pillow window参数作为独立surface等价实现。
- [ ] visible使用已有capture_pixels交集；出屏clipped事实及语义限制可见。窗口身份在实际capture前和完成后核对；变更按事实partial/error，不回旧截图。
- [ ] 转绿并执行 `& $Py -m pytest (Join-Path $Screen 'tests\desktop\test_windows.py') -m desktop -q`：记事本/设置/Explorer/Chrome/Edge/Electron、遮挡、最小化、关闭、GPU内容；foreground不变。
- [ ] 主要目标应用若PrintWindow不可用：此切片不达标；评审实际样本，选择最小HWND定向WGC实现并重复同门，或明确批准缩小支持范围。不得偷偷换visible、堆3套backends或谎称窗口捕获已完成。

**Exit:** 三种目标误选/失效/表面偷换风险被测试；原生API成功与画面内容验收分别报告。

### Task 7：Snapshot UIA语义、部分结果和成本预算

**上游检查点：**先读 Windows-MCP `tree/service.py` 的 budget/scroll/password/字段级错误隔离，以及 open-computer-use Windows `Get-ElementRecord`；只保留观察字段，不搬动作 patterns。

**Files:** semantics.py、worker.semantics、server.py；`E:\Uina\Uina\packages\screen-mcp\tests\test_semantics.py`、`test_snapshot.py`、`tests\desktop\test_uia.py`。

**Interfaces:** read_window_semantics；统一element数组，不增加第二套interactive/scroll trees；复用Task1聚合。

- [ ] 红测试 `test_password_guard_precedes_value`、`test_unknown_password_skips_value`、`test_scroll_unknown_is_not_false`、`test_visited_budget_counts_non_output_nodes`、`test_cycle_does_not_hang`、`test_partial_property_keeps_node`、`test_emoji_serializes`。
- [ ] 红测试 `test_snapshot_image_ok_semantics_unavailable_is_normal_partial`、其反向、both failed、empty completed tree、includeImage=false、预算截断与unvisited windows；component not_requested不影响ok。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_semantics.py') (Join-Path $Screen 'tests\test_snapshot.py') -q` 确认红。
- [ ] UIA只在worker导入；该worker在首次import comtypes/uiautomation前设置 `sys.coinit_flags=0`（MTA），在同一个无UI线程做ControlFromHandle/GetChildren/GetRuntimeId/GetPattern。已核对comtypes 1.47 import会调用CoInitializeEx并读取此flag；不要再用默认STA覆盖MTA，也不要手工把库的初始化重复释放。额外线程的COM初始化/释放必须显式配对；首版直接在任务进程拥有的同一线程执行，不增加线程池。加 `test_uia_worker_initializes_mta_before_import` 和真实apartment检查。以测试确认的公共模式读取代替拷vendor私有cache机制。
- [ ] 普通窗口保留结构父节点、role/name/value/text/bounds/state/scroll；先password、后值。每字段COM/dead-element隔离，不吞整个树；unknown省略或null。
- [ ] 全桌面先前台、再Z-order；遍历visited计预算，text按每值截断；maxNodes/maxTextChars=all取消对应预算但不取消timeout。region只选择相交窗口和相关可见报告，不能读整段无关文档再过滤文本。
- [ ] 转绿并执行 `& $Py -m pytest (Join-Path $Screen 'tests\desktop\test_uia.py') -m desktop -q`；图像已得而语义超时时依然返回图像+partial，不把原生慢调用留后台。

**Exit:** 图像/语义两种partial均被Server和LLM文本证明；无password、false状态或“无控件”的假事实。

### Task 8：浏览器page模式与Firefox回退

**上游检查点：**先读 Windows-MCP `tree/ia2.py` 和其 RootWebArea/IA2 分支；只在需要时摘取安全读取逻辑，并把 source/unknown 事实写入结果。

**Files:** browser.py、worker.page、semantics.py的公共归一化复用；`E:\Uina\Uina\packages\screen-mcp\tests\test_browser.py`、`tests\desktop\test_browser_pages.py`、`tests\fixtures\page.html`（自有静态测试页）。

**Interfaces:** read_page_semantics；与UIA相同elements，source=browser_uia或browser_msaa_ia2；不引入DOM操作工具。

- [ ] 红测试 `test_page_requires_window`、`test_page_root_ambiguous_is_unavailable`、`test_no_root_does_not_return_browser_chrome`、`test_ia2_unknown_scroll_remains_null`、`test_nested_frame_keeps_parent`、`test_page_password_value_omitted`。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_browser.py') -q` 确认红。
- [ ] Chrome/Edge选单目标窗口当前Document/RootWebArea；没有或多根无法确认时unavailable。IA2按需lazy import，仅同目标Firefox需要时用MSAA/IAccessible2，读取模式不发送输入、不改浏览器设置。
- [ ] 若复用Windows-MCP IA2，摘取枚举/安全property访问/角色归一化必要段，逐文件记录来源；不能把假scroll=false、控制方法或全局hooks带进来。
- [ ] 转绿；真实测试页包含正文、链接、禁用控件、checkbox、嵌套frame、scroll container、password。先用户允许打开该自有页面，明确它是测试操作，不是工具自动启动应用。
- [ ] Chrome/Edge/Firefox分别报告；Firefox没安装标unverified，不用pytest skip计为支持已验收。

**Exit:** browser source准确、工具仍纯观察；缺page时不伪装完整DOM。

### Task 9：早期尺寸/延迟测量与冻结验收条件

**Files:** scripts/measure.py、`E:\Uina\Uina\scripts\measure-screen-mcp.mts`；`E:\Uina\Uina\packages\screen-mcp\tests\test_measure.py`；未来本地报告在本包`.artifacts/`，不提交截图。

**Interfaces:** measure.py用官方ClientSession测Server；TS脚本用真实McpCatalog/McpServerManager/createMcpProxyTool，timer直到project完成；不把裸Python速度冒充Uina端到端速度。

- [ ] 红测试 `test_percentiles_are_computed_per_scenario`、`test_gate_rejects_missing_or_unapproved_criteria`、`test_timeout_samples_are_not_silently_dropped`；样本少/字段缺失返回非零。
- [ ] 运行 `& $Py -m pytest (Join-Path $Screen 'tests\test_measure.py') -q` 确认红；实现采样/分组/criteria校验后同命令转绿，再进行真实probe，不能用真实桌面偶然抖动当单元红绿证据。
- [ ] 固定首轮条件：warm每场景至少30次、先3次预热；cold至少10次独立Server启动/首次调用。明确这是可改但必须先冻结的实验参数，不是每次工具行为。
- [ ] TS脚本返回scenario/cold-or-warm/timestamps/worker-start/capture/encode/IPC/projection/PNGbytes/originalSize/outputSize/error样本；异常单列并计入失败率，不能只测成功最快样本。外层时间是硬验收主值，diagnostics供分解。
- [ ] `measure-screen-mcp.mts probe`初测，`gate`使用批准后的criteria文件；`measure.py`只负责裸Server对比和尺寸候选，二者明确边界。
- [ ] 1920/2560/original分别测真实高分屏、多屏和窗口/区域；量模型小字阅读、re-observe次数、PNGbytes和journal增长。真Provider只经批准的测试会话使用，credentials不进入report。
- [ ] 在最终候选复测前与用户/产品负责人冻结P50/P95门限、条件和默认长边。**没有批准的数值就阻断release gate**；不能自动用probe实际值填criteria。
- [ ] 默认长边冻结后修改唯一默认常量、schema/description/README/测试；不加运行时“猜provider调档”策略。

**开发命令（Task9实现这些参数后才可用）：**

```powershell
$ReportDir = Join-Path $Screen '.artifacts'
pnpm exec tsx scripts/measure-screen-mcp.mts probe --python "$Py" --scenario desktop --max-dimension 1920 --warm-samples 30 --cold-samples 10 --output "$ReportDir\probe-desktop-1920.json"
pnpm exec tsx scripts/measure-screen-mcp.mts gate --python "$Py" --criteria "$ReportDir\approved-criteria.json" --output "$ReportDir\gate.json"
```

criteria文件必须包含approvedAt、approvedBy、environment、defaultMaxDimension、sample条件、每场景warm/cold的p50Ms/p95Ms/maxFailureRate；不是只填一个全桌面平均数。backend可记诊断但不作为用户语义条件。支持范围/门限未定时guide允许继续做功能，禁止称release通过。

若worker/import主要耗时：先去无关import和往返；再允许单个可重建常驻capture快路径，重复Task3取消/超时/稳定性及本task门。PrintWindow/UIA不为统一而搬进MCP主进程；常驻优化不是先决任务，也不默认创建worker pool。

**Exit:** 初测有可重复样本、问题归因和可用脚本；最终门必须另行有批准的criteria及复测结果。只完成probe不得标记本Task整体已通过。

### Task 10：Uina完整协议回注与会话恢复

**Files:** `E:\Uina\Uina\tests\fixtures\screen-mcp-observation.mjs`、`E:\Uina\Uina\tests\mcp-screen-roundtrip.test.ts`、`E:\Uina\Uina\tests\mcp-screen-live.test.ts`。参考现有image-content与stdio测试，不修改其事实断言。

**Interfaces:** 复用现有mcp代理、Host与Provider构造；不把structuredContent自动注入system/context。隔离cwd不会自动发现主仓库MCP扩展；Host options必须显式传 `extensionPaths: [resolve(repoRoot, ".uina/extensions/mcp")]`，repoRoot从测试文件位置解析，不拿临时cwd冒充源根。用现有 `E:\Uina\Uina\tests\mcp-extension-loading.test.ts` 的装载规则。

- [ ] 红测试：合成fixture有ListTargets/Screenshot/Snapshot固定schema与PNG，提供图像ok+语义unavailable；proxy输出Uina succeeded，text含Observation: PARTIAL，images保真，details保留结构化facts。
- [ ] 红测试 `tool_images_and_partial_header_reach_followup_request`：启动Host，不只调用proxy函数。mock Provider脚本输出mcp.list→describe→call，真实stdioserver返回图片；紧随mcp.call之后的HTTP request（不是固定第二次request）必须含工具正文和PNG，关联正确tool_call_id；list/describe可能各自占前置请求，不能用错误的请求序号写断言。
- [ ] 红测试 `restored_history_preserves_observation`：flush/dispose后reopen隔离journal，project恢复图片/text；imageInput=false明确失败，unknown不猜true，semantic-only可用。
- [ ] 运行 `pnpm exec vitest run tests/mcp-screen-roundtrip.test.ts --maxWorkers=1`，确认红；按已存在Host调用链实现tests，不绕过start/事件帧或用未启动Host宣称MCP已注册。
- [ ] live测试用明确`UINA_SCREEN_PYTHON`绝对路径和`UINA_SCREEN_LIVE=1`启用，在隔离HOME注册真实Pythonserver，不写全局真实mcp.json；真实capture+Uina结果，不代表真实模型识图。
- [ ] 转绿；记录fixture vs live边界。tests运行恢复原环境变量，不delete别人原本设置的值。临时目录回收验证resolved绝对路径在本次工作区，PowerShell不跨shell拼删除命令。

```powershell
pnpm exec vitest run tests/mcp-screen-roundtrip.test.ts tests/image-content.test.ts tests/mcp-proxy-tool.test.ts tests/mcp-stdio-real.test.ts --maxWorkers=1
# 用户允许真实桌面观察后，暂存旧环境值，在finally恢复：
$env:UINA_SCREEN_PYTHON = $Py
$env:UINA_SCREEN_LIVE = '1'
pnpm exec vitest run tests/mcp-screen-live.test.ts --maxWorkers=1
```

**Exit:** 声明MCP→Uina→wire/journal协议通过；不得把localhost mock最终答复当真实视觉理解。

### Task 11：只修MCP诊断中的重复图像落盘

**Files:** `E:\Uina\Uina\.uina\extensions\mcp\output-guard.ts`、`E:\Uina\Uina\tests\mcp-proxy-tool.test.ts`，其余生产文件默认不动。

**Interfaces:** McpOutputGuard.project原签名不变；返回images保留完整base64，mcpResult仅诊断投影变更。

- [ ] 先复现：大image content触发raw-result超16KiB落盘，检查合成PNG的base64在全文诊断里再次出现；不用真实屏幕图。
- [ ] 红测试 `large_image_diagnostics_do_not_duplicate_base64`、`binary_resource_budget_still_applies`、`normal_text_result_remains_faithful`、`structured_content_and_unknown_blocks_are_not_silently_dropped`、`partial_isError_false_stays_succeeded`。
- [ ] 运行 `pnpm exec vitest run tests/mcp-proxy-tool.test.ts --maxWorkers=1`确认新断言红。
- [ ] projectImage继续直传；在safeStringify/boundRawResult之前生成诊断视图，已被images消费的image.data改为明确omitted/mimeType/decodedBytes摘要，记录原始范围变化。**不是删history图片，也不是把全量rawResult伪称仍完整。**未知块、unsupported image/resource blob保持原来预算和保真范围，不递归粗暴删任意data字段。
- [ ] 原text 50KiB/2000行、details16KiB、binary10MiB等预算不改；保持原大文本fullOutputPath含原文本，不把整个mcpResult不分情况取消落盘。
- [ ] 转绿，再运行全部现有MCP-focused tests与Task10链路。这个改动修通用结果问题，不加screen专用工具分支。

**Exit:** 模型/journal仍收到图像，diagnostic不再保存第二份支持图片base64，现有其他内容合同不回退。

### Task 12：真实验收、发布安装和交付说明

**上游检查点：**在发布前逐文件核对两个上游的 license/NOTICE 和实际复制差异；README 必须链接两个项目并说明“哪些实现借鉴、哪些能力明确未采用”。

**Files:** README.md、THIRD_PARTY_NOTICES.md、pyproject/uv.lock的已验证冻结值；本地验收报告；不增加生产服务/自动登录计划任务。

**Interfaces:** 消费Task9批准的criteria及复测、Task10/11回注证据与Task6–8支持矩阵；产出安装后的同一stdio CLI合同、锁定wheel/依赖和准确的README支持声明，不另定义工具接口。

- [ ] 实施前后对比git status；仅计划文件有新增/变更，用户dirty文件保持。
- [ ] 执行包pure/desktop测试、Uina focused tests、类型/边界、wheel构建及安装后同一工具握手。venv开发成功不是wheel安装成功。
- [ ] 通过Task9尺寸与硬延迟gate；main task尚有PrintWindow/browser失败不能只凭Screenshot成功宣布整个需求完成。
- [ ] 用隔离会话和已获授权的视觉Provider完成设计14.4节八个无Skill任务；记录tool选择、调用数、歧义修复、partial理解与重观察次数。Provider未验证明确写unverified，不改用户模型设置强行证明。
- [ ] 默认值冻结/lock确定/界限已说明后build wheel；测试机器离线或固定环境安装wheel，使用解释器绝对路径配置stdio，不生产启动时uvx拉最新版。
- [ ] README明确raw尺寸请求、partial而非工具失败、surface/visible、page非DOM、无焦点操作、图像将进入Uina历史/Provider、支持平台与未验证范围。
- [ ] notices逐文件列出上游project+commit+文件+许可证+改写范围，并附本指导第1.4节对应URL；如果只是学习行为而未复制代码，也记录“只借鉴行为”及拒绝直接复制的理由。UIA库Apache-2.0等不能被MIT根许可证覆盖；不复制上游图片/真实用户日志。
- [ ] 用户要求commit时才选择性stage产品/测试文件，中文subject，提交前重新验证；不提交proposal、截图、credentials、隔离session或用户其他dirty文件，不推送除非要求。

**Exit:** 三工具需求、发布安装、真实支持矩阵、默认尺寸和延迟门都有对应证据；未通过项明确阻断交付声明，未测平台/Provider保持unverified。

## 4. 固定验证命令与“通过”的含义

以下是实施后的命令，不是本轮已执行证据。执行脚本必须逐命令检查 `$LASTEXITCODE`；PowerShell不因前一条失败自动停下。

```powershell
# 包锁定安装；--frozen确保lock与pyproject一致
uv sync --project $Screen --python 3.12 --group dev --frozen
& $Py -m pytest (Join-Path $Screen 'tests') -m 'not desktop and not provider' -q
# 原生桌面验收需用户明确允许当前测试画面
& $Py -m pytest (Join-Path $Screen 'tests\desktop') -m desktop -q
# 包发布物，输出到已忽略的本地artifact目录
uv build --project $Screen --out-dir (Join-Path $Screen '.artifacts\dist')
# 现有Uina门和新链路
pnpm exec vitest run tests/mcp-config.test.ts tests/mcp-catalog.test.ts tests/mcp-proxy-tool.test.ts tests/mcp-server-manager.test.ts tests/mcp-extension-loading.test.ts tests/mcp-stdio-real.test.ts tests/image-content.test.ts tests/mcp-screen-roundtrip.test.ts --maxWorkers=1
pnpm exec tsc -p tsconfig.build.json --noEmit
pnpm check:boundaries
```

安装后验收单独使用本包被忽略的目录，不覆盖开发venv。通过lock导出第三方依赖，再安装wheel，避免editable源码掩盖遗漏文件：

```powershell
$InstallEnv = Join-Path $Screen '.artifacts\install-smoke'
$LockedDeps = Join-Path $Screen '.artifacts\locked-runtime.txt'
uv export --project $Screen --frozen --no-dev --no-emit-project --output-file $LockedDeps
uv venv --python 3.12 $InstallEnv
$InstallPy = Join-Path $InstallEnv 'Scripts\python.exe'
uv pip sync --python $InstallPy $LockedDeps
$Wheels = @(Get-ChildItem -LiteralPath (Join-Path $Screen '.artifacts\dist') -Filter '*.whl')
if ($Wheels.Count -ne 1) { throw 'Expected exactly one wheel for this acceptance run' }
uv pip install --python $InstallPy --no-deps $Wheels[0].FullName
# smoke脚本以此解释器启动stdio，不以开发环境的Python替代：
& $Py (Join-Path $Screen 'scripts\smoke.py') --python $InstallPy --tool ListTargets --args '{}' --check-only
```

旧wheel使计数不为1时暂停，指定本轮正确产物或另用本次唯一out-dir，不递归删除未核对的路径。安装venv必须在仓库外cwd再跑stdio/smoke，确认不是从开发src意外import；测试代码记录安装后模块__file__位于install-smoke，而不是src。

全量 `pnpm typecheck`、`pnpm test`、`pnpm build` 也应在收尾执行；用户已有dirty导致失败要单列，不能把focused通过冒充全量通过。根build会清dist且native可能被运行Uina占用，先确认是否影响用户运行；需要隔离构建时复用既有工具，不未经许可中断用户进程或删native文件。

| 证据 | 能宣称 | 不能宣称 |
| --- | --- | --- |
| pure pytest / fake runner | 合同、聚合和输入逻辑通过 | 真实桌面能截 |
| real SDK stdio with fake facts | MCP协议通过 | UIA/PrintWindow实际可靠 |
| real desktop tests | 对应机器/应用捕获与语义通过 | 所有Windows/所有应用支持 |
| Uina localhost wire + reopen | 图片/正文/恢复链路通过 | 真Provider已接收/识图 |
| real Provider and no-Skill tasks | 所测Provider接收与任务表现 | 未测模型也支持 |
| frozen gate rerun | 该环境/条件下延迟达标 | 任意机器固定SLA |

README可写所有工具完整合同，但每项未验证能力显式标出，不编造安装后的成功说明。

## 5. 必须解决的empirical决策，不允许开发者自己猜

| 决策 | 收集证据 | 冻结时点 | 未决时怎么办 |
| --- | --- | --- | --- |
| 默认长边 | 1920/2560/original真实Provider矩阵、读字与重复观察成本 | Task9/12发布前 | 开发1920明确candidate，release失败 |
| Screenshot P50/P95数值 | 初测+产品目标+场景条件 | 优化最终候选复测前 | 可以继续功能，不称“快速已验收” |
| PrintWindow主要应用支持 | 实际图像，非BOOL成功 | Task6窗口切片 | 窗口切片阻断，评审WGC或缩scope |
| 常驻capture必要性 | worker/import比例与gate失败 | Task9 | 没证据不建pool/manager |
| Python候选依赖组合 | lock、stdio与真实UIA | Task1及原生任务 | 单项修正，不批量浮动升级 |

这些不是空白placeholder：明确了候选、实验、责任和阻断条件。用户审批尺寸/性能门限不意味着授权修改真实配置、持续观察或扩大scope。

## 6. 实施覆盖表与交付记录

| 设计范围 | 对应任务 |
| --- | --- |
| 三工具/共同Target/schema/无Skill描述 | 1、2、5 |
| region/负坐标/DPI/display/目标生命周期 | 2、4、6 |
| surface/visible/不抢focus/cursor | 4、6 |
| UIA文字状态滚动/预算/密码/partial | 1、7 |
| browser页面来源/IA2/无DOM承诺 | 8 |
| 本机stdio/取消/原生阻塞回收 | 3、5 |
| 默认有限图像成本与显式original | 4、9、12 |
| backend诊断与模型认知分离 | 1、5、10 |
| Uina代理/Provider wire/journal | 10、11 |
| 延迟硬gate与按证据快路径 | 3、9、12 |
| 隐私/依赖/许可证/发布物 | 1、11、12 |

每Task结束记录：变更文件、红测试名字与失败原因、绿命令及输出、实测范围、残留风险。最终报告列未通过门，不以“代码写完/工具已发现/测试skip”当功能交付完成。

## 7. 一手资料与版本研究记录

上游截图/UIA/浏览器文件及固定commit链接在本指导第1.4节和设计附录B，开发者复制前必须读被复制文件的实际代码与license。不能只引用仓库首页或README声称“已借鉴”。当前guide专门补充官方SDK/依赖发布资料：

- 官方SDK v1.30.0 [Server list/call](https://github.com/modelcontextprotocol/python-sdk/blob/v1.30.0/src/mcp/server/lowlevel/server.py)：显式CallToolResult返回路径与validation。
- 官方SDK v1.30.0 [FastMCP result conversion](https://github.com/modelcontextprotocol/python-sdk/blob/v1.30.0/src/mcp/server/fastmcp/utilities/func_metadata.py)：不要盲信自动schema能表达全部合同。
- 官方SDK v1.30.0 [stdio](https://github.com/modelcontextprotocol/python-sdk/blob/v1.30.0/src/mcp/server/stdio.py)：协议传输，不自制wire。
- [MCP 1.30.0发布metadata](https://pypi.org/pypi/mcp/1.30.0/json)。当前PyPI也有2.3.0；本guide故意固定已读源码的1.30.0，不表示最新版更差。
- [Pillow 12.3.0](https://pypi.org/pypi/Pillow/12.3.0/json)、[uiautomation 2.0.29](https://pypi.org/pypi/uiautomation/2.0.29/json)、[comtypes 1.47](https://pypi.org/pypi/comtypes/1.47/json)。发布metadata只证明可查版本与声明，不证明本项目组合验收。
- [comtypes 1.47官方wheel及发布metadata](https://pypi.org/pypi/comtypes/1.47/json)：本轮在内存中读到其import-time CoInitializeEx使用sys.coinit_flags；未安装或修改运行环境。
- [uiautomation公共源码](https://github.com/yinkaisheng/Python-UIAutomation-for-Windows/blob/master/uiautomation/uiautomation.py)：读取公共Control/Pattern/COM接口；master可能漂移，以安装后2.0.29内容为执行权威。

本指导不需要修改设计才能开始pure合同测试；官方low-level注册是显式的SDK落地校准，能力/边界不变。若执行时发现设计要求真正无法实现，回到设计评审，不由开发计划暗中删需求或推断成功。
