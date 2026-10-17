# Uina 桌面感知 MCP 设计

> 当前状态（2026-10-14）：`.uina/mcp-servers/screen-mcp/` 已有 Server、工具和 UIA/浏览器观察代码，见 [IMPLEMENTATION_STATUS.md](../../../../.uina/mcp-servers/screen-mcp/IMPLEMENTATION_STATUS.md)。本设计的核心代码切片已实现；真实桌面采集、真实视觉 Provider、默认尺寸与实际延迟门仍未验收。  
> 形式：独立、本地 stdio MCP Server；Windows 10/11 x64 优先。  
> 核心：ListTargets、Screenshot、Snapshot；只观察，不操作桌面。  
> 名称暂定：`uina-screen-mcp`，简称 screen server。  
> 2026-10-05 修订：部分观察的对称结果语义、默认图像尺寸策略、诊断与认知信息分离、Screenshot 延迟硬验收。

## 1. 设计结论

**把“看哪里”和“看多深”组合起来，形成一套统一的桌面观察工具，而不是拼接三个项目接口。**

```text
看哪里：整个桌面 / 指定显示器 / 区域 / 当前窗口 / 指定应用窗口
看多深：Screenshot（图像） / Snapshot（图像 + 可访问语义）
不明确：ListTargets（显示器和窗口发现）
```

- 学 Windows-MCP 的 Screenshot / Snapshot 分层、坐标处理、语义树组织、浏览器可访问结构和工具描述。
- 学 open-computer-use 的 `get_app_state`：围绕一个确定窗口组织图像、文字、控件、焦点和选中状态。
- 不独立增加 `get_app_state`：`Snapshot(target=window)` 就是我们的应用状态入口。
- 不依赖 Skill。用途、参数、结果和恢复路径必须在 MCP description / schema / result 中自解释。
- 不做 World、Provider Registry、桌面控制系统或通用跨平台框架。
- 复用 Uina 现有 MCP 接入；只修复真实调用暴露的缺口，不顺便重写 MCP 系统。

成功标准不是“文件生成了”，而是：**目标明确、画面可用、语义有来源、缺失不伪装、模型确实收到结果，过程不偷偷操作用户桌面。**

## 2. 第一性原则、系统约束和非目标

### 2.1 用户真正需要什么

Uina 需要自主获取当前机器的视觉上下文，并在需要时获得结构化界面信息。例如：

1. 看当前屏幕有什么。
2. 观察某个应用窗口，不读取无关窗口内容。
3. 精确查看某块区域，降低图像尺寸和无关信息。
4. 理解窗口里的文字、选项、按钮状态和滚动区域。
5. 理解浏览器当前页面的可访问内容，而不只能猜像素。
6. 选择目标和纠正调用不依赖隐藏教程或 Skill。

### 2.2 有价值的系统边界

```text
Uina：工具发现、调用、取消、历史、模型请求、统一工具状态
MCP Server：目标解析、Windows 捕获、语义读取、图像编码、结果表达
Windows/应用：提供屏幕像素与辅助功能事实，可能拒绝或缺失
模型：解释图像和语义、决定是否进一步观察
```

MCP 的价值是隔离平台依赖和生命周期，并复用标准图像结果；不是因为上游恰好用了 MCP。Server 不理解 Subject / Session，不复制 Uina 的权限系统。截图完成与模型识图成功是不同边界。

### 2.3 明确不纳入

点击、键盘、拖拽、滚动执行、应用启动、窗口聚焦/恢复/移动、PowerShell、文件系统、注册表、剪贴板、OCR 服务、真正 DOM/CDP 浏览器控制、录屏、持续监听、后台自动截图、自动稳定检测、插件市场和长期桌面记忆。

**“可交互”和“可滚动”是观察到的属性，不意味着工具执行交互。**

## 3. 研究基线：事实与未验证边界

### 3.1 上游固定版本

本轮通过 GitHub 重新确认两个 main 的 commit，并对固定版本源码进行审查：

| 项目 | 本次参考 commit | 主要定位 |
| --- | --- | --- |
| open-computer-use | `93b817501e0b9fa04fba155face2630bfcd0322e` | 跨平台、面向应用的 Computer Use |
| Windows-MCP | `8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3` | Windows 桌面状态与操作工具集 |

这是源码研究，不是运行上游二进制后的桌面验收。本文不使用“覆盖百分比”或用户量作为可靠性证据。

### 3.2 值得采用与必须修正的源码事实

| 已核实事实 | 设计后果 |
| --- | --- |
| Windows-MCP Screenshot 跳过 UI Tree；Snapshot 提供 richer state [W1] | 两个明确工具，避免一个巨型 mode 工具和无谓语义开销 |
| Windows-MCP 快速路径甚至可以跳过完整窗口枚举 [W2] | Screenshot 不因“顺便给完整状态”而变慢 |
| Windows-MCP backend 有 DXCam/Pillow/可选 MSS；结构检测不拒绝合法黑图 [W3] | 学 fallback 和图像结构检查，不复制 backend registry 或黑图猜测 |
| Windows-MCP region 校验允许部分越界，只拒绝无交集；README/description 更强的越界承诺不能直接视为源码保证 [W2] | 我们单独定义严格区域范围，避免黑色填充被误当实际桌面 |
| Windows-MCP 所谓 DOM 主要是 UIA RootWebArea 和 Firefox MSAA/IA2 [W4][W5] | 使用 `scope=page`，报告来源；不命名为真正 DOM |
| Windows-MCP password 分支标注密码，但仍存在通用 value 读取路径 [W4] | 我们在读取 value/TextPattern 前排除密码控件，不只抄标记 |
| open-computer-use Windows `Capture-WindowPngBase64` 用 `CopyFromScreen`；应用选择有 First 1 [O1] | 不能把桌面裁剪冒充独立窗口捕获，不能继承歧义选第一个 |
| open-computer-use macOS 使用独立窗口 ScreenCaptureKit，同时恢复路径可能激活/取消最小化 [O2] | 学图像与语义组织，不继承有副作用的恢复策略 |
| PrintWindow 是同步、可能阻塞且依赖目标应用绘制的 API [M1] | 不承诺任何窗口都能后台捕获；使用可终止任务进程，不阻塞 MCP 服务 |
| Pillow 11.3 的 window 参数底层是 GetDC/BitBlt，并非 PrintWindow [P1][P2] | API 有 window 参数不证明能获得遮挡无关的窗口表面 |

Windows-MCP 最新参考 commit 修复 ctypes 共享绑定污染导致 GetCursorPos 失败的真实问题 [W6]。这提醒我们**不要因为有大量成熟代码，就搬进截图不需要的控制 overlay 和全局绑定**。

### 3.3 Uina 当前源码事实

基线 HEAD：`8467fc262d690a5d968a411a8b6fae02b56bac9a`，附带用户已有 dirty changes；其中 `src/agent/context.ts` 存在用户修改，本任务不改它。

已读取必需的 dev 基线、当前 runtime 相关段落，以及真实调用链：

```text
.uina/extensions/mcp/proxy-tool.ts
  -> output-guard.ts
  -> ToolResult.images / result / details
  -> AgentMessage / SessionEntry
  -> src/agent/context.ts convertToLlm
  -> src/ai/gateway.ts / providers.ts
```

结论：

