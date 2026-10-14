# QQ World 开发指导

日期：2026-10-05。状态：实施指导，依据 QQ World 设计提案；尚未实现、尚未通过真实 QQ/TTS 验收。

> 本文是旧版实施指导，不能用于当前施工。其背景设计见[首版设计记录](../../proposals/qq/qq-world-design.md)；当前状态见[运行文档](../../current-runtime.md#qq-world)与[验收记录](../../qq/qq-world-acceptance.md)。源码和可运行行为优先于本文陈述。

## 1. 实施目标与边界

先验证两个纵向闭环，而不是一次接齐 NapCat 的全部 API：

1. **文字世界闭环**：QQ 观察 → journal → attention → Uina 收到提醒 → `read` → 明确目标 `send` → 如实返回外部动作结论。
2. **语音组合闭环**：独立调用 `tts.render_file` → 得到普通相对文件资源 → Uina 调用 `qq.send_voice` → 结果可核验。

其他图片/文件能力、poke、好友与群管理，以及 profile、回应、转发、视频、分享等，只按提案范围分阶段加入；它们不是上述两条闭环的前置条件。每个后续切片单独验证，不要把“NapCat 有接口”写成“已支持”。

## 2. 不可破坏的不变量

### 所有权

| 事实/资源 | 唯一所有者 | QQ 实现不得复制成第二份权威状态 |
| --- | --- | --- |
| NapCat/QQ 当前现实及平台回执 | QQ 平台 | 不把本地意图当平台成功 |
| 已观察消息、来源、附件引用、动作尝试及证据 | QQ World journal | 不由 Session 取代外部事实账本 |
| Subject 输入队列、canonical history、Provider 请求 | Subject/Session | QQ 不维护 `presented` 或消费游标 |
| 主体长期记忆与跨受众披露策略 | 当前设计未定义的主体级通用机制 | QQ 不建立关系画像、RAG、摘要记忆或 ACL |
| 生成音频 | TTS 负责生成；发布为 workspace 文件后作为普通文件使用 | 不引入 handle/retain/release/activation 租约 |
| 发往 QQ 的附件副本 | QQ World | 不删除来源文件；unknown 时保留证据，不自动重发 |

### 调用方向

```text
Uina/Subject → QQ World
Uina/Subject → TTS render_file
Uina/Subject → QQ send_voice(existing audio resource)
```

QQ 不调用或 import TTS；TTS 不知道 QQ、账号、会话或发送状态。二者由 Uina 依据用户意图组合。QQ 是长期存在的外部 World，不是 assistant 最终文本的自动转发目标。

### 生命周期、失败与取消

- World 在 `onStart` 建立连接、恢复本地状态并校验账号；`onStop` 停止接收新工作、取消可取消工作、等待在途 writer/动作安全结算，再释放资源。
- 收到事件的 WS 回执/回调路径不等待主脑回合；只记录/筛选/安排 wake。
- 所有外部动作必须带明确 conversation、actor、message ref 或管理目标。没有默认“当前会话”。
- 结果至少区分 `succeeded`、`failed`、`cancelled`、`unknown`、`not_started`。**受理不等于消费，dispatch 不等于成功，发送成功不等于对方已读。**
- 一旦外部动作可能已 dispatch 而结果不确定，标 `unknown`，保留 operation ref 与证据；restart、rewind、超时恢复都不得自动重发。

### Attention

- 本实例仅用 `dirty`、一个 `wakeInFlight` 和稳定 `cardRef` 合并相关观察；同一运行实例不堆积 wake。
- 跨重启 at-least-once，允许同一稳定 ref 重复提醒；每次投递使用新的 `inputId`。不加 Mailbox snapshot、`acknowledge`、`presented`、Session 精确消费对账或 Host 接缝。
- `read` / `inspect` 是纯查询，不确认通知、不改 dirty、不推进游标。重复提醒优于另造跨存储交付协议。
- 平常不注入 QQ dashboard；只推最小 attention delta。完整事实由 `inbox`、`read`、`inspect` 按需查询。
- 被动卡片按频率压缩：保留事件类型、可寻址的稳定 ref、必要 actor/target 和最小 preview；省略固定解释、重复字段、账号身份和通常不影响决策的时间。账号身份只通过 `status` 等主动查询获得。

## 3. 开工前核实

每次实际编码开始前：

1. 运行 `git status --short`，识别并保留已有修改，不重置、不覆盖无关文件。
2. 阅读 `dev/FACTS.md`、`dev/DECISIONS.md`、`dev/BASELINE.md`，以及本提案和 `docs/current-runtime.md` 对应章节。
3. 沿当前调用链核实下列接缝，而不是只照路径名写代码：
   - `src/extensions/world-framework/types.ts`：WorldDef、Action、事件及 context 合同；
   - `world-loader.ts`、`world-activation.ts`、`world-tool.ts`：发现、单 World 工具注册、schema 校验和卸载；
   - `src/extensions/runner.ts`、`lifecycle-scope.ts`：扩展服务、事件订阅与资源清理；
   - `src/agent/loop.ts`、`src/runtime/events.ts`：`input_accepted`、`turn_start/inputRefs`、队列与取消的真实语义；
   - `src/session/jsonl-store.ts`、`src/session/recovery.ts`：sync、恢复与失败处理；
   - 现有 TTS Extension/Bridge：合成原语、发布目录、工具结果和清理；
   - 本机 NapCat 实际 bundle 与目标账号环境：事件、echo、短 ID、媒体和权限事实。
4. 标注证据类别：源码存在、单测通过、假服务集成、真实 NapCat/账号验证必须区分。静态接口和 mock 不证明真实 QQ 可用。
5. 不读取或提交认证、真实账号配置、私人会话；协议 fixture 使用合成数据。

当前提案中的 NapCat bundle 版本只是曾检查到的本地包事实，不证明运行中的进程版本。需要操作行为的结论须针对真实进程重新核实。

## 4. 推荐实施顺序与每阶段退出条件

### 阶段 A：World 最小骨架与身份边界

**实现**：在项目既有 World/extension 组织约定下新增 QQ World；配置 NapCat endpoint/secret 与 `expected self_id`；从 World 自己的 `worldDataDir` 管本地数据；启动时连接并读真实 self identity，只有匹配才开放账号读写动作；正确处理启动失败、部分注册回滚、stop、重载和重复启动。

**先验证**：

- 正确身份启动；身份不匹配/未登录/连接失败均明确失败且不开放发送；
- 生命周期取消和 stop 会解绑事件、关闭 socket、等待本 World writer；
- 重载后无重复工具、事件订阅或后台工作；
- 秘密不进入模型 schema、普通日志或工具结果。

不得为 QQ 在 Host、Core 或 UI 增加专用状态/开关。如果现有 World 接缝出现可复现的阻断，先记录具体调用链与缺失能力，再证明不能在 Extension 内组合解决，才提出通用接缝变更。

### 阶段 B：外部事实 journal 与可恢复引用

**实现**：先定义 QQ 自己的最小事件信封和 journal schema/version，再接 NapCat 事件与 API echo；用单一 writer 串行化顺序；分开“外部观察事实”“动作意图/动作结论”和“可重建索引/缓存”。稳定 `messageRef` 不依赖 NapCat 易失的短 ID 单独寻址。历史补查必须记 coverage/gap；查不到不伪称完整。

**故障门**：记录序号/状态转移校验；尾部 partial record 如何截断恢复；完整损坏明确失败；写入/sync/回退失败后 writer 停止接受危险动作。普通 incoming 可批量持久化；外部动作的 `will_dispatch` 则必须在 dispatch 前完成真实 durable commit。不要把 TTS render、下载、缓存升级为发送级 fsync。

**测试**：乱序 echo、重复事件、短 ID 冲突、历史补查缺口、partial tail、中段损坏、短写/sync 失败、回退失败、取消/关闭竞争、重启恢复。

### 阶段 C：Attention 与最小可观察闭环

**实现**：用现有 World `emitEvent`/Subject input 通道发最小观察卡；采用单实例 single-flight dirty wake。卡片需自身携带可恢复的最小正文、稳定引用和来源，不只指向尚未持久化的另一处内容。普通事件 followUp；默认不升级 steer；账号身份不随 attention 卡片投影，只由 `status` 等主动查询提供。失败或取消按既有 Subject 输入语义处理。

卡片按提案的紧凑模板实现：同一会话共用头部，保留完整 `group:/private:` 和实际 message/attachment/event/request refs；私聊仅在 sender 可由会话确定时省略重复 sender。真实 mention target、角色/目标、节选、未知/失败、旧消息发生时间不能因压缩丢失。不引入 # 裸地址、昵称寻址或需要模型解码的自定义缩写。

**认知验收**：用同名 actor、同账号他端发言、混合事件、多会话、截断与延迟/补投样本，验证模型能正确判断谁/哪里/何事、区分已知与未展开内容并直接使用 ref 查询。量测实际模型请求的 token 成本，不以字符数或行数宣称节省。压缩只改正文展示，不改 single-flight/投递/耐久合同。

**禁止**：每消息/每会话通知队列、consume cursor、presented 对账、ack、restart 去重新接缝、在 WS 回调等待主脑。

**验收**：idle、普通回答、长工具活动、高频普通消息、连续 @、取消、停机/重载和 crash/restart；量测 NapCat 事件到达、输入受理、带 wake `inputRefs` 的 `turn_start`，有条件时再记录首个包含 wake 的 Provider request。记录分布，先建立基线，不定 SLO、不因假设改 steer。

### 阶段 D：模型查询与明确的文字发送

按完成闭环的最小顺序加入 `status`、`inbox`、`contacts`、`read`、`inspect`、`send`、`operation`；`attention` 只实现真实通知偏好需要的部分。避免为“全动作齐备”先填一堆未实现 schema。

- `read/inspect` 显式指定 conversation/ref/范围，返回分页、来源、coverage 和未展开部分；查询不改变 Attention。
- `send` 必须显式 conversation 和内容；名称、最近联系人、当前 attention 对象不作为默认目标。
- 每个危险动作按 `validate → intent → will_dispatch durable barrier → NapCat call → reconcile evidence → durable result → return`。
- 把所有失败归类：dispatch 前确定失败可 `failed/cancelled`；dispatch 后的超时、连接丢失或模糊回执为 `unknown`。先查 operation/平台事实，不自动 retry。
- 对重启后无法寻址的短 message ID，先通过历史重建和 ref 核验；不能重建就明确不可用，不试猜地址。

**首条切片通过条件**：合成入站 fixture 可进入 journal 并形成一张 wake；模型可继续 read 获取上下文；明确发给测试会话；故障注入证明 dispatch 屏障和 unknown 不重发。真实账号验收单独记录，不由 mock 替代。

### 阶段 E：TTS 文件与 QQ 语音组合

先让 TTS 单独提供 `render_file(text, output?)`：默认在受控的 `generated/audio/` 唯一命名，返回 `{ kind: "file", root: "workspace", path: "..." }` 和媒体事实。模型无需给绝对路径；输出路径若被指定，只能是该输出根内的相对目标。合成成功后产物是普通文件，无 AudioHandle/save/release 状态机。

QQ `send_voice` 只接已有音频资源，不调用 TTS。Uina 在模型决策下依次调用 TTS 与 QQ；无 TTS 时已有音频仍可发送。QQ 服务把可接受的输入资源复制到 QQ 自己的 staging/附件区域，验证真实路径在配置根内，再按平台要求转换/上传。不得删除输入源。复制/验证失败不得 dispatch；dispatch 后 unknown 保留副本以便核查，不自动二次发送。

**路径边界**：模型及可回 Provider 的结果只用 `{root, relative path}`；受信任实现内部才解析绝对路径。resolve + realpath 后按路径分段确认仍在指定根内，拒绝 `..`、根外 symlink/junction、未允许的 UNC/盘符和原始路径旁路。路径权限检查不是内容保密/数据防外发系统。

**验收**：TTS 独立加载与渲染、QQ 无 TTS 时发送既有文件、跨扩展组合、语音格式转换/平台上传、输出路径冲突/越界、根越界 symlink、取消清理、QQ staging 生命周期、dispatch unknown 保留且不重发。真实音色/真实 QQ 语音接收需真实验收。

### 阶段 F：其余能力逐项立项

文字/语音两个闭环通过后，按提案的真实需求与支持范围切片加入：收/发图片与文件、接收语音及转写、poke、资料/表情/回应、消息撤回/转发、视频/分享、好友管理、群管理、群文件等。一次只加一个垂直能力：接收事实/事件 → journal/ref → 查询/inspect 或动作合同 → 失败/取消/权限 → 单测 → 真实平台验收。未实现/平台空实现动作不要先出现在模型 schema 中。

## 5. 认知接口与模块边界审查

- 一个 `qq(action=...)` 是当前实现选择；当前 WorldDef 生成一个工具。只有真实模型评测证实 schema 太大、参数串线或 action 误选，才拆工具表面；拆分仍需一个 World 拥有生命周期与状态，不增 Host seam 来包装拆分。
- QQ 负责外部事实、来源、外部动作与平台能力；Uina 负责意图、关系理解、回复内容及 TTS/QQ 能力组合。
- QQ 不负责主体长期记忆、人际画像、跨联系人披露判定、自动已读、自动回复、长期附件资产、TTS 音色/播放/状态。
- 新字段加入前询问：是哪项可验证行为需要它？谁是权威 owner？生命周期如何结束？失败/取消怎样传播？已有接缝为何不足？删除它会丢失哪项事实或行为？

如果答案只能是“以后可能有用”，暂不实现。

## 6. 代码与测试习惯

- Extension 业务测试使用临时目录、fake NapCat transport/服务，隔离真实凭据和私人数据；覆盖生命周期和运行时组合，不只测试纯 helper。
- 优先补聚焦测试：World schema/动作校验沿用现有 World tool contract；扩展启动/停止沿用 Extension lifecycle 测试；Subject handoff 沿用 Agent/runtime event 语义测试；TTS 延伸沿用 TTS Extension 测试惯例。
- 外部行为覆盖 success、确定拒绝、dispatch 前 cancel、dispatch 后 timeout/abort、进程重启/模糊回执；测试断言状态和证据，不能只断言抛错字符串。
- 测试先在最小相关文件上运行，再执行 `pnpm typecheck`（含 boundaries）和相关测试；改动范围较大时执行 `pnpm test`、`pnpm build`。按 `dev/DECISIONS.md` 的既定 Vitest 池运行，勿擅自切换池来绕过问题。
- 文档、静态 schema、mock、localhost 分别按其证据等级报告；实际账号、权限、媒体上传/转换、真实语音必须显式标“未验证”，直到现场验收。
- 不更改 `E:/Uina/ThirdParty/NapCat` 或 Pi 源码；NapCat 源码只作为只读能力证据，除非用户单独授权。

## 7. 每个切片的完成报告

每个 PR/交付说明至少列出：

1. 用户可见行为及对应两条闭环/后续切片；
2. 修改的文件与唯一状态 owner；
3. 输入、输出、取消、失败、unknown 和 restart 语义；
4. 所运行的命令与实际结果（命令通过才说通过）；
5. fake/mock 与真实 QQ/TTS 验收边界；
6. 未支持动作、权限缺口、路径/媒体限制及遗留工作；
7. 工作树里原有无关改动是否保留。

## 8. 实施前快速核对表

- [ ] 先看 `git status --short`，未覆盖并行修改。
- [ ] 当前源码调用链与本文引用一致；能力声明不来自过期历史。
- [ ] 不修改 Core/Host seam，除非有具体失败用例证明现有 Extension 接缝不够。
- [ ] QQ/TTS 相互独立；音频是普通文件和 `{root,path}` 资源。
- [ ] 只有显式目标能触发 QQ 外部写。
- [ ] 危险动作在 durable `will_dispatch` 前绝不发出；unknown 永不自动重发。
- [ ] read/inspect 不改变 attention；跨重启允许重复 wake。
- [ ] 取消与 stop 会结算在途工作，staging 清理不越过资源根、不误删源。
- [ ] 验收只覆盖本切片，其他 NapCat API 明确列为未实现/未验证。

## 参考入口

- [QQ 世界设计提案](../../proposals/qq/qq-world-design.md)
- `dev/FACTS.md`、`dev/DECISIONS.md`、`dev/BASELINE.md`
- `docs/current-runtime.md`：能力注册、扩展生命周期、Subject/Session 恢复和外部事实合同
- `src/extensions/world-framework/{types.ts,world-loader.ts,world-activation.ts,world-tool.ts}`
- `src/extensions/runner.ts`、`src/extensions/lifecycle-scope.ts`
- `src/agent/loop.ts`、`src/runtime/events.ts`
- `src/session/jsonl-store.ts`、`src/session/recovery.ts`
- `.uina/extensions/tts/` 及相关测试
- `E:/Uina/ThirdParty/NapCat/app/napcat/napcat.mjs`（只读核对本地 bundle，不视为当前运行版本证明）

本指导文档没有授权开始代码实施；开始实现时仍须按项目开发约定检查当时源码、工作树和测试。
