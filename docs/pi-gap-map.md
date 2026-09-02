# Pi 机制 vs Uina v0 完备度对照（Gap Map）

> 2026-09-02 调研整理（基于 pi 官方 docs：extensions/tui/sessions/settings/compaction/
> prompt-templates/skills/rpc/sdk/providers/environment-variables/shell-aliases）。
> 用途：Uina 逐刀迭代时决定"下一刀补什么"的决策参照。铁律：真实需求触发才补，不为完整而完整。
>
> 标注：✅ 已对齐（或双方都不需要） / ⚠️ 有雏形没做好 / ❌ 没有

| 机制面 | 条目 | 状态 | 备注/将来触发点 |
| --- | --- | --- | --- |
| 主体与循环 | 决策环（prompt + 工具回注 + 无限轮次） | ✅ | 已对齐 |
| | launch / pause / resume / steer（接管/改向） | ❌ | 愿景#6 主动性的前提；当前只有 pushInput 排队 |
| | 强制 stop / abort（中断正在跑的轮） | ❌ | **最痛缺口**：挂死/失控只能杀进程 |
| 上下文 | compaction（token 阈值+摘要） | ✅ | 数值对齐 pi（reserve 16k / keep 20k） |
| | 手动 /compact + UI 提示 | ⚠️ | 自动压缩无感知，用户不知道发生了压缩 |
| | 分支摘要 /tree（切分支保上下文线） | ❌ | 低优先 |
| | pre-fetch（factor 13 预取上下文） | ❌ | 低优先 |
| | prompt-cache 控制 | ❌ | 省钱项，低优先 |
| 会话 | session.json + --continue | ✅ | 最简版 |
| | 会话命名/列表/删除/多会话并存 | ❌ | 体验最小升级（/save /sessions） |
| | fork / clone 分支实验 | ❌ | 低优先 |
| | tool-call id 映射重放（跨重启续跑链） | ❌ | 低优先 |
| 工具 | 自动发现（目录扫描） | ✅ | pi 同款，2026-09-02 刚落地 |
| | 显式声明 + 参数描述内联 schema | ✅ | |
| | 结构化错误回注 | ✅ | |
| | 工具超时/取消（signal/AbortController） | ⚠️ | 无限等待风险——配 stop 一起补 |
| | spawn hooks / 工具级拦截钩子 | ❌ | 未来控制平面的话题 |
| 扩展系统 | 事件钩子（session_start/tool_call 拦截） | ❌ | **最大缺口的核心**，愿景#4/#6/#8 的地基 |
| | ctx.ui（对话框/进度/自定义组件） | ❌ | 依赖组件化 TUI |
| | 自定义消息类型（customType 进 context+渲染） | ❌ | |
| | 热重载 /reload | ❌ | |
| 技能与模板 | skills（SKILL.md 程序性知识） | ❌ | 她将来自己写技能时的挂载点 |
| | prompt-templates（/template） | ❌ | 身份现在硬编码 context.ts（空纪计划配置化） |
| | AGENTS.override 式覆盖链 | ❌ | |
| 配置 | auth.json + env 覆盖 | ✅ | |
| | settings.json（compaction/UI/网络/重试可配） | ❌ | 参数全硬编码 |
| | 项目信任（.pi/settings 加载前问询） | ❌ | 低优先 |
| 模型 | 多 provider 映射 | ⚠️ | 有 default+providers，无订阅源/复杂路由 |
| | provider 重试（Retry settings） | ❌ | 低优先 |
| | thinking 预算分层 | ❌ | 低优先 |
| 多模态 | 图片输入（image base64 进 context） | ❌ | 愿景#7 感知的第一块地基 |
| | 自定义内容块渲染 | ❌ | |
| UI/交互 | 流式 + 工具状态反馈 | ✅ | |
| | 组件系统（编辑器/对话框/选择器） | ❌ | 扩展系统的前提 |
| | /命令系统 | ❌ | 现在只有 /quit |
| | 键盘绑定/主题/状态行/页眉页脚 | ❌ | |
| | IME 输入区 | ⚠️ | readline 保留 IME，但单行 |
| 执行与中断 | 前台工具进程控制（后台/刷新） | ❌ | 愿景#8 后台任务的远亲 |
| 外部接口 | RPC / SDK / shell ! 命令 / tmux | ❌ | QQ/语音通道接入时的候选 |
| | 事件总线外部订阅 | ❌ | |
| 模式 | 审批模式（manual/auto 权限） | ❌ | 控制平面话题（空纪将来决策） |

## 决策启示（2026-09-02）

- **最痛**：强制中断（stop）+ 工具可取消 —— 运行可打断是观察与自主的前提
- **体验最小升级**：/命令系统（/save /sessions /stop /compact 提示）
- **最大缺口结构**：扩展系统（事件钩子+UI 能力）——但无消费者前不建，愿景 #4/#6/#8 出现真实场景再落
- 多模态图片输入 = 感知第一刀的地基
- 其余全部"机制完整但当前无消费者"，按少即是多原则等需求信号

## 指挥语义三档 → Uina 内核接口蓝图（2026-09-02，抄 pi 的成熟形态）

pi 把"指挥/打断"建模为**消息注入语义**而非粗暴 kill（内核接口唯一，外壳全是消费者）：

| 档位 | 送达时机 | 语义 |
| --- | --- | --- |
| direct | 空闲时立即 | 正常对话 |
| steer | 当前轮工具链跑完后、下个 LLM 调用前 | 改向（"别继续，改做这个"） |
| followUp | agent 完全停手后 | 排队（"做完再顺便做那个"） |

- 强制显式：流式中插入消息必须声明 steer/followUp，否则报错（与 qq_send 显式目标同族纪律）
- 精确定义送达点（状态机控制点，非乱插）
- Uina 映射：内核 = `Subject.interrupt()`（真中止）+ `pushInput(text, mode)` 三档；外壳 = TUI(Ctrl+C→interrupt；输入按 busy 自动选档) → 将来 QQ/RPC 通道复用同接口、零内核改动
- 三问判断（接口化标准）：多触发者？跨层？用法会增殖？三问全中才立接口，接口止于薄契约