1. Uina 已有 single-proxy MCP：`list/search/describe/call/status`；工具全名为 `server.tool`。
2. `describe` 展示完整 description / inputSchema / outputSchema / annotations；list 和 search 只显示描述摘要。
3. PNG 等 MCP image 已进入 `images[]`；核心 ImageContent 和三个 Provider adapter 已存在。
4. **structuredContent 进入 details，不自动进入模型文本。**`convertToLlm` 保留 tool content/images/details，但当前 Provider wire 构造只消费正文和图片，不自动序列化 details 为模型输入。
5. MCP Output Guard 目前文本预算为 50 KiB / 2000 行，details 预算 16 KiB；超过预算会摘要/落盘。
6. 原始 MCP result 超过 16 KiB 时会落临时文件；包含截图的 raw result 可能因此落盘。canonical history 也会保留图片。不能宣称“截图只在内存，绝不保存”。
7. 现有图片输入能力为 false 时会报错；未知时不等于已确认模型支持视觉。

本轮实际执行：

```text
pnpm exec vitest run tests/image-content.test.ts tests/mcp-proxy-tool.test.ts tests/mcp-stdio-real.test.ts --maxWorkers=1
3 files passed / 52 tests passed
```

文档自检：Markdown fence 闭合；9 个 JSON 示例对象可解析；附录 Target schema 经本仓库 AJV 编译并通过 7 个正例、7 个反例；文档无未决占位项。完整工作树 `git diff --check` 命中用户已有 `profiles/uina-main/persona.md` 末尾空行，不属于本文；本文单独的空白检查通过。

本文位于项目约定的本地 proposal 目录；`docs/proposals/` 被现有 .gitignore 忽略。本任务不改变忽略规则、不强制加入 Git、不提交或推送。

这是当前 checkout 下图片合同、MCP 投影与 stdio fixture 的证据；**未验证真实桌面、真实视觉 Provider 或模型识图质量**。本任务只增加设计文档，不实施功能、不修改真实用户配置和会话。

## 4. 接口决策：三个工具，一套目标

对外名称：`ListTargets`、`Screenshot`、`Snapshot`。在 Uina 中例如 `screen.Screenshot`。不增加大小写别名或同义工具。

| 工具 | 主任务 | 默认 | 不执行 |
| --- | --- | --- | --- |
| ListTargets | 发现显示器/窗口 | kind=all | 截图、UI Tree、操作 |
| Screenshot | 快速图像观察 | 完整桌面，PNG，经真实 Provider 矩阵确定的有限长边 | UI Tree、浏览器提取 |
| Snapshot | 图像 + 可访问状态 | 与 Screenshot 相同目标；includeImage=true；scope=window | 点击、输入、滚动、启动 |

**两种观察工具省略 target 都是完整虚拟桌面。**不让同样的参数因为工具不同而偷偷改变观察范围。想聚焦当前窗口，只需显式 `target={kind:active_window}`；不需要额外 discovery 回合。

全桌面 Snapshot 不代表扫描所有隐藏窗口：只读取当前交互桌面、目标显示范围内的非最小化顶层窗口，逐窗口分组。模型应按需缩小目标，但服务不能无声把 desktop 请求改成 active window。

### 4.1 Target 的五种形态

| kind | 所需字段 | 语义 |
| --- | --- | --- |
| desktop | 无 | 当前交互会话中所有显示器的包围矩形 |
| display | id | ListTargets 返回的当前显示器设备标识 |
| region | rect | 虚拟桌面物理像素中的 `[left, top, right, bottom]` |
| active_window | 无 | 调用开始时解析的前台顶层窗口；之后固定该窗口 |
| window | ref 或 match，二选一 | 一个明确顶层窗口，不是进程的所有窗口 |

示例：

```json
{"target":{"kind":"desktop"}}
{"target":{"kind":"display","id":"display-1"}}
{"target":{"kind":"region","rect":[-1280,100,-400,800]}}
{"target":{"kind":"active_window"}}
{"target":{"kind":"window","ref":"w-a731"}}
{"target":{"kind":"window","match":{"app":"chrome.exe","titleContains":"Uina"}}}
```

- 每个 kind 只接受自己字段，未知字段报参数错误，不设优先级链。
- window 的 ref 与 match 互斥；match 至少有 app 或 titleContains。
- app 按执行文件名或显示名做大小写无关的精确匹配；titleContains 做大小写无关子串匹配。不是任意模糊搜索、正则或查询 DSL。
- 0 个匹配：target_not_found；1 个：执行并回显目标；多个：target_ambiguous + 候选，绝不取第一个。
- 不通过进程 MainWindowHandle 推断一个应用只能有一个窗口；以 EnumWindows 等顶层窗口枚举为基础。
- desktop 无显示器：明确失败，不生成空图。显示器之间的无显示区域按画布留空并在 displays/bounds 中可辨认。

### 4.2 Window ref：小字典，不做实体系统

MCP 进程维护一个小的临时 `ref -> HWND + PID + process creation identity` 映射。同一存活窗口可以复用 ref。每次执行重新核对身份和窗口状态；关闭/进程变更则失效，不能因为 HWND 被复用就观察另一个窗口。

- 标题变化不必让 ref 失效，但结果返回新标题。
- server 重启后 ref 失效，重新 ListTargets；不持久化句柄、不跨会话恢复。
- 显示器 id 来自设备枚举；热插拔后重新验证，不把顺序当永久身份。
- 不宣称跨主机/跨重启“稳定引用”，不增加 WindowRegistry 服务。

### 4.3 区域与坐标

- 所有输入 rect 和输出 bounds 均为虚拟桌面**物理像素**，左上包含、右下不包含。
- 允许负 left/top；right>left，bottom>top。
- 区域必须完全包含于当前虚拟桌面的包围矩形，并与至少一个显示器相交。部分越界报 invalid_region，不偷偷裁剪或用黑色补齐。
- 全桌面/跨屏范围中真实显示器间的间隙可以留空，不被当作捕获失败。
- DPI 只作为布局事实返回，不再次乘进已经是物理像素的 bounds。
- 初始化时统一 DPI awareness；显示器、窗口、UIA bounds 与像素空间需要在真实混合 DPI 环境校验。

## 5. 参数：常用少，细节按需

不加空的 options/delivery 嵌套，不提供 backend 给模型选择。

### 5.1 ListTargets

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| kind: all/displays/windows | all | 选择清单 |
| app: string | 无 | 与 match.app 同样的精确过滤 |
| titleContains: string | 无 | 窗口标题子串过滤 |

app/titleContains 与 kind=displays 同时传入时报告 invalid_arguments，不无声忽略。

返回：display id/name/primary/bounds/workArea/dpi/scale；窗口 ref/app/title/pid/bounds/foreground/minimized。未能读取某个字段用 null，并说明原因。**不预先声称 capturable=true、semanticTree=true**：列表不是捕获探针。

### 5.2 Screenshot

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| target | desktop | 第 4 节统一目标 |
| captureMode: surface/visible | surface | 只用于 window/active_window，见第 6 节 |
| includeCursor: boolean | false | 在桌面像素路径叠加实际光标；不默认画高亮 |
| maxDimension: positive integer 或 original | 经验证的有限长边；数值经第 5.4 节验收后冻结 | 仅缩小、不放大；original 显式保留原尺寸；省略不再等于原尺寸 |

captureMode 默认值只在窗口目标解析时应用；desktop/display/region 固定是桌面像素捕获，显式传 captureMode 则报 invalid_arguments。

PNG 是唯一首版编码，不加入 JPEG quality、格式矩阵、网格、动画或 flash。默认尺寸服务于常见观察任务；它控制输入规模，不保证固定字节数或固定 Provider 费用。始终返回 originalSize/outputSize，不隐藏缩放；显式 original 仍可保留原尺寸。

### 5.3 Snapshot

包含 Screenshot 的参数，额外提供：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| includeImage: boolean | true | false 时仅取语义，不捕获图像，适合不支持视觉的模型 |
| scope: window/page | window | window 包括窗口 UI；page 聚焦浏览器页面可访问结构 |
| maxNodes: positive integer 或 all | 1200 | 单次查询的遍历节点预算；all 不设置节点预算 |
| maxTextChars: positive integer 或 all | 500 | 每条文本/值的返回长度；all 返回取得的完整文本 |

预算针对**访问节点**而不只是最终输出元素，避免树里无输出循环让预算失效。分别报告 node/text 的截断；默认值是可调成本策略，不是安全容量上限。

全桌面预算按本次请求全局计数，先前台窗口再按 Z-order 遍历其他目标窗口；返回 visited/returned、已完成与未访问 window refs。预算耗尽的窗口标为 not_visited，不伪装空树；模型可针对指定 ref 再次查询。单窗口用同一预算，避免全桌面被某个大型窗口无限占用。

遍历使用 visited identity 防循环，不额外引入硬深度限制；时间界限独立负责阻塞恢复。maxNodes=all 不取消任务超时或 Uina 原有 Output Guard。

- scope=page 必须是单窗口目标（window/active_window）；desktop/display/region + page 报 scope_requires_window，提示选一个浏览器窗口。
- 非浏览器或没有文档子树时不无声退回整个窗口，报告 page_structure_unavailable 并保留已获得图像。
- includeImage=false 不接受 includeCursor/maxDimension/显式 captureMode；避免无效参数看似生效。

### 5.4 默认图像尺寸：先定原则，再通过实测冻结档位

默认不采用原尺寸截图，而采用足够清晰、成本可预期的有限长边。**1920、2560 与 original 是首轮比较候选，不是已经验证的默认值。**Screenshot 与带图像的 Snapshot 使用同一默认档位；不增加 fullResolution、qualityPreset 或第二套默认选择参数。

实施在发布前通过真实 Provider 矩阵冻结一个默认数值，注册 schema 的 default、参数 description、README 和测试期望必须同时写入该值，不能发布一个“看情况”的默认。固定版本运行时不根据模型猜测或上一轮费用偷偷改变默认尺寸。首个切片可先用候选档位做对比，但不能据此宣称最终默认已通过验收。

比较至少包含：

- 2560×1440、4K 和多屏桌面；窗口/区域的实际小字、代码、错误信息与按钮标签。
- 编码后 PNG 字节数、缩放/编码耗时和 Uina 可用结果的延迟。
- 支持范围内真实视觉 Provider 的接收、解释质量和可取得的 usage；未知费用/视觉能力保持未知。
- 连续观察的 history/journal 增长，以及模型为读清内容发起的重截图次数。

有限长边不能保证多屏小字可读；布局观察后优先聚焦窗口或区域，必要时显式 `maxDimension=original`。不自动切成多张图片，不静默更改观察目标，不把“Provider 会再次缩放”当作本地尺寸策略无关紧要的理由。

不要求穷举所有 Provider 才能交付，但必须声明实际验收过的 Provider/模型、测试条件、选定档位和未验证边界。默认缩放是已公开的输出策略，不是 observation 的缺失：按约定缩放且返回实际尺寸时仍可为 ok。

## 6. 应用窗口：两种表面，不偷换需求

### 6.1 surface：窗口自身绘制结果

window/active_window 默认 surface。首版 Windows 用薄的 Win32 PrintWindow 路径（完整窗口，不默认仅客户区；获取窗口 rect 后按实际画布返回）。API 失败返回 window_capture_failed，不偷偷切换桌面裁剪。

这提供尽力的独立窗口捕获，但**不保证 GPU/视频/受保护/最小化窗口都有可用内容**。PrintWindow 返回成功不等于内容已由我们验证；不靠黑图猜测失败。结果默认文本只报告 surface=window_render 及相关内容保证边界；backend=printwindow 保存在结构化 diagnostics，不要求模型理解实现机制。

不将桌面裁剪、Pillow(window=...) 或 PrintWindow 统称“真实 framebuffer”。后续若有具体应用无法满足，再加入 HWND 定向的 Windows Graphics Capture；不提前同时维护三套窗口后端。

PrintWindow 的兼容性是第一轮真实验收门。如果 Chrome/Electron 等主要目标无法给出可用内容，surface 能力不能宣告达标：改为 Windows Graphics Capture 后再验收，或者明确缩小支持范围，不能用 visible 悄悄补位。

### 6.2 visible：窗口区域内的桌面像素

调用方显式 `captureMode=visible` 才允许按窗口范围捕获屏幕。

- 可能包含遮挡窗口，是“屏幕上这个矩形”，不是目标窗口自己绘制的内容。
- 最小化/完全出屏：失败；部分出屏：捕获交集并明确 clipped=true、实际 bounds，不伪造出屏像素。
- 不恢复、不聚焦、不移动窗口。
- 原生像素 backend 的正常 fallback 可以更换，但不得改变 visible/surface 语义。

### 6.3 图像与语义可能不一致

visible 图像受遮挡，UIA 可能返回底层目标窗口的控件。返回固定说明：`semantics represent the target accessibility tree, not an occlusion-verified reading of every pixel`。UIA IsOffscreen=false 不能证明没有被别的窗口挡住。

surface 图像也不保证和 UIA 同步。先固定窗口身份，再读取图像/语义，记录各自时间；结束时检测身份和 bounds 变化，报告 geometry_changed。检测不了的内容变化保持未验证，不伪造原子 Snapshot。

### 6.4 光标

桌面像素路径按 cursor hotspot 和捕获原点叠加真实光标，单独返回 screen 坐标。surface 首版不包含真实桌面光标；显式要求 includeCursor=true 时报告 cursor_not_supported，不画一个假光标充数。

## 7. Snapshot 语义：可理解，而不是 COM 数据转储

### 7.1 首版取得什么

按窗口分组，保留必要结构父节点，统一元素表：

- 本次快照内 id、parentId、windowRef。
- role、name、可公开的 value/text、bounds。
- enabled/focused/selected/checked/expanded/readOnly/isPassword；未知字段不猜 false。
- 可访问的 ScrollPattern：horizontal/vertical 与已知 position；未知为 null。
- 选中文本按需来自现有 TextPattern，不能通过复制到剪贴板取得。

id 只用于这次结果的阅读和对应，不承诺跨快照可点击的 element handle。不建立控件注册表，不接收动作调用。

按正常遍历顺序和父子结构呈现；页面、面板、标签栏、按钮、输入框、正文都进入**同一语义表示**。不同时返回 interactive/text/semanticTree 三套重复列表。滚动属性属于元素，不另复制一棵滚动树。

### 7.2 浏览器 page 模式

学习 Windows-MCP 的页面子树提取：

- Chrome/Edge 优先 UIA Document/RootWebArea。
- Firefox 的同一目标窗口在 UIA 无页面内容时按需使用 MSAA/IAccessible2。
- 用角色、名称、文字、链接、状态和层次呈现页面；不输出网页源码、选择器、JS heap 或网络响应。
- 顶层 document 对应目标窗口当前页面，嵌套 frame 保留父子关系；多个页面根不能确定当前者时报告 unavailable，不默认选第一个或读取全部后台标签页。
- source 明确 windows_uia / browser_uia / browser_msaa_ia2；不能笼统声称 DOM。
- IA2 读取不到滚动状态时为 unknown/null，不复制上游为了其他工具而填 false 的占位状态。
- 不启动调试浏览器、不改用户浏览器配置，不修改辅助功能开关、不注入脚本。

### 7.3 区域查询和可见性

desktop/display/region Snapshot 先选与范围相交的当前顶层窗口，再遍历/筛选范围内元素。不是先扫描全部窗口再过滤输出。

- 首版返回 provider 标记非 offscreen、bounds 与范围相交的元素，保留必要父节点。
- 输出 reportedOnscreen 及来源；不宣称通过像素证明可见。
- unknown bounds 或零尺寸但有重要结构/文本的节点可以保留并注明，不靠面积删除所有信息。
- 这不是完整应用文档读取；虚拟列表未加载项、屏幕外正文可能不存在于返回中。
- 不因为请求一个区域而自动读取其他区域 TextPattern 的整段文档。

### 7.4 密码、文本和异常

- 在 value/TextPattern/LegacyIAccessibleValue 的读取前判断密码标记；密码控件仅返回 name/role/isPassword，省略 value、正文和选中文字。
- 若保护标记无法查询，保留控件结构但跳过 value，报告字段未知；不为一个字段失败丢整个窗口。
- 修复 UIA UTF-16 surrogate，保证标题/emoji 可 JSON 编码。
- 不笼统删除 private-use 字符，它可能是真实文本；仅隔离无法编码数据。
- dead element/property error 按字段或节点结算；一棵树部分读取失败仍返回可用部分。
- 不做“清空界面就说明没有控件”的推断，不无限重试树遍历。

## 8. 返回协议：给模型看，也给程序用

### 8.1 一份观察事实，两种渲染

MCP 返回：

```text
content:
  text: 简短头部 + 紧凑窗口/元素结构 + 明确缺失/截断
  image: PNG（请求且成功时）
structuredContent:
  同一 Observation 的结构化对象（不额外包 observation 层，不包含图片 base64）
isError:
  请求非法、目标解析失败或全部请求组件无有效观察时为 true；部分观察正常返回
```

**不能仅把语义和坐标塞进 structuredContent/details**，因为当前 Uina 模型只看到工具正文和 images。相反，也不机械复制完整 JSON 再输出一套树：从同一对象生成紧凑模型文本和结构化对象，不写两套解释逻辑。

MCP 对 structured output 的兼容建议是额外返回 serialized JSON（SHOULD，而非 MUST）[S1]。本设计明确采用紧凑文本而非再附全量 JSON：现有 Uina 的模型文本预算有限，机械重复结构和 base64 没有认知价值；精准客户端仍消费 structuredContent。这是明确的兼容呈现取舍，不声称紧凑树就是相同 JSON 序列化。outputSchema 定义稳定 Observation envelope；动态树是数组字段。

### 8.2 Observation envelope

- kind：targets / screenshot / snapshot。
- status：此次观察的聚合完整性，ok / partial / failed；不是运行时生命周期状态。
- error：整体失败时的 code/message/stage/nextAction；partial 的组件失败保留在该组件 errors/warnings，不放顶层 error。isError 仍在 MCP 外层。
- target：实际解析目标、窗口身份/标题或显示器列表。
- startedAt/completedAt：UTC ISO 时间；图像/语义分别有 capturedAt/observedAt。
- image：status、surface、bounds、originalSize、outputSize、cursor、clipped；不含模型必须理解的 backend 字段。
- semantics：status、scope、source、nodesVisited、nodesReturned、nodeTruncated、textTruncated、errors、elements。
- warnings：本次有意义的警告；不堆一长串通用免责声明。
- diagnostics：backend、原生错误和阶段耗时等结构化诊断；默认紧凑文本不渲染此块，按排障需要披露。

component status 统一为 ok / partial / unavailable / failed / not_requested。没有图像的 semantic-only Snapshot 用 not_requested，不伪装图片成功。聚合 status 来自请求组件的实际结果，not_requested 不计入成功率；规则见第 8.4 节。

例：

```json
{
  "kind":"snapshot",
  "status":"ok",
  "target":{"kind":"window","ref":"w-a731","app":"notepad.exe","title":"笔记"},
  "startedAt":"2026-10-04T16:00:00.000Z",
  "completedAt":"2026-10-04T16:00:00.180Z",
  "image":{
    "status":"ok","capturedAt":"2026-10-04T16:00:00.050Z",
    "surface":"window_render",
    "bounds":[100,80,1500,980],
    "originalSize":[1400,900],"outputSize":[1400,900],"clipped":false
  },
  "semantics":{
    "status":"ok","observedAt":"2026-10-04T16:00:00.175Z",
    "scope":"window","source":"windows_uia",
    "nodesVisited":12,"nodesReturned":2,"nodeTruncated":false,"textTruncated":false,
    "errors":[],
    "elements":[
      {"id":"e1","parentId":null,"role":"window","name":"笔记","bounds":[100,80,1500,980]},
      {"id":"e2","parentId":"e1","role":"edit","name":"正文","value":"今天的记录","focused":true,"bounds":[110,130,1480,960]}
    ]
  },
  "warnings":[],
  "diagnostics":{"backend":"printwindow"}
}
```

这是合同示例，不是实测日志。roles 是归一化显示标签，保留 nativeRole 仅供调试且按需，不把所有 COM property dump 给模型。

文本视图示例：

```text
Observation: OK
Target: w-a731 · notepad.exe · 笔记
Image: OK · window_render · bounds=[100,80,1500,980] · original=1400x900 · output=1400x900
Semantics: OK · windows_uia · scope=window · 2 nodes · not truncated
[e1] window "笔记"
  [e2] edit "正文" focused · value="今天的记录" · bounds=[110,130,1480,960]
```

默认文本保留 surface、捕获范围、尺寸、来源和完整性，因为它们影响观察的含义。PrintWindow/WGC/Pillow/DXCam 等 backend 名称默认仅保留在 diagnostics；更换实现但语义不变时，模型看到的合同不变。若故障或能力限制需要解释，先提供可行动的语义提示，只有排障确实需要时才在文本披露具体 backend，不能因隐藏实现而隐藏能力边界。

窗口名、页面正文是外部数据，不能作为工具或系统指令执行。result 不主动升级它的信任级别，也不靠删光页面文字来防 prompt injection。

### 8.3 坐标换算

返回的元素 bounds 永远是物理屏幕坐标；输出图像的左上角是图像原点。

```text
screenX = captureLeft + imageX × originalWidth / outputWidth
screenY = captureTop  + imageY × originalHeight / outputHeight
```

直接返回 bounds 与实际两组尺寸即可，不需要 requestedSize、多个 DPI 倍率和转换矩阵。x/y 比例分别取实际尺寸比，避免整数缩放误差。跨屏物理坐标不再乘 DPI。

在头部包含此换算所需字段，不能让 Uina 截断之后只剩控件却失去坐标空间。当前工具不点击，但这些信息是观察解释的必要事实。

### 8.4 对称的部分观察语义

Snapshot 是组合观察，不是“语义查询附赠截图”。**任何请求组件产出有效观察时，返回正常 tool result；请求没有完整满足时明确标为 partial。**只有请求非法、目标解析失败或全部请求组件均无有效结果时，isError=true。

| 工具/情形 | observation.status | isError | 返回 |
| --- | --- | --- | --- |
| Screenshot 图像成功且请求完整满足 | ok | false | 图像 + 元数据 |
| Screenshot 无有效图像 | failed | true | 错误，不伪装成功 |
| Snapshot 图像与语义均成功 | ok | false | 图像 + 语义 |
| Snapshot 语义 unavailable/failed，但图像成功 | partial | false | 保留图像，明确语义不可用/失败 |
| Snapshot 语义成功但请求的图像失败 | partial | false | 保留语义，明确图像失败 |
| Snapshot 至少一部分有效，但语义截断、属性/窗口部分失败 | partial | false | 可用部分 + 缺失范围/原因 |
| includeImage=false，语义完整成功 | ok | false | image=not_requested，不视为缺失 |
| includeImage=false，语义部分有效 | partial | false | 部分语义及未取得内容 |
| 全部请求组件均无有效观察 | failed | true | 错误 + 明确下一步 |
| 参数非法或目标解析失败 | failed | true | 不启动 native 查询；返回错误/候选 |

“有效观察”必须是实际取得的、属于本次请求的图像或语义事实，而不是返回了非空字符串。诊断、错误消息、目标标题或 ref 元数据不能把失败升级为 partial。成功完成查询但得到空语义树，是有效的 ok + elements=[]，只表示该来源未返回元素；无法读取则是 unavailable/failed。窗口聚合时有已读取窗口及失败/未访问窗口为 partial，不丢成功内容。

正常缩放、明确请求的 visible 裁剪等已约定输出处理不自动算 partial；缺失请求组件、未完成语义遍历或内容截断才影响完整性。partial 的 text 第一行必须可见，例如：

```text
Observation: PARTIAL
Image: OK · window_render
Semantics: UNAVAILABLE — the application did not expose an accessible tree.
The image is usable; no accessible controls were obtained.
```

isError=false 仅表示取得了有效结果，不表示全部请求都满足。Uina 仍按 MCP isError 映射自己的五态；聚合 observation.status 与各 component 状态是结果事实，不是新增 ToolResultStatus。上层 succeeded 和 observation partial 可以同时成立。

取消不按上述规则改为成功：MCP 取消优先，回收 native 任务；不能因为取消前产生了图片就覆盖 cancelled 语义。协议非法请求继续交 SDK 处理。

### 8.5 失败码与下一步

只保留实际需要的码：invalid_arguments、invalid_region、target_not_found、target_ambiguous、stale_target、capture_unavailable、window_capture_failed、cursor_not_supported、scope_requires_window、page_structure_unavailable、semantic_unavailable、task_timeout。若单浏览器窗口内无法确定一个当前页面根，使用 page_structure_unavailable 并说明 page_root_ambiguous；不让模型误认为读到了当前页。

- 错误包含 stage、原因、可用候选或 bounds。
- ambiguous 返回 ref 候选，提示重试指定 ref。
- stale_target 提示 ListTargets。
- window_capture_failed 提示显式 visible 模式的语义差异，不自动替换。
- semantic_unavailable 说明已有图像仍可用，不称“没有控件”。

协议非法请求交 SDK 处理；请求非法、目标解析失败或全部请求组件无有效结果的业务失败用 CallToolResult(isError=true)，有有效观察的组件失败按第 8.4 节正常返回 partial。取消由 MCP SDK 传播，Server 在 finally 回收任务进程，不能取消后继续捕获/保存。Client 侧取消返回事实沿用现有 Uina 语义。

## 9. 实现形态：小项目，直接函数

### 9.1 技术选择

**Python + 官方 MCP Python SDK（其 FastMCP 封装）+ Pillow + comtypes/Windows UIA。**

- 固定实际通过测试的依赖版本和 lock；不跟随 Windows-MCP 的整份 pyproject。
- Python 3.12+ 作为拟定兼容目标，依赖/真实 Windows CI 验证后才写正式支持声明，不因上游 main 需要 3.14 就同步抬高门槛。
- 不用 Go + PowerShell + Python 三语言组合；Windows 观察逻辑在一个 Python 包内。
- Win32 枚举和 PrintWindow 用小量 ctypes/pywin32 调用，按实现选择一套，不双份包装。
- UIA 优先正常发布的库/官方 COM 接口；不得为一个截图工具直接 vendoring Windows-MCP 的整套 controls/core/patterns。
- Firefox IA2 只在 page 模式且需要时加载，来源追踪到被复制文件。

Pillow 作为首个桌面像素路径；**不提前带 DXCam/MSS 两套可选依赖**。只有真实 latency 或 RDP 场景证明需要，才选一个追加 fallback，并沿用当前 capture 函数。成熟方案可复用，不意味着 backend 越多越好。

### 9.2 建议源码布局

原方案曾计划将包放入 `packages/screen-mcp/`；实际实现位于 `.uina/mcp-servers/screen-mcp/`。此处保留的包结构仅为当时的设计记录：

```text
pyproject.toml / lock / README / third-party notices
src/uina_screen_mcp/
  server.py        三个 MCP 工具和返回封装
  targets.py       显示器/窗口枚举、解析、小 ref 字典
  capture.py       桌面像素、窗口绘制、光标、PNG
  semantics.py     UIA 遍历与统一元素表示
  browser.py       文档子树与按需 IA2
  worker.py        有界原生查询进程入口
  render.py        同一 Observation 的文本与 JSON 视图
```

这是职责划分，不要求每个小 helper 单独成为文件/类。没有 manager/service/factory/registry 框架，普通函数和数据对象足够。

### 9.3 为什么需要一个任务进程入口

PrintWindow/UIA 可在目标应用内阻塞；线程 future 超时只能停止等待，不能证明 native 调用停止。微软也要求注意 UIA COM apartment/thread ownership [M2]。

因此 MCP 主进程处理协议，首轮基线实现中**阻塞捕获和语义查询运行在可终止的短命子进程**。这是先验证恢复边界的实现起点，不是所有 native query 必须永远冷启动的架构要求：

1. 解析/验证目标。
2. 图像请求：capture 子进程返回 image + metadata；主进程保留结果。
3. Snapshot：semantic 子进程返回统一元素事实。
4. 组合结果，结束/取消时等待并回收子进程。

两阶段分别取结果，使语义超时不会丢失已得到的截图。首轮基线中的目标枚举同样放入短命查询进程，主进程只持 ref 字典和协议状态，避免临时 UIA/COM 调用污染 SDK 线程。主进程通过异步子进程等待保持 MCP 协议与取消可响应；同一时刻的 native 查询先串行执行，避免共享目标/ref/COM 污染，不引入后台任务队列 API。等待执行的请求在开始 native 工作前再次检查取消信号和窗口身份。任务进程不再运行 MCP，不使用网络，不写用户临时图片；结构化请求通过 stdin/stdout，不把窗口标题拼成 shell command。COM 在该任务进程的工作线程初始化并释放，不跨线程传递活 COM 对象。

默认运行预算建议 capture 5 秒、semantics 10 秒，作为 Server 启动配置的可调 operational timeout，不是模型工具容量限制；必须在真实桌面测量后确认。超时终止并回收整个任务，不重启整个 MCP、不永久禁用服务、不堆积卡死线程。后台 helper 使用隐藏窗口。

不提前做 worker pool、后台 watchdog、无限重试或长期捕获会话。**Screenshot 延迟必须通过第 14.5 节硬验收**；如果 worker 启动/import 占据主要 P50/P95 或导致门限不通过，必须优化，不得以隔离架构已成立为理由交付慢路径。

优化依次检查：移除 Screenshot 无关的 UIA/浏览器 import、合并无谓的进程往返，再按证据采用一个可重建的常驻捕获 worker 或常驻安全快路径。常驻不等于安全，线程 future 超时也不等于 native 调用停止；候选快路径仍必须通过超时、取消、故障恢复、资源回收和重复调用测试，不把不可中断的调用搬到 MCP 协议主进程。

Screenshot 的快速路径与 PrintWindow/UIA 的高风险路径可以采用不同生命周期。对模型保持统一合同，不要求执行机制为了形式统一而相同；不因某一路优化而预造完整进程管理框架。

### 9.4 返回帧检查和 fallback

结构验证：有效宽高、像素可加载、PNG 可解码、尺寸匹配预期。黑色图像本身合法，不推断 DRM/锁屏/失败。

- API 返回失败明确报告。
- 如果 API 不提供内容真伪信息，则不宣称验证了目标画面。
- 后端失败不改目标，不改 visible/surface，不用旧帧冒充新截图。
- 真正引入 fallback 后，候选逐个有限尝试；不移植上游永久 degraded set，也不无期限自动重试。

## 10. LLM 使用合同：没有 Skill 也可上手

### 10.1 description 的正式草案

MCP description 使用英文，结果保留原应用文字，不要求 UI 系统为英文。决定性用途放在前 60–80 字符，适应 Uina 当前 discovery 摘要。显示名/中文窗口标题按原文匹配；执行文件名匹配不依赖 Start Menu 的英文名称。

**ListTargets**

> List displays and app windows for screenshots or semantic snapshots. Use when the target is unknown, an app has multiple windows, or a previous window ref expired. Returns display bounds and window refs, titles, apps, and states; it does not capture images, inspect UI trees, launch apps, or change focus. Reuse a returned ref within this server session; re-list after it expires. app matches the process/display name exactly, ignoring case; titleContains is a substring filter.

**Screenshot**

> Capture a fast image of the desktop, display, region, or app window. Use for visual context; use Snapshot for text, controls, or scrolling state. No target means all displays; active_window selects the current foreground window once. Window capture defaults to surface (best-effort app rendering); visible explicitly captures screen pixels in the window bounds and may include occluders. Ambiguous app matches return candidates, never choose one silently. Does not launch, focus, restore, move, or interact. Region uses [left, top, right, bottom] in physical virtual-desktop pixels; negative origins are valid. Returns originalSize and outputSize; default uses a validated bounded long edge. maxDimension only downscales; set it to original for full resolution. Cursor inclusion is supported on desktop-pixel captures, not surface captures.

**Snapshot**

> Inspect screenshot plus accessible text, controls, and scrolling state. Uses the same targets and capture modes as Screenshot; no target means all displays. Prefer a window target for focused app state. scope=page requires one browser window and reads its accessible page structure, not JavaScript DOM. includeImage=false reads semantics only. UIA/IA2 may be incomplete or unavailable. If any requested observation is usable, the result is normal with an explicit PARTIAL header for missing components; only invalid targets/requests or no usable observation are errors. Headers show source, failures, and truncation. Image sizing follows Screenshot, including maxDimension=original. maxNodes/maxTextChars can be raised or set to all; host output limits still apply. Element ids are local to this snapshot, not action handles. Does not click, type, scroll, launch, focus, restore, or move windows.

参数 description 提供更精确 defaults 和互斥规则，不要求模型从工具长描述里猜 schema。返回文本指导具体下一步，不每次附整套教程。

### 10.2 常见任务只要一个调用

```text
看看屏幕             -> Screenshot({})
看看当前窗口         -> Screenshot({target:{kind:active_window}})
看记事本界面结构     -> Snapshot({target:{kind:window,match:{app:notepad.exe}}})
看浏览器页面内容     -> Snapshot({target:{kind:active_window},scope:page})
没有视觉模型         -> Snapshot({target:{kind:active_window},includeImage:false})
多个浏览器窗口       -> 读取 ambiguous 候选后重试 ref
不知道哪个显示器     -> ListTargets({kind:displays})
```

以上为调用意图示意，不是非 JSON 语法的实际 wire。窗口唯一时不强制 ListTargets；歧义时不让模型猜。

不采用“每回合必须先 get_app_state”的 Computer Use 动作约束，不要求无任务地重复截图，不伪造 skill loader。

## 11. Uina 接入与必要改进

### 11.1 按现有配置注册，不造特殊适配器

示例采用实际现有配置形状；可执行文件路径由实施时的隔离环境确定：

```json
{
  "mcpServers": {
    "screen": {
      "command": "python",
      "args": ["-m", "uina_screen_mcp"]
    }
  }
}
```

示例要求对应包已经安装且 python 指向正确环境。实际部署使用明确环境的解释器绝对路径或安装后 entry point，避免每次用 uvx 下载最新版。这里不修改真实配置。

沿用全局/项目信任、stdio 启动、关闭和取消。stderr 只写诊断，不打印截图 base64、页面正文和密码；stdout 只写协议。

### 11.2 现有代理中的使用路径

首次：`mcp.list(server=screen)` → `mcp.describe(tool=screen.Screenshot)` → `mcp.call(...)`。

目录和描述已在上下文时直接 call，不设计“每次三步”。三工具均可 describe 获取完整 schema 和规则；不把 server instructions 注入 trusted system prompt。

**首版不增加 expose/direct promotion/自动注册全部远端工具。**先验收通过 existing proxy 的调用体验。若模型确实因摘要或 describe 缺失反复犯错，优先改善现有 generic proxy 描述/发现提示，而非新造注册模式。

### 11.3 本次真正要关注的通用 MCP 缺口

1. 验证 Screenshot text+image 和 Snapshot text+image+structuredContent 都走真实回注，不丢语义文字。
2. 添加 combined MCP→Subject→Provider 本地协议测试，保证图片、正文、工具关联和 source 头部同属一次调用。
3. 针对 **原始 MCP result 大图 base64 的重复落盘**审查 output-guard：若需要改，只保留一次图片事实，在诊断摘要中记录 image mime/bytes，不在全文诊断文件再保存一份 base64；保持原有 trace 的真实范围。此为计划改进，不声称已修。
4. 原有 50KiB/2000行/16KiB budget 不因 screenshot 特批提高。Server 首部必须在截断前给 target/source/partial 信息，末尾与结构化结果给 returned counts；客户端截断独立于 Server 遍历截断，不能合并成同一完整性结论。

不把所有 details 自动注入 LLM，不改 Subject/UI/Host 权威边界，不触碰用户 dirty context 修改。

## 12. 隐私、权限和持久化的准确承诺

- Server 自身不做遥测、不发网络请求，不自动归档图片，不创建截图缓存目录。
- 但调用结果会进入 Uina history/journal；当前 MCP raw-result 诊断还可能产生临时文件。截图可能随后发给用户当前配置的模型 Provider。
- 这是能力的真实数据流，不是“本地 MCP = 数据永不离开本机”。接入说明必须让用户了解。
- 采用现有项目 server trust；不每次截图确认、不增加自造角色/权限矩阵、不读取安全桌面、不自动提权、不尝试绕过应用捕获保护。
- 按需查询，不后台轮询、不监听全局窗口事件。
- Tool annotations：readOnlyHint=true、openWorldHint=false（查询当前本机交互桌面的封闭目标集）。可保留上游惯例的 destructiveHint=false / idempotentHint=true，但按 MCP 定义后二者仅对 readOnlyHint=false 有意义，不拿它们作为此工具的额外安全保证。只读也不意味着两次截图内容相同，注解不是安全授权依据。
- surface 捕获可能通过 PrintWindow 请求目标绘制；它不是“完全零影响”的系统操作，但不主动改变前台焦点和用户输入。

## 13. 对抗式审查结果

| 问题/攻击性反例 | 本设计如何避免自欺 | 保留的不确定性 |
| --- | --- | --- |
| 同应用两个窗口，拿第一个 | ambiguous 候选，不执行 | 用户/模型仍需选择 |
| HWND 复用 | PID/创建身份和窗口重验证 | 极短 TOCTOU 无法完全消除 |
| 窗口被挡，图像和 UIA 不同 | visible 显式、surface 区分、来源说明 | 无像素级遮挡证明 |
| 窗口渲染返回黑图 | 不凭颜色推断失败；应用矩阵验收 | API success 不证明实际内容 |
| 巨大树/循环树 | visited + 可调整的访问预算，截断可见 | all 仍受时间/宿主输出限制 |
| UIA 卡死 | 可终止任务进程，不堆积线程 | 超时值需真实测量 |
| 页面模式读不到网页，退回浏览器 UI | 明确 unavailable，不无声 fallback | 非所有浏览器可用 |
| Firefox滚动状态读不到 | unknown/null，不编造 false | 滚动状态可能未知 |
| metadata保存了但模型看不到 | 所需内容也出现在紧凑 text | 宿主截断仍可能丢末尾 |
| Snapshot语义失败但图像有效 | isError=false，同时 observation=partial；第一行明确缺失 | 正常结果不代表完整满足 |
| 大图默认成本失控 | 有限长边经真实矩阵冻结，original显式请求 | 多屏小字仍需区域/窗口观察 |
| 换backend改变模型认知 | 实现名仅diagnostics，surface/范围/能力边界可见 | API内容质量仍需验收 |
| 隔离worker导致Screenshot很慢 | 端到端P50/P95是交付门，允许按证据优化快路径 | 阈值与环境需先冻结 |
| 模型不支持图像 | includeImage=false，不伪造视觉支持 | 未知 provider 仍需真实确认 |
| “只在内存”但 session保存图片 | 明示 journal/Provider/diagnostic路径 | 临时数据清理不是已完成事实 |
| 复制 MIT项目中 Apache 文件 | 逐文件来源及 notices | 依赖 licenses 要实施时复核 |
| 模型需要 Skill 才懂 | description/schema/result 完整 | 可用性需要真实模型测评 |

奥卡姆剃刀删掉的东西：World、四号 get_app_state 工具、后台观察、完整 DOM、图像 artifact 系统、多级 provider/adapter、backend registry、direct MCP promotion、worker pool、多格式质量矩阵、固定永久降级和默认标注 flash。

保留的复杂性各有现实任务：三个工具区分观察深度/目标发现；surface/visible 区分两种不同事实；一个 worker 入口处理可证明的 native 阻塞；partial/source/bounds 避免把缺失和坐标误当真相。

## 14. 验收：合同、桌面、模型分别证明

### 14.1 Server 自动测试

- 三个工具 description/schema 独立可用，defaults 一致，无外部 Skill。
- target 联合形状正确；ref/match 互斥；错误参数不无声忽略。
- match 0/1/多结果；标题变化；HWND/PID 身份失效；server 重启 ref 失效。
- region 负坐标、完全越界、部分越界、屏幕间隙；混合 DPI 不重复缩放。
- Screenshot 不调用语义提取；includeImage=false 不调用图像捕获。
- 第 8.4 节所有对称聚合组合；not_requested 不计失败；诊断/标题不能制造有效观察；空的已完成语义查询与查询失败分别结算。
- 默认尺寸与正整数/original 请求；原尺寸与输出尺寸准确，不因正常缩放伪造 partial。
- 正常文本不暴露 backend，保留 surface/source/bounds；实现替换不改变 observation 合同。
- 密码读取前过滤；未知状态不变 false；emoji/surrogate 编码。
- maxNodes计访问节点；all不隐藏截断；node/text truncation各自可见。
- UIA/IA2使用同一元素表示；无额外重复树。
- native任务超时/取消/正常退出均回收，无僵尸进程/卡死线程增长。
- MCP协议stdout与diagnostic stderr分离；结束后不继续产生观察。

### 14.2 Windows真实矩阵（必须）

| 场景 | 应验证什么 |
| --- | --- |
| 单屏/多屏/左侧副屏 | 实际范围、负原点、显示器清单、输出尺寸 |
| 100%/125%/150%混合DPI | 截图、UIA bounds、换算共同坐标 |
| 长边缩放与光标hotspot | 不放大；光标位置和输出比例正确 |
| 记事本/设置/Explorer | window surface图像、状态/正文/滚动 |
| Chrome/Edge/Electron | surface真实内容及page结构，不以API成功代替可用 |
| Firefox | page UA/IA2来源和unknown滚动状态 |
| 被挡/最小化/部分出屏 | 不抢焦点；surface/visible按合同结算 |
| GPU/视频/受保护目标 | 能力边界，失败/黑图不冒充已验证画面 |
| RDP/VM断连与重连 | 错误可定位，下一次调用可恢复 |
| 大列表/动态页面/窗口关闭 | partial/identity/geometry变化不静默 |
| native阻塞与取消 | MCP仍响应，任务被终止并回收 |

记录各阶段耗时和样本图；默认尺寸必须通过第 5.4 节真实 Provider 矩阵冻结。Screenshot 冷/暖调用 P50/P95 按第 14.5 节作为硬交付门，而不只是报告，不在设计阶段编造已验证的毫秒数。

### 14.3 Uina协议集成

真实stdioserver或隔离fixture → MCP proxy → ToolResult.images/content → journal/recovery → projection → wire。验证图像尺寸、base64、文本中source/partial/bounds、tool_call_id关联不丢。

文件路径、localhost测试和mock模型只证明本地合同。真实Provider要分别测试imageInput=false/unknown/true；不能为了通过而修改用户真实配置。

### 14.4 LLM可用性

不用Skill，仅三个description/schema：

1. “看看屏幕”：选择Screenshot，不额外拉全树。
2. “记事本里写了什么”：选择单窗口Snapshot。
3. “浏览器页面有哪些按钮”：page模式，明确非DOM。
4. “两个Chrome窗口，找Uina那一个”：正确候选/ref选择。
5. “只看副屏左下角”：正确坐标，无错误静默裁剪。
6. “这个模型不能看图”：semantic-only路径。
7. 语义不可读：不回答“没有控件”。
8. 窗口截图失败：不自动抢焦点，不把visible结果当surface。

验收记录工具选择、调用次数、误选、参数修复和是否识别unknown/partial，不只评估模型最终自然语言是否像成功。

### 14.5 Screenshot 延迟硬验收（首个纵向切片即执行）

**没有约定的门限，或只给一份耗时报告，不算通过 Screenshot 验收。**延迟 gate 与图像可读性、超时/取消恢复 gate 同时满足，不拿低分辨率或不可中断快路径换取假通过。

首轮隔离测试量出分布后，在进入最终验收前冻结测试环境、目标类别、样本量、冷/暖定义和 P50/P95 门限。门限是产品目标，不得测完候选实现后把本次实际值作为门限自动通过；优化后的候选实现按冻结条件复测。尚无实测数据时只声明 gate 未通过，不宣告 Screenshot 已达到“快速”要求。

主指标：Uina 发出 MCP 调用至图像/正文完成结果投影、成为 Uina 可用结果的总耗时。分解记录：

```text
排队/目标解析 + worker启动/import + 捕获 + 缩放/编码
+ IPC/MCP传输 + Uina结果投影
```

- 单独记录 server 冷启动；暖调用仍需记录短命 worker 每次启动的实际成本。
- desktop/display/region 和 window surface/visible 分组；至少覆盖高分屏和多屏，不能只用最小目标的平均值代替 P95。
- Provider 上传/服务端接收/模型推理另测，不混入本机 Screenshot 主指标；同时检查默认尺寸候选的可读性和 journal 增长。
- worker 启动成本为主要瓶颈或整体超标时，按第 9.3 节优化并复测；不为架构统一坚持全部 native 请求短命进程。
- 任何常驻路径也必须通过取消、超时、卡死恢复、进程退出及连续截图的资源稳定性测试；成功样本延迟与失败/取消的收敛时间分别报告。

## 15. 实施切片与交付边界

1. **Screenshot纵向切片**：本地Server、目标清单、desktop/display/region、text+PNG；Uina existing proxy完整回注；首轮尺寸候选与分阶段延迟测量，冻结验收条件后复测；测试+来源说明。
2. **应用窗口切片**：active/window match/ref、surface/visible、窗口变更、PrintWindow主要应用矩阵；不达标则修窗口路径再继续，不偷换语义。
3. **Snapshot切片**：统一UIA元素、文字/状态/滚动、includeImage=false、partial/budget/password；保留截图成功结果。
4. **浏览器切片**：page文档子树、Firefox按需IA2、来源/unknown；不做CDP。
5. **MCP结果审查与真实视觉验收**：combined测试、重复诊断图像落盘问题的限定修正、真实Provider矩阵冻结默认长边、Screenshot硬延迟门通过、无Skill任务评测。

用户批准本设计后再写实施计划。首个Screenshot切片是阶段交付，不得以它替代完整Snapshot/窗口/浏览器需求。每片报告implemented/tested/real-verified边界；不重写用户已有文件，不默认commit/push。

## 16. 复制与许可证

| 来源 | 具体可借鉴 | 不直接搬入 |
| --- | --- | --- |
| Windows-MCP工具层 | Screenshot/Snapshot分工、description中的选工具指导 | 其他18类控制/系统工具、analytics |
| Windows-MCP像素捕获 | 区域/虚拟原点/结构检查、测试案例 | 类自动注册框架、DXCam私有factory、永久degraded set |
| Windows-MCP语义 | 缓存读取、结构父节点、访问预算、状态/选中/滚动 | 控制overlay、watchdog、整套vendor UIA、密码value路径 |
| Windows-MCP浏览器 | 文档子树、Firefox MSAA/IA2 fallback | 虚构DOM/滚动false、浏览器配置修改 |
| open-computer-use | get_app_state的窗口级组合、text+image、坐标、聚焦/选中文字 | macOS自动恢复/activation、action-session、Go+PS封装、First1匹配 |

两仓库根LICENSE是MIT [L1][L2]，但**不代表每个vendor文件都是MIT**：Windows-MCP `uia/core.py` header明确指向yinkaisheng的Apache-2.0代码 [W7]。复制时逐文件追溯并保留适用LICENSE/NOTICE；优先以库依赖使用，不重新vendoring庞大代码。third-party notices记录项目、固定commit、原文件和变更范围。

复制决策的门槛：能独立摘取、解决已确定问题、带入依赖少、可用测试验证。摘不干净的模块学习算法后重写必要小函数，不为“抄得多”引入另一套概念。

## 附录 A：请求 schema 的完整合同与 Target 定义

这些是正式合同，不是引用未定义 `$ref` 的孤立示例。实施时三个Tool.inputSchema均为自包含JSON Schema对象：

- 根 type=object、additionalProperties=false。
- ListTargets使用第5.1节字段；kind省略为all。
- Screenshot/Snapshot在根提供 `$defs.Target`，target引用本地 `#/$defs/Target`。
- Target是五分支oneOf，kind为各自const，分支additionalProperties=false。
- region.rect是恰好4个integer的array；范围关系由运行时验证。
- window分支oneOf `{kind,ref}` 与 `{kind,match}`；match只有app/titleContains且minProperties=1。
- Screenshot与Snapshot默认target由实现解析为desktop，JSON Schema default本身不负责执行。
- maxDimension是minimum=1的integer或const=original；省略使用经第5.4节冻结的有限默认长边。发布的注册schema必须含实际验证过的default数值，不保留“原尺寸默认”。maxNodes/maxTextChars是minimum=1的integer或const=all。
- Snapshot的includeImage/captureMode/scope跨字段限制由schema条件和运行时同时验证；参数错误不启动native任务。
- 结果outputSchema针对Observation envelope，包含聚合status=ok/partial/failed与可选diagnostics；backend仅在diagnostics。所有整体失败也能表达kind/target/error，不只为成功结果定义schema。

Tool descriptions采用第10.1节文本。Source code和schema测试生成同一份defaults，不在README/描述里各抄一套会漂移的默认值。
下面是每个 Screenshot/Snapshot inputSchema 内嵌 `$defs.Target` 的完整定义。根字段来自第 5 节，不让模型遇到脱离上下文的引用：

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {"kind": {"const": "desktop"}},
      "required": ["kind"], "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {"kind": {"const": "display"}, "id": {"type": "string", "minLength": 1}},
      "required": ["kind", "id"], "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {"const": "region"},
        "rect": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}
      },
      "required": ["kind", "rect"], "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {"kind": {"const": "active_window"}},
      "required": ["kind"], "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": {"const": "window"},
        "ref": {"type": "string", "minLength": 1},
        "match": {
          "type": "object",
          "properties": {
            "app": {"type": "string", "minLength": 1},
            "titleContains": {"type": "string", "minLength": 1}
          },
          "minProperties": 1, "additionalProperties": false
        }
      },
      "required": ["kind"],
      "oneOf": [{"required": ["ref"]}, {"required": ["match"]}],
      "additionalProperties": false
    }
  ]
}
```

上面的窗口 oneOf 在 ref/match 同时出现时两个分支都成立，因此整体校验失败；不是 anyOf。所有 root/target/condition 使用同一注册 schema 在 Server 层验证，SDK 不支持自动导出某个条件时显式注册 Tool.inputSchema；不复刻 JSON-RPC 协议。


## 附录 B：证据索引

下列均为一手源码/官方文档。上游代码固定commit；官方API文档为本轮在线读取。链接不是运行验收证明。

- [W1] [Windows-MCP tools/snapshot.py](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tools/snapshot.py#L23-L120)
- [W2] [Windows-MCP desktop/service.py](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/service.py)（get_state、parse_region_selection、get_screenshot）
- [W3] [Windows-MCP desktop/screenshot.py](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/desktop/screenshot.py#L298-L375)
- [W4] [Windows-MCP tree/service.py](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tree/service.py)（password/value、UIA cache、RootWebArea、IA2 fallback）
- [W5] [Windows-MCP tree/ia2.py](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/tree/ia2.py)
- [W6] [Windows-MCP ctypes cursor binding fix](https://github.com/CursorTouch/Windows-MCP/commit/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3)
- [W7] [Windows-MCP vendor UIA header](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/src/windows_mcp/uia/core.py#L1-L12)
- [O1] [open-computer-use Windows runtime](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/apps/OpenComputerUseWindows/runtime.ps1#L290-L341)（Resolve-App；Capture-WindowPngBase64见565–583）
- [O2] [open-computer-use AccessibilitySnapshot.swift](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/AccessibilitySnapshot.swift)（155–279恢复；469–486窗口捕获）
- [O3] [open-computer-use Windows app state result](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/apps/OpenComputerUseWindows/main.go#L94-L131)
- [O4] [open-computer-use skill](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/skills/open-computer-use/SKILL.md)
- [M1] [Microsoft PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)
- [M2] [Microsoft UI Automation threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [M3] [Microsoft UI Automation properties](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-automation-element-propids)
- [P1] [Pillow 11.3 ImageGrab.py](https://github.com/python-pillow/Pillow/blob/11.3.0/src/PIL/ImageGrab.py)
- [P2] [Pillow 11.3 display.c](https://github.com/python-pillow/Pillow/blob/11.3.0/src/display.c#L292-L409)
- [S1] [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)（structured content、image、error、annotations）
- [S2] [Official MCP Python SDK FastMCP](https://github.com/modelcontextprotocol/python-sdk/blob/v1.x/src/mcp/server/fastmcp/server.py)
- [L1] [open-computer-use MIT](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/LICENSE)
- [L2] [Windows-MCP MIT](https://github.com/CursorTouch/Windows-MCP/blob/8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3/LICENSE.md)

Uina本地证据：`.uina/extensions/mcp/{config,catalog,proxy-tool,output-guard,server-manager}.ts`；`src/core/content.ts`；`src/agent/context.ts`；`src/session/types.ts`；`src/ai/{gateway,providers}.ts`；`tests/{image-content,mcp-proxy-tool,mcp-stdio-real}.test.ts`。
