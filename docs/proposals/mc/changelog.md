# 设计变更记录

## 2026-11-08 · 批44 通用服务器交互：菜单 / Dialog / 聊天动作 / HUD

- **一套界面真值，挂在连接上**：新增 `driver/window/state.ts` 的 `ConnectionWindowState`，由 `windowStateFor(protocolFor(bot))` 在**连接建立时**创建（不是懒建——懒建会丢掉连接早期的 `open_window`/Dialog/HUD 包）。三量分离：`serverStateId`（服务端同步代次，只用于归因 full 回执）、`contentRevision`（槽位/光标内容）、`uiRevision`（界面可见语义）；`screenRef` 是"本次打开"的身份，**不是**网络 windowId，插件重开同一类型的菜单会拿到新身份、旧观察随之失效。WindowSession 不再自持 `value`/`earlyFull`/`lastStateId` 镜像，改为从共享状态即时读；它只认领一次原生窗口对象（同 id 新对象必须让旧句柄失效）。
- **观察长于操作，操作只做一次**：新增 `ui@1`/`hud@1`（连接级、不占 Body、可 watch）与 `ui.act@1`（`click_slot`/`submit_dialog`/`activate_text`/`close`/`book_page`）。点击前态是 `screenRef`+`uiRevision`+`buttonDigest` 三元校验，失配在**派发前**报 `UI_STALE`。outcome 只有界面转移语义（`screen_opened`/`screen_closed`/`updated`/`sent`/`unknown`/`unsupported`），**从不等于业务成功**；物品搬运仍归 WindowSession 的 CAS 事务，两套判据分开。
- **文本动作只能执行已观察到的**：连接级登记表（有界 FIFO 128，聊天富文本与 Dialog 正文共用）按 `eventRef`+`actionRef` 查表，模型不能自己拼动作。`run_command`/`custom`/`show_dialog` 有真实编码，`open_url`/`copy_to_clipboard`/`change_page`/`book_page` 如实 `UNSUPPORTED_WINDOW`。
- **真服钉出来的五个协议事实**（都不是猜的，见 [driver.md §7.8](modules/driver.md)）：
  1. **物品组件的 `custom_name`/`lore` 是 prismarine-nbt typed 形态** `{type:"compound", value:{...}}`。`parseComponent` 不解这层标签时，菜单按钮的名字和 Lore 全是空串——`ui@1` 看起来"读到了"，实际什么都没读到。修法：`parseComponent` 顶部加 `unwrapTag`，同时保留旧 JSON 字符串与 § 文本两条路径。
  2. **`custom_click_action` 的 codec 是 `Identifier + lengthPrefixed(optionalTag)`，缺失用 `TAG_End(0x00)`**。minecraft-data 3.117.0 记成 `["option","anonymousNbt"]`（既少长度前缀、又把缺失记成 bool=false），按定义直写会被 Paper 判 `DecoderException` 并**直接踢人**。Driver 自己拼包体（`encodeAnonymousNbt` + `varint`），载荷里的原始 tag 原样透传（真服日志 `tag="from-chat"` 对上）。
  3. **普通箱子的 `window_items` 先于原生窗口对象到达**：那一刻 `synchronized=true` 而 `layout=null` 是中间态，不是"布局不支持"的结论。WindowSession 原来在这里直接锁死 `UNSUPPORTED_WINDOW`，导致每个普通箱子都打不开——真服回归抓到的，修法是等原生窗口就位再判。
  4. **Dialog 关闭与书面翻页没有 serverbound 包**：`close` 对 Dialog 报 `UNSUPPORTED_WINDOW`，不假装发过包。
  5. **Dialog 的 static 按钮不是 `minecraft:static`**：1.21.11 把 ClickEvent 直接内联在 `action` 上（`{type:"minecraft:run_command",command:"..."}`）。原先按 `{type:"minecraft:static",action:{...}}` 解析，结果真服里 Close 按钮的动作整个变成 `none`——投影看起来"有三个按钮"，但第三个没有可执行内容，`ui.act` 点它只会报 `no resolvable action`。审查阶段用一次性探针 dump 出真实 NBT 后修掉，`dev:mc:ui` 现在直接断言 Close 必须是 `run_command`。同时发现 `body` 是 `Either<List<DialogBody>, DialogBody>`：单个 body 时线上是裸 compound，只按数组解析会丢掉整段正文。
- **一次只显示一个界面**：开容器屏清掉当前 Dialog，开本地 Dialog 清掉容器屏。两个同时留在状态里会让 `ui@1` 报告一个看不见的界面。
- **HUD 走独立事实类别**：`hud`（计分板/BossBar/标题/副标题/动作栏/Tab）高频刷新不唤醒 `ui` 的观察者，也不推进 `uiRevision`。状态帧追加"当前界面 + HUD"两行，模型不必先读查询就知道有没有菜单、身份是什么。
- **教学面**：新增 `companion/guides/server_ui_playbook.md`（先读 `ui@1`、三元校验、四种动作语义、outcome 表、未知布局只读、连续操作、HUD 是观察不是目标），目录 6 → 7 份 Guide。
- **真服夹具重写**：`dev-env/uina-plugin` 扩成菜单（`/uina_menu`，按钮 + 变价刷新 + 只发聊天的按钮 + 关闭）、`/uina_hud`、`/uina_chat_actions`（三种 click_event）、内联 Dialog（命令模板 / custom / static 三按钮），`MenuHolder` 保证普通箱子不受影响。每次按钮点击在服务端日志留一行，作为服务端侧证据。
- 验收：新增 `pnpm dev:mc:ui` 真服端到端（**不硬编码槽位号**，按钮按显示名从 `ui@1` 里找出来，再用它自己的三元前态去点）：菜单读取 → 购买（`screen_opened`、标价从 Lore 解析后递增、扣款按标价核对、钻石 +1、聊天回执与侧边栏交叉核对、服务端日志 `menu click slot=11`）→ 陈旧前态 `UI_STALE` → 只发聊天按钮 `sent` → 关闭 `screen_closed` → 聊天三种动作全部解析并执行（服务端日志 `issued server command: /uina_say clicked-run`、`custom click action: uina:probe tag="from-chat"`）→ 未登记动作 `UI_STALE` → Dialog 投影（1 输入 3 按钮）→ 命令模板提交（服务端日志 `issued server command: /uina_dialog_submit hello-uina`）→ 未声明输入 `INVALID_INPUT` → Dialog 关闭 `UNSUPPORTED_WINDOW` → HUD 五类元素 → **普通容器回归**（`container@1` 读到 5 颗钻石，`transfer@1` 取走 2）。新增 `mc-ui-projection.test.ts`（16 项，夹具用真服 dump 的原样形态）；`npx tsc --noEmit` 全绿；`tests/mc`（排除 `tests/mcp-*` 与 `tests/mc-native-host*`）110 文件 876 passed / 13 skipped（唯一失败仍是既有 `node_api.h` 环境项）。
- **审查修复**：Dialog static 动作与单 body 编码按真服 dump 修正（见事实 5）；`replaceScreen` 的 `uiRevision` 改为跨界面取 `Math.max`（被取代的 Dialog 修订更高时不能从 0 重新开始，否则旧观察会"看起来更新"）；`registerTextActions` 同一 `eventRef` 重复登记不再重复占队位（否则 FIFO 淘汰会先删掉刚登记的那条）；`regionOf` 只认布局里真正列出的槽号（布局外的槽不再冒充"上方业务区"）；`ui` 事件里关闭时的 `phase` 取关闭前身份（否则 config 阶段对话框会被报成 `play`），`uiKind` 契约补上 `book` 以与 `UiSnapshot` 一致。
- 明确没做：配置阶段 `registry_data` 的 dialog 注册表没有真服证据（只实证了内联 Dialog）；`submit_dialog` 的输入只校验类型不校验 min/max/maxLength；NPC 没有专用高层动作；HUD 只做显示观察不做语义解释。见 [known-gaps.md](known-gaps.md) 服务器交互段。

## 2026-11-08 · 批43 Addon：非原版环境的独立可安装能力

- **装配唯一入口**：删除 `builtinCatalog` 固定目录与 `openExecutionSide({callables})` 旁路；Runtime、World、describe 与 Addon 贡献现在消费同一次 `CapabilityCatalog.create/bind`。测试/开发注入改走 `callableModule`（仍进同一次 Catalog），不再有第二套注册表。
- **包与 Profile 分离**：`addons/<id>/package.json` 的 `uinaMinecraft` 只读解析（不执行代码）；`sessions/<profileId>/addons.json` 的 `enabled` 是显式列表，connect 时冻结并产出 digest。未启用的包不 import、不出现在目录、动作 `NOT_FOUND`。
- **连接级协议**：`prepare`（建客户端前）与 `attach`（建客户端后）两个时机；`ConnectionPort` 只给只读订阅与 `publishFact`，写入口只在 `CallContext.protocol`（BodyScope 内）。事实绑定 connection/incarnation，断线清空、旧连接迟到发布丢弃。
- **真服钉出的协议事实**：Paper 1.21.11 **只向已声明通道投递** clientbound `custom_payload`。此前客户端只发不收，服务端收到 press 却不回包，动作如实 `EFFECT_UNCONFIRMED`。修复：`onCustomPayload` 与 `protocol.send` 都先走 `registerChannels`（`minecraft:register`，NUL 分隔，每连接每通道一次），attach 早于 login 时排队到 login 补发。这条不注册就收不到，不是可选项。
- **ref 命名空间**：按规格只要求 `<namespace>.<name>@<version>`，不把前缀绑死成 addon id（`example.machine@1` 合法）；跨包/与内置重名由 Catalog 唯一性校验显式拒绝。包状态新增 `contributed.refs`，目录不再靠 id 前缀猜能力归属（否则 `example-mod` + `example.*` 会漏列）。
- **目录与 IPC**：新增固定方法 `directory.snapshot`（launch/connection/descriptors/addons/selection 纯 JSON）；`session.status.active.addons = {digest, ids}`；活动会话拿不到快照即 `EXECUTOR_UNAVAILABLE`，不回退旧目录。
- **示例包**：`examples/addons/example-mod`（自定义通道 → 服务端计数 → addon fact → current 查询 → BodyScope 动作回读确认；`example:uina_token` 由 Paper 插件真实发放）。`dev-env/uina-plugin` 用服务器 libraries 编译，不引 Gradle/Maven。仓库目前不发布正式包：`spectatorplus` 曾按 `/spectate` 实现并一度提升为正式包，后确认前提错误（`/spectate` 属另一个同名 Spigot 插件；yzxoi 的 SpectatorPlus 是观战同步 mod，没有该命令），包与真服步骤均已删除，理由见 [known-gaps.md](known-gaps.md)。
- **运维**：`addons/manage.ts` + `pnpm mc:addon`（list/inspect/install/enable/disable/remove/status）；安装拒绝覆盖同 id，卸载拒绝仍被 Profile 启用的包。
- 验收：新增 `mc-addons.test.ts`（37）与 `mc-addon-protocol.test.ts`（14）全绿；`mc-protocol.test.ts` 增通道注册与注册失败重试用例；真服 `pnpm dev:mc:addons` 8/8（安装≠启用、冻结、重连生效、初始事实未知、纵向写入、重复写入、连接期 disable 不卸载）；`npx tsc --noEmit` 全绿；tests/mc 109 文件 861 passed / 13 skipped（唯一失败为既有 `node_api.h` 环境项；注意 `vitest run tests/mc` 的路径过滤会连带匹配 `tests/mcp-*`，统计口径以排除后的结果为准）。
- 明确没做：Addon 热重载、`prepare` 预构造 client 的真服示例、`serverRequirement` 服务端探测、多协议版本；SpectatorPlus 集成已否决（见 [known-gaps.md](known-gaps.md) 的 Addon 段）。

## 2026-11-08 · 批42 教学接缝与执行闭环

- **教学分三层**：`WorldDef.environmentGuide` 是可选只读 getter，`WorldActivation` 在 `turn.prepare` 把活动世界的短正文追加到 systemPrompt（多世界依次追加、停用由 scope 摘除、不写 Session、不注入为用户消息）。Minecraft 的 ENV 在 `onStart` 预载，无活动会话返回 null；`nativeGuide` 从 1.75KB 混杂 API 长文压成入口；六份官方只读 Guide 通过既有 `describe {kind:'guide'}` 按需读正文，不进 Library、永不 callable；`copy-assets` 打包 ENV/Guide/参考 Program，Guide 内每段 JS 与 `safe_mining.js` 由真实 validator 编译校验。
- **导航默认改为不改世界**：`goto@1` 与 `route.plan@1` 的 `placeToReach` 默认 false；surface/tunnel 的授权施工调用显式 true；plan 与执行共用同一 movement 配置。攀爬类 dev 探针显式授权，避免用旧默认掩盖行为变化。
- **Window 因果按真服证据定**：`window_items.stateId` 保留到 Window 层；`stateId:-1` 每次都能拿到权威 full，用真实 stateId 的点击服务端不回包；工作台会先回"仅同步"的 full。因此回执增 `outcome:"confirmed"|"diverged"|"unknown"` 与有界 `diagnostics`，但**内容未变不判拒绝**，保持 unknown 并置 uncertain。曾把未变化判 rejected，SHELTER 真服立刻回归失败，已回退。
- **Body 撤销不再猜**：stop/safety/preempt/disconnect/control_fault/world_disabled 在真实发起点写不可变 `retiredBy`；`interruptible()` 从 Effect 账本现算 `dispatch/effects`，只有明确 not_sent 才算未派发；`recoverable` 只对 safety 为 true，user_stop 不自动续跑；物理隔离仍由 BodySession.close() 屏障负责。
- **领域闭环**：`excavate` 的 `remainingCount` 计入从未轮到的格（读取抛错的格也算未访问），`reasons` 汇总、`remaining` 64 条有界样本；`collect` 的候选记录 permanent/transient/unknown，已派发 TIMEOUT 不换候选，候选耗尽但"挖除数>入包数"时先有界清扫地面掉落；`craft` 返回/进度暴露 `station {source,block,placed}`。
- **Program 终验**：MINE 在返程后重读 `self@1`/`inventory@1`，维度/立足/位置/数量任一不满足即 `mc.decide`；宿主把 `awaiting_decision` 记 `NEEDS_DECISION`，不再以 `returned` 正常结束。
- 验收：真服 `dev:mc:task` MINE/SHELTER/NIGHT 全 PASS（服务端 Oracle：返程、背包、矿体、结构 24/24、无死亡）；`pnpm typecheck` 全绿；tests/mc 808 passed（唯一失败为既有 `node_api.h` 环境项）；全量 27 failed 与基线同文件（UI/ANSI、Python httpx、node_api.h）。
- 明确没做：tunnel 流体/重力前视、surface 逐帧上浮、T2/T3/T5 场景与真实模型 A/B；Guide 只做编译与结构校验，未逐条真服实践验证。

## 2026-11-08 · 批41 审查收尾：缺失必须说出来

- **状态帧缺一段也要说**：`state.snapshot` 原来在 `runtime.list {activeOnly:true}` 失败时静默省掉活跃任务段。world.md §9.5 已经写明"让位置空着会被读成世界没变，那比没有状态更危险"，这里模型会把"没读到"当成"没有活跃任务"。现在查询失败与查到 0 条分开：前者正文写明"本次未能读取，不代表没有活跃任务；需要确认请 runs.list"，世界 Facts 照给，不编假列表、不用旧缓存。
- **宿主没有批量入口时让对账显式失败**：`DeliveryPump.deliver()` 原来只往 `this.error` 写一句就返回，而 `reconcile()` 的成功分支紧接着把 `error` 清成 null——诊断永远看不到这批事件根本没交出去。改成由 `drain()` 抛错，走既有的退避与诊断路径。不退回逐条投递：那会让第一条独占模型回合，与集中交付的初衷相反。`dev/session-live.ts` 的 stub 只给 `emitEvent`，这条分支真实可达。
- **批量回执缺条不留在途**：`emitEvents` 少回一条时原来 `continue` 跳过，`inputs` 里留一个永远退不了的假在途记录，也不报错。现在与明确拒收同样处理：删在途、记 `DELIVERY_UNCONFIRMED`、下一轮换新 attempt 重投。
- **清理**：`InputRejected.retryable` 五个构造点全传 `false`，删掉死参数，`isRetryableRejection` 收敛成一个 instanceof 判断；`DeliveryPump.prepare` 的 `"tool"` 通道参数删掉（写入侧只剩 input，读取侧保留联合类型以退役旧账本）；`delivery.ts` 文件头的"双通道"注释、`runner.ts` 与 `types.ts` 里"缺省时只能退回单条"的承诺改成与实现一致。
- 验收：三条新增用例在修复前分别红在诊断被清成 null、假在途 `b` 未删、`null` 参数没有不可用分支；修复后 `mc-run-digest` 7 项与 `mc-delivery-pump` 15 项全绿。定向 9 文件 103 项全绿；全量默认池 330 文件 3370 项里本批相关 8 文件全绿，30 项失败中 28 项是批41 已登记的既有基线红（UI/ANSI 系列、`tts-bridge-protocol` 缺 Python httpx、`refactor-regression` 的 computeWordDiff），另有 3 个真实 OS/超时类 MC 文件在全量并行下波动（`RPC_TIMEOUT` 取代 `CONNECT_FAILED`），单进程复跑 22 项全绿；`tests/mc --pool=vmThreads` 111 文件 920 项：`mcp-extension-loading` 2 项是既有基线红，其余 918 项通过；`pnpm typecheck`（biome 825 文件 / boundaries 10 规则 / 双 tsc）通过；`pnpm build` 需用 node 24.13.1（PATH 上的 node 22 缺 node-gyp 头文件），已通过。
- 明确没做：真实 Minecraft 服与真实模型的对照窗口仍未跑，不能把自动化绿灯当真服验收。

## 2026-11-08 · 批41 顶层只回答受理，完成通知集中入队

- **工具层不再等结果**：`run`/`chat`/`runs.continue` 删掉默认 3 秒等待窗与公开 `wait`，只回 `accepted`/`not_accepted`/`unknown`。旧实现里同一个结果有两条通道——窗口内完成就把终态当工具结果返回，超时就先回 `accepted`、终态再从完成通知来一次；模型分不清拿到的是受理还是终态。删除后任务快慢只决定通知什么时候到，Program 内的 `await mc.call()` 不变。`runs.wait` 保留，但不再是模型的默认工作流。
- **整批可让出才让出**：`ToolExecutionResult.continuation` 增 `'yield'`；`settleToolExchange` 在工具结果全部写入 canonical 历史后才判，`stop` 优先，整批都是 `yield` 才结束本轮，混了读结果、失败或 `unknown` 照常请求模型。单个 `accepted` 不再单独产生一次"现在等什么"的请求。
- **完成通知从单槽改有界集中入队**：`DeliveryPump` 原来一个 `active` 槽加 `emitting` 挡住全部后续投递，多份完成只能串行。现在一轮对账收最多 8 个 key，逐条 `inspect` 与独立 attempt，经新接线 `submitInputs` → `onInputs` → `Subject.acceptBatch` 一次 `emitEvents` 交出；每条保留自己的 `completionRef`、attempt、Host committed 回执与 ACK。批量受理只回答逐条持久入队，不冒充模型已读；被拒的项不留假在途，下一轮换新 attempt 重投，全被拒不再立即重排。消费端仍用批38 的 `batchForTurn()` 预算，不另造队列。
- **`accept` 的 idle 直启语义保住**：抽出共用准入与持久化后，`accept` 一度变成"先入队再异步唤醒"，`waitForIdle()` 会在 `activeRun` 尚未占住的空窗里返回、把没提交的回合当成已结束（qq 的 read/skip 竞态用例变红）。改回 idle 且队列空时同步直启，与 `pushInput` 同源；批量入口不直启的语义不变。修的是内核语义，没有改测试断言。
- **请求前状态帧附有界活跃任务**：`world/run-digest.ts` 复用 `runtime.list {activeOnly:true}`，与 `state.snapshot` 同一次请求前路径合成；最多列 4 条、单条摘要 40 字符，超出只给数量与 `runs.list`。两段各自标采样时间，不合成一个原子快照；只读，不推送、不 ACK、不建新 Run。
- **旧机制清理**：`shortWindowMs`、顶层 `waitMs`、`toolAttempt`、`heldTools`、公开的 `run.wait` schema 与指南句、`RunReply` 类型、`ExecutorClient.submit/continue` 的 `waitSignal`、诊断里的单值 `activeInput` 全部删除；`heldRequests` 保留（受理期间压住同 request 的完成通知）。挖掘掉落观察窗、qq 调度与 driver 挖矿计时的 `waitMs`/短窗是别的含义，不动。
- 验收：`qq-world-subject-integration` 3 项（修复前红、修复后绿，唯一变量是 `accept` 的直启分支）、`accept-batch` 5 项、`turn-yield` 7 项、`mc-delivery-pump` 13 项、`mc-run-digest` 6 项、MC 定向集 12 文件 61 项、交付相关 6 文件 39 项；`pnpm typecheck`（biome 825 文件 / boundaries 10 规则 / 双 tsc）与 `pnpm build` 通过。全量默认池 330 文件 3367 项：28 项基线红（UI/ANSI 系列、tts-bridge-protocol 缺 Python httpx、refactor-regression 的 computeWordDiff），本批相关文件全绿；tests/mc vmThreads 111 文件 917 项：915 通过，`mcp-extension-loading` 2 项为既有基线红。
- 明确没做：真实 Minecraft 服与真实模型的对照窗口本轮没跑，不能把自动化绿灯当真服验收；`runs.wait`、BodyLease、Safety、有界领取预算与 `mc.waitUntil` 全部保留；导航、Window、Safety 算法不在本轮范围。

## 2026-11-08 · 批40 事件投递回答「还归不归我」

- **语义修正**：`ServiceCompanionContext.emitEvent` 之前返回 `Promise<void>`，世界只能靠"抛不抛异常"猜投递结果；而世界停用时它静默返回成功——事件还在世界手里，宿主却以为已经交出去了。现在返回 `EventSubmission`：`{accepted:true}` 表示事件已经离开世界（进了主脑的待处理集合，或已被宿主撤销），`{accepted:false, reason, retryable}` 表示它还在世界手里。
- **判据归世界**：`retryable` 由世界给（停用 → false，宿主拒收 → true）；重提必须用同一个 `id`，宿主按 ID 去重。形状非法（缺 `text` 且缺 `render`、`channel` 不是 `world`）照旧直接抛——那是世界自己的 bug，不是投递状态，重试没有意义。
- **投递泵只信这个答案**：`DeliveryPump.attemptEmit` 不再用 try/catch 猜结果，`accepted` 才算交付，`retryable` 决定补发一次，其余把 `reason` 落进诊断。补发仍失败只存诊断、不无限重试（证据本体已在 events@1，可回放）。
- **消费方跟着改**：bilibili 弹幕窗（未被接管时必须让出 `pending`，否则这一窗弹幕之后再也不会投）、bilibili 房间事件、qq 延后批次、rhythm 机会与提醒——都从"忽略返回值"改成"没交出去就报"，与它们原本的异常路径一致。
- 验收：`mc-delivery-pump` 12 项（新增 `retryable:false` 不补发、形状错误不补发；两条都做了反向验证——去掉 `retryable` 判据 → 用例红，把抛错包成重试 → 用例红）；`app-framework-lifecycle` 13 项（新增停用/拒收都不算交付，反向验证：停用分支改回静默成功 → 用例红）；qq 四套 + bilibili 弹幕 82 项全绿。
- 明确没做：**早期结算**（让 `emitEvent` 在"受理"而不是"回合结束"时返回）。当前没有消费方需要这个及时性，代价是把 agent 内核的 `accept` 拉进世界接缝；等真有需求再做。持久 outbox 同样不做。

## 2026-11-08 · 批39 安全干预的起因由调用点声明

- **修掉一处"用终态值代替起因"的判断**：批37 起 `ended` 为 `cancelled|invalidated` 一律不上报，理由是"前者是宿主关门、后者由连接/死亡事实承担"。后半句只对一种失效成立。`invalidated` 还有三个来源——body 抢占失败、会话关闭出错、崩溃恢复留下的未结算记录——它们意味着"危险触发过、脱险没跑成"，而且没有任何别的事实替它说。模型因此对这三类静默，只会看到行动被莫名其妙打断。
- **起因成为显式参数**：`cancel(reason, cause)` 由调用点声明（目前唯一取值 `"connection"`，`invalidateControl()` 是唯一声明者），`changed(record, cause)` 带出。起因只在内存里活一次干预的生命周期、不进库：它只回答"这条终态是不是已经有人替我说过了"，记录本身的 `ended`/`outcome` 已经说清发生了什么。
- **判定抽成纯函数**：`companion/safety-route.ts` 的 `safetyNeedsAttention(ended, cause)` 是"要不要单独说一句"的唯一所有者；`side.ts` 先用 `record.ended == null` 把判别联合收窄（未结算的干预还没有"发生了什么"），再问判定，不再自己写条件。
- 验收：`mc-safety-route` 4 项（世界关门不说、连接失效不说、无人承担的失效必须说、跑完的一律说）；`mc-safety-runtime` 新增链路用例（`invalidateControl` → `["invalidated","connection"]`；无外因的失效 → `["invalidated", null]`）。两条反向验证：判定改回"invalidated 一律不说" → 判定用例红 2 项；`invalidateControl` 去掉起因 → 链路用例红。tsc / boundaries / biome format 干净，safety 相关 36 项全绿。
- 明确没做：事件投递改"入队确认"、连接身份进合批判据、Completion 投递优先级——按方案仍在后续批次。

## 2026-11-08 · 批38 回合输入有界领取 + 观察帧每回合必到

- **合批从"扫描规则"变成"队列的一次领取"**：`InputQueues.batchForTurn(policy)` 拥有三条边界（steer 先走且单独成批、非运行时来源不合批、运行时来源只在同一世界内合并）与两层预算（条数 8、字符总量 6000）。`drainQueuesIntoRun` 从 12 行扫描缩到 3 行，`isRuntimeFollowUp` 从 `loop.ts` 搬进 `queue.ts`。剩余条目留在队列，靠回合成功后的既有续跑继续消费——没有新调度机制。
- **修掉一条死锁**：此前合批没有任何容量概念，积压会一次性提交历史、再一次性塞进请求；`decide` 里的预算检查直接抛错，`turn_start` 已 dispatch 所以走 `turn_failed`，而 `finishTurn` 对失败回合明确不续跑队列——此时队列已空，没有东西能再叫醒它。更糟的是历史已被撑大，下一条消息进来同样超限，形成"此后每回合都失败"。预算只在已经领到东西之后才起作用：单条就超长时仍放行，否则它永远出不去。
- **观察帧变成"每回合必到"**：取不到时注入占位正文（读取超时 / 读失败 / 世界没有提供内容 / 上一次读取仍未返回），通知文案改成"本轮没有取到世界状态"，并明确"不要把它当成世界没有变化"。此前 `catch { return }` 让整帧消失，模型会把缺失读成静止。`withTimeout` 的清理从"原始 Promise 结算时"移到"三个出口统一清理"——读取永久挂起时，abort 监听器不再按请求累积；同一时刻只允许一份采样在飞。
- 验收：`turn-batch` 9 项（steer 优先、用户不合批、跨世界停、条数、字符、单条超长放行、只算不改）、smoke 新增 100 条积压用例（分批、每批有界、总数一条不剩）、`world-request-context` 6 项（占位/超时/单飞/监听器当场摘除）、`qq-world-framework-seams` 3 条旧断言按新语义改写。三条反向验证：删掉预算判断 → 单测与积压用例红；`catch` 改重抛 → 占位用例红；超时分支去掉 `settle()` → 监听器用例红。tsc / boundaries / biome format 干净。
- 明确没做：事件投递改"入队确认"、因果字段、连接身份、Completion 优先级——按方案排在后续三批。

## 2026-11-08 · 批37 状态不推送（G6 换实现）+ 事件按种类分流

- **删掉批20 的 digest 整条链路**（G6 的关闭方式换掉，缺口本身仍关闭）：`world/digest.ts`（changed/reset 订阅、10s 前缘节流 `DIGEST_INTERVAL_MS`、规范化 JSON 哈希去重、reset 清哈希、主脑忙时只保最新一份）、事件类型 `minecraft_digest`、`dev/digest.ts` 场景、`mc-world-digest.test.ts`、`worlddef/schema.ts` 指南里的 digest 描述。理由是方向错：**旧坐标与旧背包排队等模型处理没有价值，只有当前值有意义**——节流与去重都在把"过时的东西"发得更省，问题不在发多少，在于该不该发。
- **新增请求前状态帧**：`world/state-frame.ts` 只有采样与文本投影（无定时器/订阅/去重/历史/消息），一次 `facts.sample` 采 self/inventory/world 三段（复用 `capabilities.readers` 的现有读取器，与 observe 同口径）。宿主侧 `WorldDef.requestContext`（`src/extensions/world-framework/types.ts`）经 `turn.transformContext`（`tail` 相位）在**每次模型请求前**取一份，250ms 超时即本轮不注入；RPC 出口为窄只读 `state.snapshot`。
- **投影口径的三处判断**：站位取 `Math.floor`（与全世界方块坐标一致，`tp 9850.5` 差一格，四舍五入会指到隔壁方块）；背包超 10 种折叠成种类数 + 剩余项数，空背包只说一次空；生命/饥饿没收到说"未知"（省略会被读成满血，填 0 会被读成已死）。读取器报的字段级缺口（地面上"oxygen not received"）**不算降级**——早先把它并进 `unknown`，真服第一轮就暴露每帧带三条噪声。
- **事件只剩"发生了什么"并按种类分流**：`minecraft_event` 的 death、connection disconnected、玩家私聊（`self===false`）、安全干预 `blocked|timeout` 走 `urgent`（宿主投成 steer，当前执行前提已失效或有人在等回应），其余 `queued`（等下一次决策一起处理）。安全干预 `safe` 仍上报（被打断的 Run 完成记录只说 `cancelled`，不说因果），带 `interruptedRun`；`cancelled|invalidated` 不上报（前者是宿主关门的收尾，后者由连接/死亡事件承担）。
- **宿主侧两处配套**：followUp 合批从按 `origin` 改成按世界 ref——同一次行动的"世界变了"（external）与"结果出来了"（internal）合成一次请求；失败终态保留调用侧报告的 `progress`（异常终止的 Run 也要说出"做到哪一步"）。
- 真模型窗口（单回合探针，真实 deepseek，两轮）：连上 UinaDev 后禁止调用任何查询，模型仍报出坐标/生命/饥饿/背包并与服务端真值一致（"直接从自动附在末尾的快照里读到的"）——状态帧确实进了请求尾。第二轮同时钉住一处措辞缺陷：刚连上物理未跑第一拍时 `onGround` 为 false，帧里写"在空中"让模型解释了没发生的事；改为只在 `velocity.y < 0` 时写"在下落"，模型改为如实说"没收到，不猜"。
- 验收：真服 `pnpm dev:mc:state-frame` **7/7**（三段齐全无未知、空闲 15s 零事件、`/give` 后下一次采样立即可见、`inventory@1 {since}` 增量不变、**走路 35 格 20s 零事件且 20 次采样全部等于身体当前所在格**、events@1 无状态帧泄漏）；任务级基线回归 mine **ALL PASS**（returned 精确回起点、haul 与 ore_gone 服务端判决、no_death，45.6s）、shelter **ALL PASS**（structure 24/24、interior、surplus、outside、no_death，61.9s）；`mc-state-frame` 11 项、`mc-delivery-pump`、`mc-runtime-settlement`、`qq-world-framework-seams` 12 项、`world-request-context` 2 项、`smoke` 28 项（含合批回合两条投递各自结算，已反向验证证明力）；biome format / boundaries / tsc 干净，tests/mc 903 项（901 通过，`mcp-extension-loading` 2 项为既有基线红），smoke/seams/request-context 与事件帧投影 66 项全过。
- **审查清理**：删掉 `event-frames/projection.ts` 的 `snapshotNotice(kind)`（生产代码零调用者，与 world 专属 `observationNotice` 是两份近似文案，留着只会漂移；`buildEventFrameGroup` 的 `notice?` 已覆盖该需求）；`world/watch.ts` 的 `canonical` 注释去掉"与 G6 digest 去重共用"（digest 已删）；`StateFrame.unknown` 统一为"整段读不到的段落"，未连接时留空（原因在正文，避免一个字段担两种含义）；`withTimeout` 注明超时只放弃等待、不取消底层只读采样。补一条跨世界不合批的 smoke 断言——合批的边界是世界身份，此前只测了同世界合批与用户/steer 切断；补一条 `requestContext` 抛错时 handler 返回空的断言（此前的用例只能证明"没注入"，把 catch 改成重抛也照样通过，没有证明力；异常冒泡不会中断回合，这一层自己不许抛）。

## 2026-11-07 · 批36 审查轮（G30 关闭事实衔接 + 探针头注 + 引用修复）

- **known-gaps G30 批36 条目补现象衔接**：批35 审查轮的现象改判（塔升放置链路完整工作，残余 = 逐级爬升彩票）原只存在于被替换的残余小节，批36 关闭条目直接从机制讲起——补一句改判承接，登记按"现象可信"可读。
- **探针头注对齐关闭状态**：`tower-probe.ts` 头注的"修法方向：阶梯段冲刺跳行为"停留在关闭前假设（批36 实际机制 = 退避残留键），更正为关闭事实 + 保留为该执行器面的回归观测入口；采样描述 200ms→100ms（批36 增强后实际值）。
- **MC-WORLD.md 经验列表重排**（本地文档）：批27 起新增条目用 56–60 与既有 55–59 撞号（两组 56/57/58/59 各指不同内容，"经验 58"引用歧义）——第二组重排为 60–64、批35 新增条目 61→65；碰撞区间无交叉引用（全仓 grep 实证），批25 记录引用的 58/59 属第一组不动；changelog 的"经验 61"引用同步为 65。
- **README 表格事实修正**：任务级基线行"mine 回程六轮全挂"未随批34 审查轮口径改判（实为 11 轮）并补 G30 关闭指向；真服场景数 35→36（tower-probe 入库后）。
- 验收：`pnpm typecheck` 过；tests/mc 897 项全绿（批36 验收轮已跑，本轮仅文档与本地文件改动）。

## 2026-11-07 · 批36 退避只拥有地面（G30 (b) 逐级爬升彩票关闭，G30 全部关闭）

- **机制（100ms 探针逐帧）**：批19 退避（touching + speed<0.12 → back 200–900ms）的触发时刻与纯节点规则的落地跳重合——落地瞬间速度恰为 0 满足触发条件，退避同拍接管把 f/j 换成 b；bot 离地后 back=true 残留在空中与移动分支的 forward 并存互相抵消（f:1 b:1 同按），弧线变垂直起落，落点恰差到达窗 0.29，退避再触发成环。基线探针 10 轮 8 绿 2 红（红率 ~20%）。
- **第一版修复被探针否决**："空中不覆盖键位"（carve-out）让 4/10 红轮全部变成 f:1 b:1 垂直空转——残留键问题独立于覆盖问题。
- **最终 = 退避只拥有地面**：地面触发/覆盖逻辑原样（批19 平地退避从不离地，不受影响）；离地即释放残留 back 键；backOff/backUntil 计时保留，落地后窗口内继续退避。修复在 `lib/index.js` 执行器主循环（与批19 step assist 同一验证口径：真服门 + 探针，无 T0 夹具）。
- 验收：探针 `dev:mc:tower-probe --gap 1` **10/10 连绿**（11.6–14.4s；基线 8/10）、mine **4/4** ALL PASS、climb/terrain-nav PASS、upstream-nav 7/7（S3 首轮失败为 G28 已登记抖动，复跑即过）、tests/mc 897 项全绿、`pnpm typecheck` 过。**G30 三缺陷形态全部关闭。**

## 2026-11-07 · 批35 审查轮（(b) 残余逐帧精化 + 文档漂移修复 + MC-WORLD.md 刷新）

- **debugState 节点携带 toPlace/toBreak 长度**：`Vec3.clone()` 会丢掉放置信息，塔升编排诊断需要知道放置节点是否在路径里、执行器是否消费到它。逐帧实拍推翻第一轮登记：塔升放置链路完整工作（A* 规划塔升节点、执行器坑沿放置 <200ms、跨缺口续爬）——批34 原形态"放置成功后不接续"已随纯节点规则消失；残余改判为**缺口跨越后连续台阶的弹跳彩票**（探针 4 轮 3 绿 1 红），四处文档（known-gaps/development-plan/README/patches README/探针头注）同步。
- **MC-WORLD.md 刷新到批35 口径**：摘要停在批27 事实（tests 740/25 脚本/当前批=批27）——摘要重写、批25/批27 记录移入 `dev/archive/MC-WORLD-批次记录-2026-10~11.md`、当前批位换批35、`start-server.ps1` 的"PowerShell 5.1 解析失败"说法更正（本批 `powershell -ExecutionPolicy Bypass -File` 实测可用）；新增经验 65（决策规则的中间态拒绝必须验证隐含前提在每个出现场景成立）。
- 验收：`pnpm typecheck` 过；tests/mc 定点 mc-pathfinder-jump-decision + mc-spatial-actions 11 项绿。

## 2026-11-07 · 批35 G30 执行器专项（跳跃决策纯节点规则 + 精确重入分离；(a)(c) 关闭）

- **(a) 跳跃决策 = 纯节点规则（补丁新 `stepBlockOf`）**：批19 方向探测有亚格漂移盲区（±0.5 格漂移使探针落进邻格，跳跃键不按）。两轮中间方案被 200ms 真服探针逐轮否决：面距离+落地模拟+<0.6 死区（mine 1 绿 2 红——1:1 阶梯落点贴下一踏面，死区拒绝链式跳，退避把 bot 退下 1 格深台阶沿）；死区改动量门控 speed<0.12（仍 1 绿 2 红——着陆动量 1–2 拍内被摩擦吃掉，且落地模拟对贴面态结构性乐观而 Paper 静默回弹精确贴面，模拟不可信）。最终：下一节点为 1 格上步且有支撑即按跳，无距离带无模拟；撞面弹回交给既有退避，阶梯靠落地即再跳链式通过。真服：无坑 1:1 走廊爬升从永不完成变 13.7s 端到端。
- **(c) 精确重入分离**：tunnel 走拍前核验目标脚位支撑（block@1，规划地板落既有挖空 → UNREACHABLE 带归因快速失败，T0 mc-spatial-actions +1）；被测程序回程 goto tolerance 2→1（GoalNear 半径 2 把"井口内一格低一格"判到达）。
- **采集专项收敛**：批34 "东壁漏采与计数矛盾"判定为旧场地伪影（mine-b34-final 跑在场地修复提交之前的 e65086aa，探针客户端/服务端对拍当前场地仅 4 格种植矿）；collect NOT_FOUND 失败消息补带最后跳过原因（兑现其注释承诺）。
- **G30 残余 (b) 重登记** + 对拍探针 `dev:mc:tower-probe` 入库（creeper-probe 同例，`dev:mc:tower-probe`）。
- 验收：**mine 4/4 连续全绿**（returned/haul/ore_gone 全部服务端判决，returned 精确回起点）、climb 6/6、terrain-nav 6/6、upstream-nav 7/7（S3 首轮失败为 G28 已登记抖动，复跑即过）、shelter/night 抽查全绿；T0 新增 mc-pathfinder-jump-decision；tests/mc 109 文件 897 项全绿；`pnpm typecheck` 过。提交 9f1dc286。

## 2026-11-07 · 批34 审查轮（记录口径修正 + serverData 收敛）

- **轮次口径修正**（development-plan §10.3 与 known-gaps G30 同步）：mine 修复前为 11 轮回程全挂（returned ×10、shaft ×1，含 06-07/06-10/06-14 三轮调试），原记"六轮"；场地修复后为 3 轮 2 绿 1 红，原记"4 轮 2 绿 2 红"；探针为 v1–v10 十轮，原记"v2–v10"九个编号；shelter 实为 9/12（3 红集中在竞技场/断言打磨期，随后 9 连绿），原记"5/5"；night 5 绿 1 红。轮次经 task-runs 各批 summary.jsonl 逐条重读核对。
- **`scenario.ts` serverData 收敛为单行转发**：原包装函数体只 return，注释描述的却是 serverReply 层的回执形状合同——注释随合同归属下移。
- 验收：`pnpm typecheck` 过；tests/mc 定点 mc-spatial-planner 18 项、mc-goto-loiter 1 项绿。

## 2026-11-07 · 批34 任务级基线（三任务竞技场 + 服务端判决 + NoCloser 看门狗；G30 登记）

- **任务级基线 `dev:mc:task`**（dev/task.ts + task-programs.ts）：固定竞技场跑完整 Program（SHELTER 采木→合成→建屋 / MINE tunnel 下行→collect→回地面 / NIGHT 午夜清怪），终态由服务端判决——scenario.ts 新增服务端真值断言面（serverProbe/serverInventory/serverHealth/serverBlock/serverPos + 事件游标切窗替代旧"扫 40 条+关键字"）。三条纪律：准备与断言在宿主、程序只做玩法动作、失败强制归因（记录落 task-runs/&lt;batch&gt;/）。**程序吞错自报成功被服务端 returned 断言拦截**——基线纪律首轮即实证。
- **基线暴露 mine 回程 11 轮全挂 → 十轮探针（v1–v10）钉死根因链 → G30 登记**：几何排除（planCorridor 双向净空不变量，T0 锁死）、规划排除（route.plan 干跑带塔/禁塔都有路线）、执行器定罪（debugState 实证 12s 持路径却原地徘徊）——三个缺陷形态：shouldJump 角点探测亚格漂移盲区、塔升放置成功后重规划不接续（悬浮头节点）、GoalNear 早停不可精确重入。修复尝试 shouldJump 中心对齐扰动批19 实测 run-up 窗口，撤销留批35 专项。
- **随批落地**：goto.ts 圈禁看门狗（NoCloser→UNREACHABLE 12s，"在动但不靠近"不再烧满墙钟）；pathfinder 补丁只读 debugState 诊断口；场地自毁修复（矿石格 (12049,191) 恰是阶梯末级踏步块，collect 挖它=回程楼梯口被自己斩首——移至 (12054,191)，vein 改石头消除计数干扰）。
- 验收：场地修复后 mine returned 首绿（3 轮 2 绿 1 红，残余=G30 跳跃彩票 + collect 东壁漏采）；shelter 9/12、night 5 绿 1 红（围死方差，断言如实捕获）；climb/terrain-nav/upstream-nav 回归全绿；tests/mc rg 口径 100 文件 782 项全绿；`pnpm typecheck` 过。

## 2026-11-07 · 批32–33 审查轮（重复 retreat 收敛 + 无效扫描消除 + 测试断言补齐）

对批32/批33 自查一轮，修五处：

- **fight@1 撤退结算三处去重**：外层血量检查、外层 no_progress、近身段退段翻译三处重复的 withdraw 结算收敛为 `runRetreat(reason, anchor)`；返回结算值由调用点赋给 `ended`——闭包内赋值对 TS 控制流不可见，内联赋值会在 return 处触发类型误收窄。近身段冗余 `!` 断言（`if (nearest == null) continue` 后已收窄）一并清理。
- **explore@1 原地软记账迭代不再重复观察/扫描**：位置未变的迭代（plan 判不可达换批、判死记账）跳过 region 入图与 until 扫描——原地没有新信息；封闭/贴墙场景的软记账轮次从 ~0.4s/轮降到 ~0.1s/轮。`scanned` 语义随之收紧为"只计真实扫描"（capabilities.md 实现说明同步）。
- **测试断言补齐**：mc-capability-fight 补两条核心语义断言——近身段的 apply 确实携带 `attack`（ControlInput 派发，非证据窗）与非攻击拍 `use` hold；此前没有任何断言覆盖"攻击真的派发了"。
- **harness 死旋钮清理**：`feedbackMaxFrames`（无测试消费，帧上限硬编码 400 兜底）与 `onNearApply` 的 `frameIndex` 参数（无消费者）删除。
- 验收：typecheck 过；tests/mc 过滤器口径 107 文件 892 项（唯一 FAIL 为 mcp-extension-loading 环境预存）；真服 `dev:mc:combat` 8/8（B04 本轮 hp 20→20 零擦伤，retreat 路径 B02/B05 正常）、`dev:mc:explore-frontier` 4/4（traveled 24.22 与批32 记录一致）。

## 2026-11-07 · 批33 fight@1 近身段 feedback 流迁移 + 苦力怕 fuse 感知（G29 主体关闭）

- **feedback 流迁移（G29 ①）**：近身段从"每拍 withBody + drive BEAT_TICKS"改为一次 withBody 持有 + feedback 流连续物理拍——键位每物理拍重装，扫描/决策不再造成键位空档（占空比 ~100%，原 ~50%）。段内每 300ms 重扫结算击杀/缺席/撤退/进度（assess 助手共用），steering/攻击/举盾逐拍应用。
- **fuse 感知（G29 ②）**：`entities@1` 新增苦力怕 `ignited` 事实（driver 捕获 metadata[16]）；三处消费——引燃目标不进攻击节奏、近身段硬危险立即拉开持续续锁、**外层追击分支拒绝回追引燃/锁定中的苦力怕**（creeper-probe 实证：不认识 fuse 状态的追击造成逃离/追击振荡，净拉开 ≈0）。
- 验收：B04 五轮 hp 18.83–19.47（批29 包络 13.4–20；验收线收紧到 ≥18）；mc-capability-fight 重写 11 项（feedback 流替身）；tests/mc 107 文件 892 项（唯一 FAIL 为 mcp-extension-loading 环境预存）。击杀路径（targets_cleared 击杀苦力怕）未达成，残余见 known-gaps G29。

## 2026-11-07 · 批32 explore@1 前沿覆盖重写（四向游标退场，M6/批次 B 收口）

explore@1 从四向 24 格腿游标替换为前沿覆盖探索（refactor-v2 M6，01-DESIGN §6"不建第二世界数据库"落地）：

- **`shared/explore.ts` 重写**：`ObservationMap`（region 观察盒水平 ±16/竖直 ±3 入图，格状态 air/water/lava/solid，-1 未加载不入图即未知；visited/dead/attempts 三账本）+ `rankFrontiers`/`pickFrontier` 确定性评分（未知邻增益 − 距离 − 岩浆危险 − 失败记账 + direction 偏置；top5 走 route.plan 只读估价重排，全部候选被判不可达时零派发软记账换批）。旧 `ExploreCursor`/`LEG_DISTANCE` 整体删除。
- **`actions/explore.ts` 主循环** = 观察→until 扫描→选前沿→goto（容差 2、不挖不垫）；单格失败只判死该格（UNREACHABLE 立即，TIMEOUT/plan 两次），不封方向；跨维度 `WRONG_STATE` 守卫。公开合同 explore@1 schema 与失败码不变，三个失败码语义改按覆盖事实表述（capabilities.md 同步）。
- 验收：T0 重写 mc-explore 26 项；真服新增 `dev:mc:explore-frontier` 4 步全绿两轮一致（之字迷宫跨 90° 弯寻获首扫不可见的 diamond_ore，traveled 24.22、服务端 gap 24.2；地下实心岩层密封室 180ms 诚实 UNREACHABLE、服务端位置未动——旧游标该迷宫首轮全向判死、密封场景语义上"四方向用尽即穷尽"）；terrain-nav 6/6 回归保持。tests/mc 过滤器口径 107 文件 890 项（唯一 FAIL 为 mcp-extension-loading 环境预存，stash 对照与本批无关）；`pnpm typecheck` 过。

## 2026-11-07 · 批28–30 审查轮（死字段清理 + 记录口径修正）

对批28–30 自查一轮，修四类问题：

- **`StanceParams.engageDistance` 死字段删除**（mobility.ts）：批29 把追击触发统一到出手门限 3.2 后，stance 的"接战距离"档（2/3/1 格）不再有任何运行时消费者——按"未接线机制应删除"处理。同步：mc-mobility 的 stance 表断言、capabilities.md §4 fight 表删"距离"列并注明（出手间距由服务端 3 格实体交互上限统一决定）。
- **测试计数修正**：批29 条目 868→869 项、批30 条目 100/777→107 文件/873 项，统一为 `vitest run tests/mc` 过滤器口径（与批27 的 103/853 同基，含 tests/mcp-*）；计数经各提交点 `git grep -c "\btest("` 与 HEAD 实跑双重核对（纯 tests/mc 目录为 95/96/98/99 文件）。
- **清洁**：combat-steering 的 `slotDir` 收回私有（无外部消费者）；dead-entities 测试的 Harness 接口删未用 `identity` 字段；dev/build.ts 末尾空行；四处测试文件的导入排序。
- 全仓 vitest 3276 项通过（唯一 FAIL 为 tts httpx 环境缺失同类）；`pnpm typecheck` 过。

## 2026-11-07 · 批30 施工站位分区批量（多站位真轮转 + 走位按站位批量 + 轮数放开）

build@1 放置调度三处替换（`capabilities/actions/build.ts`）：

- **只试首站位 → 站位真轮转**：旧 `vantageCandidates` 声称"候选按序尝试"，实际只走 `vantages[0]`——盒中心被占/走过去仍够不着时整格 failed。新调度每轮做一次**站位分区**：候选序 = 当前脚位（零走位组，站着的地方无需可站性核验）→ 盒中心 → 四侧 pad1/pad2（世界核验可站），每格取第一个几何射程满足的站位，同站位格一批执行。
- **逐格走位 → 每站位一走**：旧实现每个够不着的格付一次完整 walk（`walked` 集只保证同格不重复）；新调度走一次到站位、站位内所有格连续放（组内按列自下而上保持——成品列是墙，寻路只绕行）。走失败整组如实 defer，下一轮按当前位置重分区。
- **固定 4 轮 → 收敛终止**：支撑链深度（悬挑、门顶）不再受轮数限制——defer 格带因（`no clickable support face yet` / out-of-reach 细节 / 走位失败）进下一轮重分区，真实终止 = 一轮零建成；上界 16 轮纯安全网。几何无解格如实 `no candidate vantage within reach`（T0 断言与"无支撑面"可分辨）。

`ready 集显式预测器不做`：列内自下而上 + 中心向外 + 站位分区已覆盖其排序价值，全格 DAG 是过度设计（01-DESIGN §5 "只构建真实依赖"）。T0 新增 `mc-construction-vantages`（候选序/13 格长墙分区/orphan 判定 3 项）；`mc-capability-build` 的无支撑格断言按新原因更新。真服 `dev:mc:build` 13 步全绿（新增 11 格长墙步：两端格超出单站位射程，分区经 pad 站位 22 格 11.6s 建完——旧代码这两格必 failed）。tests/mc 过滤器口径 107 文件 873 项（含 tests/mcp-*）、全仓 3276 项通过（唯一 FAIL 为 tts httpx 环境缺失同类）；`pnpm typecheck` 过。

## 2026-11-07 · 批29 战斗近身拍重构（证据窗冻结解耦 + Context Steering + deadEntities 缝）

fight@1 近身段从"攻击 + 600ms 证据窗冻结 + 冷却睡眠"（站桩 ~2s/拍，无任何走位）重构为**连续控制拍**（~250ms/拍，边打边走）。三件套：

- **16 槽 context steering**（`capabilities/shared/combat-steering.ts`，算法：Game AI Pro 2 第 18 章，对照 Cortico combat-context.ts，MIT 归属）：interest = 向目标推进 + 切向绕走（2s 换向迟滞），danger = 各敌对接近度叠加；苦力怕进 fuse 半径硬遮罩朝向它的槽并进入 3s 锁定期，锁定期转身背向冲刺拉开（原版后退不能 sprint——面朝威胁的后退与苦力怕同速，永远跑不出 fuse 半径，对拍实证）、no_progress 时钟冻结。纯函数 T0 13 项。
- **`deadEntities()` 身体缝**（contracts/body.ts + public-api §4）：PlayerPort 持有连接级 entityDead 累积（跨资格会话有效，断线/化身更换清空），BodySession 只读视图，scoped-body 只读直通。击杀归属从阻塞式证据窗解出：目标缺席 + 死亡观察命中 = 击杀；连续 2 次缺席且无死亡观察才 target_lost（给死亡事件留到达窗）。攻击不再等证据——冷却好且 ≤3.2 格随 drive 同拍派发（原版实体交互有效距离 3 格，ENTITY_REACH=4 只是 attack@1 派发上限）。
- **追击交接重定**：goto 在 3 格停手交棒给拍循环（对拍实证 goto 冲到 0.12 格贴脸，引燃后无处可逃；2 格交棒则留下键位空档站立窗被追到 1 格炸）；追击触发线统一为"能否出手"（3.2）——engageDistance 只作站位/撤退语义，否则 aggressive 的 1.6 触发线与 3 格交棒错位导致追击空转 no_progress。

**对拍定案**（`dev:mc:creeper-probe`，100ms 外部采样 + 苦力怕 metadata 变化，一轮抓全）：引燃信号 = metadata[16]→1；修复前 keys=FS 全程未断、bot sprint 冲到 0.12 格站到爆炸；修复后交接过冲→引燃→转身逃离→残余爆炸擦伤。场景污染教训入库：爆炸在持久世界留弹坑改变交战几何，B04 步骤先局部重建场地再开打。**真服 combat 门 8/8 连续两轮**（新增 B04 苦力怕步：验收线 = 实测包络 hp ≥10，干净场地实测 13.4–20；B06 stop 抢占步：会话中 stop → INTERRUPTED）；三僵尸/格挡/围死/aggressive-4/目标失踪 5 步原语义保持。tests/mc 过滤器口径 106 文件 869 项、全仓 3272 项通过（唯一 FAIL 为 tts httpx 环境缺失，与批26–28 同类）；`pnpm typecheck` 过。**残余登记 G29**：无伤击杀苦力怕需要 feedback 流占空比 + fuse 状态感知（metadata[16] 已定位），归 M4 后续切片。

## 2026-11-07 · 批28 关闭 A* think budget 残余（启发式加权：山头穿越从 5s Timeout 到实机到达）

G25 关闭时登记的 M2 搜索预算项**搜索半部关闭**：24 格山头穿越 A* 5s think budget 搜不完（5.8 万节点诚实 Timeout）的根因定性为**启发式引导缺失**——欧氏启发式在爬升地形严重低估真实代价，无偏置 A* 沿山体等值线泛洪。真服画像（新增 `dev:mc:nav-perf`：gain-16 山头目标直接驱动 getPathFromTo）实测定案：w=1 → 10,974 节点/428ms；w=3 → 556 节点/11ms（÷20），路径代价 +6.7%、步数更少（46→43），跨次完全确定；平地/水域对照无害（w≥2 节点均 ÷10 量级）。**修复 = `patches/mineflayer-pathfinder@2.4.5.patch` 新 hunk `heuristicWeight`**：加权 A* 只改扩展顺序——g 代价、移动合法性、isEnd、bestNode 选择（h 单调）全部不动；`searchRadius` 的 maxCost 剪枝保持 raw 启发式尺度（初版误用加权 h 对 raw maxCost 剪枝，start 处即全剪枝，T0 当场抓出后修正）；默认 1 = 上游原序，`driver/mineflayer/pathfinder.ts` `applyMovementsConfig` 单一口径设 3（规划与执行共用，S2 接缝不漂移）。**端到端**：真 goto 山头目标 28.5s 实际到达（gap 1.70）——原失败形态 5–10s Timeout 零到达。**验收**：T0 新增 `mc-pathfinder-heuristic-weight`（曼哈顿锥形山、山后目标：默认=上游原序逐节点一致、w=3 节点 ÷8、真实 g 代价有界、maxCost raw 口径可达峰顶）；真服 `dev:mc:upstream-nav` 连续三轮 7/7（gate 4520–4536ms、S3 4536–5041ms、S4 9596–10119ms——加权路径略长使执行慢 1–3s，属"代价换搜索"的正常反映）、climb 6/6（三级阶梯 4442ms）、terrain-nav 6/6；tests/mc 104 文件 854 项、全仓 3257 项通过（唯一 FAIL 为 tts-bridge-protocol 的 httpx 环境缺失，与批26/27 同类）；`pnpm typecheck` 过。**S3 水中爬岸方差不随本修复关闭**并拆出登记 **G28**：该几何 A* 搜索本身毫秒级，批28 当日 w=1（与本补丁严格等价）亦两轮 TIMEOUT，加权后 4536–5041ms 到达——方差主体在水节点出发的移动控制与规划交互（归 M3/水域控制工作项），不在搜索规模；S3 断言保持 20s 不放宽。诊断基建：upstream-nav 的 nav() 增 2s 位置轨迹采样与搜索指标失败输出（区分"原地打转"与"绕行不达"，terrain-nav 同款）；冷启动首轮 S2/S3 双失败未在后续 6 轮复现，如实记录不解释。

## 2026-11-07 · 批27 关闭 G26/G27（upstream-nav 真服门 7/7：场景几何改判 + 挖确认不撕路径）

批26 登记 S3/S4 两开放项经事件级实证**双双改判**并修复，`dev:mc:upstream-nav` 7/7 全绿，climb/terrain-nav 回归保持。

- **G26（S3 游上岸被中止）**：登记的"运行时无因中止"不成立。signal abort 堆栈（stackTraceLimit 还原后抓取）+ survival 触发事实 dump 实证：中止者是生存系统对**真实溺水**的正当介入（`survival.ts` → `runtime.intervene` → safety 主动打断）。探针对拍：S3 的"1 深水洞"水洞正下方 198 层是虚空（平台只铺 GY 一层），bot 掉穿平台从 y=199 一路落到 y=99 的真实自然水域；服务端 Air 与客户端 `oxygenLevel` 读数一致递减（112→81→…ticks ↔ oxygen 7→5→…），头部浸水 ~16s 后氧到 4 → 溺水触发完全正当；运行记录 `control:"none"`、无 stop_intent 是 safety 介入后 run 的正常结算路径，运行时（engine/body-queue）零改动。修复 = 场景几何：S3/S4 水洞下方铺底（GY-1 层 stone）+ setup 校验 server Pos 稳定在洞位（掉穿即 setup 失败，不再把落水误当"站在水洞"）。批26 记录"独立诊断 REACHED、前置门/栅栏门是唯一差异"的归因有误。
- **G27（S4 挖穿 dug=0）**：登记的"计划/执行代价分歧"不成立——事件级对拍（path_update 采样）证明 route.plan 与实机 A* 同 Movements 口径、同一条解（2 高墙下"挖头层 1 格+跳半墙+跳水洞"合法且比挖 2 格平穿便宜，needs.dig=1 两侧一致；"挖是唯一近路"的场景几何前提错误）。真缺陷是**挖掘完成计数丢失**：pathfinder 全局 `blockUpdate` 监听（先于 digging.js 的 per-dig 监听注册）把自己挖掘的确认更新当世界变化触发 `resetPath('block_updated')` → `stopDigging`，`diggingAborted` 与服务端确认同毫秒到达、抢在确认回调之前，terminated 守卫吞掉 `diggingCompleted`（dug=0），resetPath 清掉含 toBreak 的路径后 A* 看到"头层已开"重规划，脚层永不挖。修复 = `patches/mineflayer-pathfinder@2.4.5.patch` 新 hunk：`digging` 期间跳过 `block_updated`（自己挖掘的确认是计划内进展；挖掘窗口内的世界变化由下次重规划吸收，patch-commit 重新生成完整补丁）；S4 场景几何改为 17 宽墙身 + GY+3/GY+4 封顶两层（"挖上两层爬墙"需 3 格挖掘且无净空，挖 2 格平穿明确最廉）；断言按目标行附近 3 列核对（A* 按对角启发式在等价列中选列，单列断言会误报）。
- **同期收尾**：`dev:mc:upstream-nav` 补进 package.json（批26 记录声称新增、实际缺条目）。

**测试**：真服 upstream-nav 7/7（S4 route.plan 与实机同解 needs.dig=2、dug=2、脚层通、7.1s 到达）；climb 6/6、terrain-nav 6/6 回归保持；tests/mc 103 文件 853 项全绿；全仓 3256 项通过（唯一 FAIL 为 tts-bridge-protocol 的 TTS 伴生环境缺失，隔离跑 skip，与批26 记录同类）；`pnpm typecheck` 过。

**批27 审查轮（同日）**：S1/S2/S4 场景地形构建 92 条 setblock 收敛为 5 条 /fill（与文件内 fill 惯例一致，单轮省约 26s，门位留空语义不变）；真服重跑 7/7 验证（S4 挖穿 dug=2/7.3s、S3 12.3s）。S3 水中爬岸耗时方差（3472–25194ms，五轮两次>13s、一次 TIMEOUT）如实补登为 M2 搜索预算工作项第二形态，S3 断言保持 20s 不放宽（known-gaps §4.1）。

## 2026-11-06 · 模型出口瘦身（完成投影 / 读取 / 诊断 / 发现）

模型可见的四处出口此前按"内部完整形状"直接序列化：同一个事实写三遍、诊断日志整段进上下文、能力只能靠盲搜。本条目只改投影层，不动 Runtime/Driver 语义，不加参数、不加机制。

- **完成投影**（`executor/delivery.ts:formatCompletion`）：不再把 `CompletionView` 原样展开，改为按 phase 收窄的展示投影——finished 给 `outcome/progress/value/error/unknownEffects/interruptedChildren`，awaiting_decision 给 `decision/reason`（decision 是 `runs.continue` 的唯一凭据，不能省）。删除 `requestId`/`segment`/`revision`/`recordBytes`/`reportKind` 与 `content`+`snapshot` 三层包装。正文读不到或过大（`record`/`unavailable`）时保留 `detail` 与 `progressComplete`/`reasonComplete`/`messageComplete` 截断标志，并输出 run 自身的 `error`；`unavailable` 不再指 `record` 这条注定失败的 nextCall；decision 分支不给 nextCall（continue 的 `entry` 由模型写，不能预填）。真实样本 2187 → **468** 字符。
- **读取**（`capabilities/queries/body.ts`）：`inventory@1` 的物品项省略值为 null 的 `stackSize`/`components`/`durability`，slots 与 held/armor 共用 `compactItem`；`{since}` 的 `changes` 保持原形状（差量语义是变更后的完整物品）。20 格样本 2677 → **1948**。
- **诊断**（`executor/facade.ts:platformStatus`）：`runs {op:"status"}` 无 run 时，ready 且无 fault 省略 `diagnostics.tail`（内部上限 64KB），故障时只给末 2000 字符；`delivery` 收敛为 `pendingCount`/`error`。其余 `side`/`fault`/`policy` 字段不动（真服验收脚本依赖）。
- **发现**（`companion/directory.ts`）：无参 `describe` 保留 families 并一次给出 `reads`/`acts` 两组能力 ref（51 个名字 717 字符），不再中转 `nextCall`；空结果带 `hint`；capability 单条删 `digest`/`toolExamples`/`programExamples`（示例只有 descriptor 里的 input/output 对），程序/蓝图/经验分支的示例保留。指南里「先 runs.status 确认 control」不可执行（该投影从不返回 control），改为「先 runs list 找」。

**测试**：新增 `mc-status-projection`（ready 无 tail / faulted 2000 字符尾）；`mc-delivery-pump` 加 inline ≤800、降级截断标志、decision 不带 nextCall 三组断言；`mc-capability-queries` 加"槽位字段不为 null"；`mc-library-directory` 加"无参一次给全 51 个 ref ≤1600 字符"。tests/mc 95 文件 **740/740** 全绿（vmThreads，maxWorkers 4）；`pnpm typecheck`、`check:boundaries`、`biome format` 通过。

## 2026-11-06 · 批26 mineflayer 生态依赖审查收尾（M0 五项裁决落地：mineflayer 补丁接线 + 门/水/挖确认真服门）

M0 依赖审查（逐文件亲读上游 2.4.5 全部 lib + Cortico 对照 + 已装版本离线定谳）的落地收尾。**接线 `patches/mineflayer@4.39.0.patch`**（原遗留草稿）：挖生命周期单终态化——完成=服务端把该格改成**类型不同**的方块（含水留水算、纯状态变化与 (null,null) 不算），取消/预算 max(8s, digTime×3) 互斥且共用同一清理，`targetDigBlock` 保持到终态（修复 4.39.0 现存缺陷：finish 包发出即清空 → 确认窗内 stopDigging 失灵 + 看门狗挖掘豁免丢失），迟到事件 terminated 守卫忽略；`bot.dig` 不再本地伪造空气——旧实现服务端拒绝也算挖成，执行器会走进实心墙。`place_block.js` 拒放抛 `err.refused=true`（执行器只把显式拒记录进 placeMisses 黑名单，超时不记）。**配套修复**：prismarine-item 组件附魔归一化的 pathfinder 侧断链补全（`bestHarvestTool`/`safeOrBreak` 旧读 `tool.nbt`——1.20.5+ 组件物品 nbt 为空，效率附魔整体丢失）改 `tool?.enchants`；108 种方块的工具等级材料修正（`driver/mineflayer/upstream-fixes.ts`，minecraft-data 3.117.0 的 1.21.11 数据错标 `incorrect_for_*`，铁镐挖铁矿 4.55s→0.75s，login 时装配）；顶层 `vec3@0.1.7` 删除（adapter 改走 mineflayer 解析链，生态统一 0.2.0）；执行器门流程修复（activateBlock 按 bot 方位传交互面——默认 UP 被 1.21.11 视线校验静默拒绝；开门后轮询客户端门状态而非单次读回——视图滞后不再引发开关振荡；`postProcessPath` 的 useOne 节点不再中断吸附——此前门后全部节点保持原始整数坐标，机器人朝方块角点走进开面板与墙的碰撞带楔死；直线模拟失败不再冻死——碰撞滑移解决擦碰，futility 兜底死胡同）；Movements 游泳起跳面统一取 node.y（平台悬空水洞场景 block0 为空气，取其高度会拒绝 1 格岸跳）。**新增真服门 `dev:mc:upstream-nav`**（7 步：闭木门/栅栏门穿越、1 深水游上岸、邻水墙挖穿、拒放避让、全宽沟槽无料诚实失败、性能采样）——本批 **5/7**：门 2379ms open=true、栅栏门 3309ms open=true、拒放避让 2515ms 邻位到达、无料 UNREACHABLE 5064ms 不进坑；开放项登记 **G26**（多步场景 goto ~3.3s 被运行时中止 control=none——独立诊断同几何 REACHED，规则本身真服验证通过）与 **G27**（实机 A* 绕开挖路，route.plan 给挖 needs.dig≥1 而 dug=0），均归执行器/M2 层。**删除**：顶层 vec3 依赖、tmp 审查探针。**测试**：新增 mc-upstream-dig/mc-upstream-materials/mc-upstream-digtime/mc-pathfinder-{enchanted-tool,cache,doors-water,place-miss}/mc-goto-empty-path + mc-wall-gap-aabb，tests/mc 102 文件 847 项全绿；`pnpm typecheck` 通过。mineflayer 补丁体系与 Cortico 对照及五项裁决全文见 patches/README.md 与 refactor-v2 审查记录。
## 2026-11-06 · 批26 战斗撤退诚实结算（fight@1 增 retreat_failed，B05 关闭）

`fight@1` 的撤退拍此前把"尝试过撤退"当"已脱险"：`withdraw` 只返回终点，四个调用点不核验即结算 `retreated` 成功（01-DESIGN §4.2 点名的假成功）。

- **withdraw 核验化**：返回 `{cleared, at}`——脱险判据 = 背向 anchor 拉开 ≥16 格 **且** 结算扫描无 ≤8 格贴身活跃敌对实体（`RETREAT_NEAR_RADIUS=8`）；原 early-return 并入单一结算路径。
- **ended 枚举 +1**：撤离未脱险如实返回 `retreat_failed`（仍带 kills/hp/at，`retreated` 字段保留为撤退原因，与成败正交）。输出 schema 纯增量，既有消费者（比较 ended 字符串的 Program/测试）不受影响；modules/capabilities.md §4 fight 同步。
- **顺带修复**：开场低于接战线撤退路径的 `at` 从裸 Vec3 统一为 `{position, dimension}`（与会话结束路径、descriptor 示例同形）。
- **T0**：`mc-capability-fight` +2（逃跑腿全被拒 → retreat_failed；拉开距离但威胁追到贴身 → retreat_failed），harness 增 `gotoFailure` 钩子；tests/mc **94 文件 / 832 项全绿**，`pnpm typecheck` 通过。
- **T2**：`pnpm dev:mc:combat` **6/6**——新增围死步（7×7 两高石墙 + NoAI 僵尸 + 低血量接战门）真服实证 `retreat_failed(low_health)` 且位置仍在围栏内；三僵尸/aggressive 步按诚实结局空间更新断言（balanced maxTargets=2 的清场、第 4 杀证据窗口竞态如实 target_lost 不虚报）。场景两处环境缺陷一并修复：自保"低血+2s 新伤"窗口内开打会被 safety 抢占（伤害后等 2.6s 再测）；围死步清理缺失会跨步骤/跨轮毒化开阔地步骤（restore 增围墙体积清除 + finally 保证清理）。
- 关联缺口：B05（逃跑失败/敌人短暂失踪不许假 retreated）的场景验收落地。

## 2026-11-06 · 批26 G25 关闭（refactor-v2 首切片：搜索层切角对角线根治 + Movements 口径收敛）

执行包 `refactor-v2/`（2026-11-06）默认首切片。**根因推翻批22 假设**：事件级 trace 证明实时 A* 与 planPath 的 Movements 配置逐项相同、路径一致（7 节点 success，前 1s 正常走出）——问题不在配置漂移。真根因两层叠加：**搜索层**上游 `getMoveDiagonal` 只校验两条正交角线中便宜的一条（`min(cost1,cost2)`），实体角格在未校验侧被放过 → A* 产出贴角对角线；**物理层**prismarine-physics 把移动钳到与实体面恰好贴上（gap=0），而 Paper 1.21.11 静默拒绝恰好贴面的位置（无 moved wrongly 日志）→ 服务端回弹，挤压净位移≈0（无 pathfinder 自由探针实证 ±0.02 振荡）→ 每 3.5s `resetPath('stuck')` 重搜同一路径无限循环 → 看门狗 10–12s UNREACHABLE。

- **补丁**（`patches/mineflayer-pathfinder@2.4.5.patch` 新增 `lib/movements.js` hunk）：对角线两侧角线的脚/头格必须 safe，否则拒绝该对角线——计划/执行的合法性不再依赖贴边滑移的脆弱机制（S2 诚实性）。平原地形角格全空不受影响；山地地形柱旁实体角格是此前触发条件。
- **上一会话遗留补丁入库（批26 审查轮定稿）**：`patches/prismarine-physics@1.11.1.patch`（`WALL_GAP=1e-5`——Paper 1.21.11 静默拒绝恰好贴面位置，未打补丁时墙面滑动/台阶面/1 宽挤压全部被服务端回弹钉死，即探针观察到的楔死机制）与 `patches/prismarine-item@1.18.0.patch`（1.20.5+ 附魔组件形状归一化，digTime/getEnchantmentLevel 消费者）随 patch-commit 正式进入 workspace/lockfile。pathfinder 补丁文件在编辑目录重建时被 pnpm 重新生成为 **589 行完整描述**——除 G21/G25 hunk 外完整收录了此前只存在于安装包中的规划器强化包（搜索分块缓存、门/水语义、显式拒绝放置黑名单、goto noPath 诚实拒绝、附魔组件兼容、栅栏门 toPlace 穷尽守卫、equip 拒绝释放锁）；审查轮以 pristine+patch 重建并逐文件 diff 验证与安装包**零分歧**（此前 193 行旧版与安装状态不一致，干净重装会丢失约 150 行未入库改动）。全部 T2 验收在最终补丁集上执行。
- **遗留草稿登记（后由依赖审查轮接线，见下一条）**：`patches/mineflayer@4.39.0.patch`（挖方服务端确认 + 放置拒绝标记）未接线未应用，留待 M1 工作包决策；见 patches/README.md。
- **适配层收敛**：`driver/mineflayer/pathfinder.ts` 三处 Movements 字段赋值（configureMovements/planPath/planEscape）收敛为 `applyMovementsConfig` 唯一口径；planEscape 保持原语义（不挖不垫、sprint 构造器默认、maxDropDown=1）。
- 验收：真服 `dev:mc:terrain-nav` **6/6**——山地 lane 绕柱三次独立 **2015/2100/2010ms 实际到达**（基线 12.1s 零位移 UNREACHABLE），树绕行 7.1→4.5s、digThrough 9.6→5.1s、explore 25→32 格；`dev:mc:climb` **6/6**（三级阶梯 7318→4606ms，G21/G24 场景不变）；全仓 vitest **3231 项通过**（其中 tests/mc 94 文件 832 项；2 失败为 tts httpx 环境缺失 + map EPERM 竞争抖动，隔离均绿，与本改动无关）；`pnpm typecheck` 通过。诊断方法：临时 trace 场景挂上游 path_update/path_reset 原始事件 + 200ms 控制采样（用后已删）。
- **残余登记**：24 格自然穿越在目标位于山头时 A* 5s think budget 搜不完（5.8 万节点后 Timeout 诚实拒绝；此前已实际走完 ~26 格山地）——**搜索加速属 M2 性能工作项**（Cortico pathfinder-perf 对照领域），非正确性缺陷；known-gaps G25 关闭条目中保留证据。

## 2026-11-05 · 批25 多世界自治 v3 第一阶段（M1 数据根 + M2 长驻 World 连接控制 + M3.1 离线资料）

《多世界自治设计 v3》全文入库为 [multi-world-v3.md](multi-world-v3.md)（即批24 点名的方案 02 施工合同；本文记录落地事实与偏差，现行合同以 public-api 批25 实现说明与 modules/executor.md §3/§7 为准）。

- **M1 双根**：`Executor.open` 改收 `ownershipDir`（稳定 MC 根，Windows 目录 Job 跨 Profile 唯一，I1 单活跃写源）/`sessionDataDir`（`sessions/<profileId>/` 的 executor.db/runtime.db/runs/exports）/`sharedDataDir`（world-history.db 与 library/ 共享根）；CompanionInit 双根化，伴生按根派生。**取代 2026-10-18"数据布局固定"条的单根并列布局**——world-history.db/library 留共享根，其余归 Profile 根。
- **close 三事实**：`close()` 返回 `{process, ownership, runtime}`，脏关闭不再抛 `EXECUTION_DOMAIN_UNRETIRED`（该码保留给 Runtime 发起的 retire_required 路径）；只允许新执行域的必要条件是 process=retired && ownership=released；未证实的结论可重试（人工恢复渠道，无时间兜底）。
- **M2 会话层**：`worlddef/session-identity.ts`（canonicalHost / profileId=sha256 定长数组 / settings.json 每次 connect 重读 / identity.json 不可变 + observed.json 可更新 / listProfiles 扫描 / 旧布局一次性迁移——executor.db 为身份锚点、带标记可续、binding null 保留 unbound 字面量）+ `worlddef/session-controller.ts`（唯一会话生命周期拥有者：串行管理槽、并发 SESSION_BUSY、同 Profile ready 幂等、blocked 引用保留、bodyId=`minecraft:<visitId>`、onStop 最终收口）。工具面新增 `session` 动作（status/list/connect/disconnect）；World 启用默认不入服；observe/run/chat/runs 无会话 NOT_CONNECTED；`connection.wait` RPC 提供入服终态回执（open 成功不再冒充入服成功，I4）。
- **M3.1 离线资料**：describe 上移宿主（直读静态 Catalog）；Library 收敛宿主常驻唯一写入口（Companion 只读、`program.changed` 窄通知、save.from 经活动 Executor RPC + Profile 根快照直读 `readRunSnapshot`）；`program/validator.ts` 离线校验复用同一 worker compile 路径。
- **两处真实缺陷**（探针定位）：connection.wait 悬挂 setTimeout 拖住伴生事件循环——优雅关闭后伴生不自退、waitRetired 超时被迫 terminate → unclean → 同 Profile 重开转 owner_lost，清理定时器后 close 55ms 且 clean；acquireOwnership 跨 VM realm 的 `instanceof` 判定失败使 vmThreads 下 DATA_DIR_BUSY 被吞——改为按 code 鸭子判定。经验：**新增常驻 RPC 的悬挂定时器会改变进程退役事实；错误码合同跨 realm 只认属性不认原型**。
- 验收：新增 mc-session-identity 10 / mc-executor-roots 3 / mc-session-controller 6 项；mc-native-host 重写为 T01/T02 语义；tests/mc vmThreads 85 文件 **716/716** 全绿，`pnpm build` 通过；真服 `dev:mc:session` **6/6**（T01 启用未连接 / connect→ready / disconnect 同 Profile 重访 / 同服换离线用户名新 Profile / 连失败端口回滚 / 会话内 /stop）。审查轮（a0c9a596）收紧 connectTarget 判别、身份期端口校验、统一关闭态 WORLD_DISABLED、清理死代码（伴生 describe RPC、LEGACY_FILES、ResolvedTarget.source）。
- 批26 剩余：RuntimeArchiveReader、profile 查询参数、跨 Profile 离线 saveFromRun、DeliveryPump profile/visit envelope、完整 M4 迁移仪式（多 launch unbound 分区归档）。

## 2026-11-04 · 批24 基础重构收尾（方案 01 剩余 R3/R4：F4 静态 Catalog + F5 Driver 分离）

- **F4 能力目录**：`capabilities/catalog.ts` 定义 `CapabilityDefinition`（query：descriptor + bind(deps)→reader|null；action：descriptor + bind(deps)→invoke）/`MinecraftCapabilityModule` 合同；目录创建时一次性校验（模块 id 唯一、ref 全局唯一、AJV 编译输入 schema，坏模块拒绝激活而非首调才炸）；12 查询 + 23 动作文件改为模块自带 descriptor+bind 配对，删除 QuerySpec 注册方式与 `shared/query.ts`，不留兼容层。`describeDirectory` 改收 catalog：`allDescriptors()` 无 deps、无执行域即可列出全部能力（多世界离线 describe 的直接前置）。worlddef 的 `chat` 工具 schema 与 chat@1 descriptor 同源。
- **F5 Driver 分离**：`driver/input/{vehicle,walking}.ts` 从 `body/session.ts` 整体搬出（载具运动学/50ms 节拍/输入中和；步行键位安装撤销/physicsTick 消费/停滞看门狗），效果合同与取消语义逐字保留，session.ts 1737→1453 行；RuntimeEngine 不拆（"文件长度不是重构理由"裁决维持）；worker 超限错误文案改引真实配额。
- 审查轮（d4800486）：catalog 激活门 AJV 选项补 `addUsedSchema:false` 与运行时门对齐；删 `buildCapabilities` 别名（13 个测试文件迁到 `builtinCatalog.bind`）；mc-region-query 改按 ref 查找定义；文档漂移修复（46/51 计数沿革、session.ts 行数）。
- 验收：mc-capability-catalog 6 项；tests/mc 82 文件 699 项全绿；真服 `dev:mc:review` 6/6、`dev:mc:k8` 16/16、`dev:mc:mobility` 5/7（两个失败步骤经 fa174a05 基线对拍同样失败，环境/场景固有，如实登记）；`pnpm build` 通过。

## 2026-11-04 · 批23 审查修复轮（11+5 项，五个 PR）

- **断线证据链**：FactsSource 在 host disconnected/faulted 时先 capture 断线证据再封源（旧实现 end 监听因 attachedBot 已清空而空转——断线从不入库、importantEvents 推送死路）；主动关闭记 reason=closed。
- **聊天 channel 对齐合同**：whisper/chat 按内建模式分流 private/public，messagestr 按原始消息对象身份去重，未匹配格式如实 unknown（playerChat sender 记 uuid 不冒充 name）——public-api §events 的 channel 枚举自始如此，实现此前一直违反。
- **事件投递**：minecraft_event/digest 投递失败 1s 补发一次（幂等 id）。
- **生存介入重试**：锁存改 {key, retryAt}——确认安全锁存到危险事实消失，失败冷却 1s 可重试；新伤害换 key 立即重试；faults 诊断 32 条上限。
- **游戏断线恢复**：recover() 在执行侧进程健康但 side.connection disconnected/faulted 时退役重建执行域；旧 Run 不重放，connecting/syncing 不重复连接。
- **扫描预算**：findSkyAccess 4ms 时间预算让出 + AbortSignal 停止屏障；下界跳过无意义大扫描。**地图导出**：唯一 tmp + link 容忍 EEXIST；启动清理上一会话派生图片。**Watch 类别化失效**：游标=依赖类别修订和值（inventory@1 等待不再被物理拍 20Hz 唤醒），公开合同不变。
- **简化批**：nativeGuide 4.3KB→1.75KB；删 `scaffoldsUsed` 占位字段；删 `PROGRAM_POLICY.workerCount` 零消费字段；未绑定世界启动警告；慢读诊断（>100ms 警告、10s 抑制）。
- **不做**：P1-9 大查询异步快照（先测量再定）；engine.ts/body-session.ts 拆分；Library 缓存；MapCache 内存上限；reconnect 热替换 Bot。
- 验收：tests/mc 89 文件 806 项全绿 + typecheck，五个 PR 独立提交；断线入库/私聊推送/recover 重连/慢读测量的真服回归随后由 `dev:mc:review` 承担（6/6）。

## 2026-11-03 · 批22 导航挂死根治 + 断电边界（G15 关闭、G25 登记、G16 断电子项）

- **G15**：批9B 的导航静默挂死根治——`driver/goto.ts` 看门狗三形态收束（上膛后 3s 位移停滞 / goal 被上游清空 2.5s 宽限仍不结算 / 非挖掘 10s 零位移总兜底，均 Stalled→UNREACHABLE，墙钟不再烧尽）；新增自然地形验收 `dev:mc:terrain-nav`（自寻真树、水候选拒绝、批9B 复刻 lane 柱、树绕行/digThrough、24 格穿越、explore），真服源码/产物各 6/6；执行器残余登记 **G25**（lane 侧隙绕柱零推进，planPath 试算与实时 A* 配置不一致，属上游 mineflayer-pathfinder，看门狗已保证快速诚实失败）。
- **G16 断电子项**：`mc-executor-kill-write`——伴生在 runtime.db 写活动窗口被 SIGKILL → 托管重建回 ready → 独立进程取证：meta 身份不变、恢复只增不删、无半行损坏、owner_lost 如实关闭、探针诚实结算（3 次稳定）；`dev:mc:history --stats` 体量观测就绪。
- **G14 窗口就绪**：`dev/i2.ts` 增请求预算（`--max-requests` 默认 500）、观察扩展（self/death 游标/门状态/safety）、扰动演练（`--chaos` 杀伴生 → 模型须 runs recover 自开门）；真模型窗口待执行。

## 2026-11-03 · 批21 运行时调度统一 + 上行走廊加高（G9/G10/G24 关闭）

- **G9**：`Schedule` enqueue 增 `priority?: boolean`——engine 在身体申请与导航申请入队前按本次受理的 schedule 重设队列一次性 prioritize 旗标（无常驻优先级栈，safety 仍最前，continue 新段不带）；engine 接线由 `mc-decision-runtime` 真 SQLite 覆盖。
- **G10**：两处 `FRAME_EXPIRED` 统一携带 hint（250ms 帧窗 vs 20ms burst 数字语义不同，不并常量）；baseGuide 把"过期帧拒绝"与"mc.sleep(0) 分片"接成因果句。
- **G24**：`planCorridor` 上坡过渡在 height<3 时把升坡列自身 ceiling 一并挖除（踏步上方成 3 高净空）；真服 `dev:mc:climb` 源码/产物各 6/6——1x2 上行 1:1 走廊 10 格全挖并走到终点。另注：goto 的 placeToReach（垫柱合法）会在前置走廊收走掉落物时用圆石垫柱翻出石壁且 `placed` 恒 null 无法归属——场景步骤以 `/clear` 固定前提。

## 2026-11-03 · 批20 感知效率包：G6 节流推送 + G7 增量游标 + G8 按调用短窗

- **G6 节流 digest 推送**（`world/digest.ts` 新模块，**批37 已整体删除，见 2026-11-08 条**）：模型不主动 read 就不知道世界在变。digest 按查询依赖生成——三段（self/inventory/world）直接复用 `capabilities.readers` 的现有读取器，同一 `facts.sample` 提交边界采样，与 observe 口径一致，不建第二套事实提取。前缘节流 10s（`DIGEST_INTERVAL_MS`，集中策略值不新增配置面）、规范化 JSON 哈希去重（"同一份不重复"；`world/watch.ts` 的 `canonical` 导出复用）、facts reset 后清哈希（重连即使内容相同也补发一份）。上行走既有事件管道（`onGameEvent` → executor 事件 → `DeliveryPump`），以独立事件类型 **minecraft_digest** 交付：不指向 events@1（不污染历史）、无 nextCall；**主脑忙碌（`isBusy`）时只保留最新一份待发、空闲即补发**——长任务期间 digest 不刷屏。时间只取粗粒度相位与天数（ticks 连续变化会让去重永远失效）、位置取整数格。
- **G7 inventory@1 增量游标**：协议层补每槽位最后变更 revision（`playerSlotMarks()`；全量重同步只标内容真变的槽位，光标移动只推 revision 不算槽位变更，respawn/end 清空）→ `view.inventoryChanges(since)` 暴露差量（标记不可用回 null 不猜）→ `inventory@1` 输入 `{since?}`：同游标回 `changes:[]` + 变化后总数、有变化回 `{revision, changes:[{slot,item|null}], counts, usedSlots, freeSlots}`（不含全量 slots/layout/gear）、标记不可用退回全量并如实标注 unknown、游标超前（含跨重启 revision 归零）如实 `INVALID_INPUT`。其余查询仍全量，按真实消费者逐个补。
- **G8 run 按调用短窗**：`run` 入参增 `wait`（ms，≥0；continue 的 entry 不加）——默认仍 3000ms，`wait:0` 只受理不等（完成走 minecraft_completion 通知），更久的显式等待仍用 `runs.wait`。落到 `executor/facade.ts` 的短窗覆盖点，指南同步。
- 指南（nativeGuide）补三句：run 短窗与 wait 覆盖、minecraft_digest 的含义与节流口径、inventory@1 {since} 语义。
- 验收：`pnpm dev:mc:digest` 真服 **7/7 PASS**（静态环境准备；baseline 三段齐全 overworld/day/clear；空闲 15s 零 digest 证去重；/give diamond 3 后 digest 反映变化；inventory@1 {since} rev 10→11 差量恰含 emerald +2；窗口内变化合并、digest gap 10015ms ≥ 10s；events@1 无 digest 记录）。场景前两轮暴露的是场景自身缺陷（prepare 变化的节流尾流被 idle 断言误判、背包残留使命中回看旧 digest），修场景后全绿，实现未改。单测新增/扩展：`mc-world-digest` 6 项（前缘首发/去重/合并/reset 放行/段落降级/未附着不造摘要/close）、`mc-delivery-pump` +2（minecraft_digest 分类与忙时保最新）、`mc-protocol` +1（槽位标记随重同步/单槽写入/光标/退役推进）、`mc-capability-queries` +4（since 四态）、`mc-native-facade` +1（wait 覆盖与 0 跳过）；**tests/mc 全量 85 文件/771 项全绿**，`pnpm typecheck` 通过。
- 真服环境事实：`start-server.ps1` 在 Windows PowerShell 5.1 下因 UTF-8 无 BOM 中文注释按 ANSI 误解析而无法使用（解析器报错），本轮直接 `java -Xmx2G -jar paper-1.21.11-132.jar --nogui` 起服（配置已就绪时等价）；如修复脚本需给文件加 BOM 或改用 pwsh。

## 2026-11-02 · 批19 G21 关闭（pathfinder 台阶补丁 + goto 看门狗）与 transit（能力面 51/51）

- **G21 根因**：`mineflayer-pathfinder` 的 `canStraightLine` 把"延迟起跳才过得去"的节点算成"直线可走"，执行器因此**永不按 jump**；随后 `resetPath('stuck')` 不 emit `path_stop`，promise 不 settle，只能等 40s 墙钟。真服实测：起跳点距台阶面 ≥0.89 格才过得去；贴面起跳的横向速度被面碰撞清零，空中控制 0.02/拍补不回来，只能原地弹跳。
- **补丁**（`patches/mineflayer-pathfinder@2.4.5.patch`，与 lockfile 同提交）：`lib/physics.js` 新增 `stepAt(bot, nextPoint, d)`（沿行进方向 d 格探"脚下一格实心 + 头上一格空"），`shouldJump` 改为"1.2/1.8 处有台阶且 0.6 处还没贴上"才起跳；`lib/index.js` 所有移动分支统一走同一个 `jumpNow`（`canSprintJump` 分支原来无条件按住 jump），并加**后退助跑**：贴面且水平速度 <0.12 时后退 200ms 起、逐次 +200ms 上限 900ms 再冲。`allowParkour` 在适配层显式关掉（执行器做不稳跑酷节点）。
- **goto 无进展看门狗**（`driver/goto.ts`）：上膛（见过一次非空路径）+ 挖掘豁免（换目标算进展、同一方块挖满 12s 算卡死）+ 3s 窗口 0.25 格位移 → `UNREACHABLE`。密封竖井从 40s 墙钟降到 **68ms**。
- **能力面 +1** `transit@1`（P2，K8 收口）：找门（`blocks@1` 半径 64 取最近一格）或建门（一次 `region@1` 读回判定全部候选；`capabilities/shared/portal.ts` 纯函数：4×5 框 14 格黑曜石、6 格内部、底排 4 格支撑、两侧 × 齐平/低一格共 4 个站位）→ 逐格 `inspectPlacement`/`commitPlacement` → 打火石点**底排中"正上方是门内空气"的那一格顶面** → 走进门内 → 等维度切换 → 出门 → 可选最后一段 `goto`。阶段**兄弟化**：`goto` 占导航槽、`withBody` 占身体槽，持身体时 `runNavigation` 直接 `CONTROL_CONFLICT`，所以每段各自开合。
- 真服协议事实（批19 探针）：生存 `Player.getPortalWaitTime()` = 80 拍，站进门内实测 **3.6s** 传送；传送后 **300 拍（15s）冷却**，冷却期内站进去什么都不发生（进门的等待窗口因此取 20s）；门面只有一格厚，闷头走会穿门而过，必须按 2 拍一步推进并复核"身体是否真在门方块里"；点火点四角（底排两端）会把火指向柱子、服务端什么都不放；`self@1` 的维度随 respawn 即时更新；下界链接坐标 = 主世界 ÷8（9850 → 1231，服务端实际生成在 1234）；传送会把身体租约掀掉（`INTERRUPTED` 不是失败）。
- **G24 登记**：上行 1:1 走廊 2 高净空物理不可通行（玩家高 1.8、跳跃抬升 1.25，踏步上方只有 1 格时被削顶）——不是导航 bug，`tunnel@1` 上行段需要 3 高净空或半砖级差。原隧道步骤已从 `dev:mc:climb` 移除并如实登记，不改成通过。
- 能力 **51/51**（16 查询 + 35 动作）。验收：`dev:mc:climb` 真服 **5/5 PASS**（1 格台阶 1090ms、三级 1:1 阶梯 7318ms、密封竖井 68ms 快速失败、平地 30 格 5472ms）；`dev:mc:transit` 真服 **5/5 PASS**（空手 MISSING_MATERIAL 零派发、建门+点亮+进门 11.0s 落地下界、原路返回 6.3s 复用下界侧门且回到原址 2.1 格内、再进一次 6.3s 复用主世界侧门）；MC 单测 transit 12 项、queries 目录 34→35 全绿。

## 2026-11-02 · 批18 K8 睡眠/捕鱼/骑乘/牵引（sleep/fish/ride/lead，能力面 50/51）

- 能力面 +4：`sleep@1`（白天/床边有怪 WRONG_STATE 派发前拒绝，入睡证据=bot sleep 事件+服务端 ticks 跳变，唤醒走 `entity_action stop_sleeping`——1.21.11 的 stop_sleeping 是 entity_action 0，mineflayer bed.js 硬编码的 2 在本版本是 stop_sprinting）；`fish@1`（抛竿证据=fishing_bobber spawn，咬钩=鱼漂粒子/运动窗口，收竿=再发一次 use_item——竿不是"使用中"状态，endUse 守卫不成立）；`ride@1`（上下车证据=set_passengers/attach_entity，驾驶按 1.21.2+ 客户端权威 `vehicle_move` 申报，到达判定读载具实体的服务端回声位）；`lead@1`（拴/系/释放三路：拴=对目标 use_entity 等 attach_entity 归属证据、系=对栅栏 interact 等 leash_knot 实体、释放=空手 use_entity 等 vehicleId<=0）。
- **身体证据窗口**（`driver/body/session.ts` `awaitBodyEvent`）：mount/dismount/link/bobber/bite 五类窗口，只认协议事实不认 bot 事件（mineflayer 对"空 passengers 下马"与拴绳链接不完整）；三态纪律 true/false/null（null=中止没看完）。证据窗必须**先开再派发**——服务端通知在 interact 后毫秒级到达。
- **载具运动学**：`contracts/body.ts` `VEHICLE_KINEMATICS` 唯一真源（boat 0.22/0.12、default 0.15/0.10），drive 返回带 `vehicleAt` 申报终点；预算换算（ticks/格）统一从它推导（修掉马按船速算预算的确定性偏差）。
- **协议窄口**：`protocol.ts` 批 18 观察面（attach_entity/set_passengers/spawn_entity 鱼漂/world_particles 咬钩/player_input/vehicle_move）+ `linkHolders` 链接事实缓存（entity→holder，骑乘与拴绳共用 attach_entity；协议无查询包，重连清空）。
- **lead 幂等**：对已拴目标 use_entity = 解除——"先拴后牵"两连调会把第一次的绳解掉（真服 K8 稳定复现）；`leashedBySelf`（attach_entity 本连接事实）守卫跳过重复拴。
- **equip 空手**：从手持槽取物的窗口点击拿不到权威确认（真服实证）——`equip(null,"hand")` 优先换选空快捷栏位（held_item_slot），点击路径只作无空位兜底。
- **矿车**：1.21.11 矿车不可客户端转向——驾驶请求如实 `WRONG_STATE`（sneak 下马原语放行，仅拦截 wantsMovement）。
- **G23 登记**：有鞍马驾驶不可达（Paper 忽略 vehicle_move，A/B 实证）——`ride@1` 对马如实 UNREACHABLE，不假装驾驶成功。
- 真服协议事实：骑乘态位移有服务端回声（马 rel_entity_move/船 sync_entity_position 被 mineflayer 应用，客户端视图=服务端真值）；shift 下马需按住 ~500ms（10 拍）；骑手自身位置骑乘态冻结（下马即回同步）；`/data get` 回执是 system 消息（sender=null，不被 facts 层自身回声过滤）；1.21.11 鞍槽位 = `equipment.saddle`（旧 `saddle` 报 Incorrect argument）、牛的拴绳 NBT 不叫 `Leash`（查证恒 "Found no elements matching"，判据走 attach_entity）；拴上不消耗拴绳；mineflayer 骑乘态 physicsTick 停发（lookAt 会永久挂死，载具分支先于视角处理）。
- 能力 **50/51**（16 查询 + 34 动作）；K8 仅剩 `transit`（受 G21 上坡楔死牵制）。验收：`dev:mc:k8` 真服 **16/16 PASS**（sleep 4、fish 3、ride 5、lead 3、prepare/cleanup；断言全部走独立事实——服务端 Pos/Passengers/库存增量/实体复读）；MC 单测 riding 22 + window 21 + queries 目录 30→34 全绿，`leashedBySelf` 入 contracts/driver/harness 三层；非骑乘撤销不再发 `player_input`（player_input 是载具键位通道，window 测试抓到的多余包暴露此问题）。基线红 `mc-client-lifecycle`（protodef 编译炸，批16 已证 HEAD 同败）与 `mcp-extension-loading` 与本批无关。

## 2026-11-01 · 批17 K6 地图（map@1，G11 关闭）

- 能力面 +1：`map@1`（不可等待、非 feedback）——输入 `{id?, image?=true}`，缺省按主手→副手→热键栏→背包选一张携带的 filled_map；返回像素计数（receivedPixels/paintedPixels/totalPixels:16384）+ 图标 + 可选 ImageFileRef；center/dimension 协议不下发恒 null，不读服务器存档推断。无已开地图 NOT_FOUND，不自动开图或装备。
- **Driver**：协议窄口捕获 1.21.11 的 `map` 包（线上包名 `map`，类型 packet_map；像素矩形列主序，icons 字段缺席=保留旧值、空数组=清空）；`driver/facts/map-cache.ts` per-connection 缓存（错误包整包丢弃不污染其他图，重连清空当前覆盖）；`view.map(id)` 从占位改为真实投影（null=未收到，0=收到的透明色）。
- **色板**：`world/map-colors.ts` 256 项常量表，从 dev-env 的 Paper 1.21.11 运行时 jar（Mojang 映射）`MapColor` 静态初始化提取（62 材质×4 明暗=248 项 + 8 项服务端不产出；byte=materialId*4+brightnessId，亮度 180/220/255/135，每通道 trunc(channel*modifier/255)）。
- **World**：`world/map.ts` 一次纯当前 sample 同时固定库存选择与切面；`world/png.ts` 纯函数 PNG 编码器（512×512=128×128 的 4× 最近邻；未收到=品红棋盘、已收到的透明=地图纸底色）；PNG 原子写 `<worldDataDir>/exports/images/<sha256>.png`（临时文件 rename）；全未收到或编码失败 image=null+unknown。
- **G11 关闭**：`companion/side.ts` 增 `read_image` rpc（realpath 授权校验在 exports/images 内 + bytes/sha256 对账）；`executor/facade.ts` observe 值带 ImageFileRef 时经 read_image 产 `ToolExecutionResult.images`（读取失败给 imageDelivery 原因，元数据不冒充图片）；world-tool 本就 `...result` 透传，零改动。
- 真服协议事实：`/give filled_map[map_id=N]` 引用从未渲染过的 map N 时不推任何包（map 包只在数据更新时下发）；真玩法路径是空白地图（minecraft:map）手持 use 展开→服务端分配 id 并立即推全量 128×128；`map_scale_direction` 组件使 give 静默失败。
- 能力 **46/51**（16 查询 + 30 动作），K6 收口；下一包按 §10.3 为 sleep（K8 起步）。验收：MC 73 文件全绿、`dev:mc:map` 源码/产物各 10/10、受控 wire 5/5、真模型 deepseek-flash 4/4（模型真实描述了地图画面：水面深蓝/灰色地块/棕米色方格）。

## 2026-11-01 · 批16 K6 玩家名单（players@1）

- 能力面 +1：`players@1`（可等待、非 feedback）——名单=服务器 player_info 花名册（`bot.players` 采样时刻同步投影，`rosterSeen` 区分"名单未到"与"收到但为空"）；`tracked:{ref,position,distance}` 由能力层与 entities 事实按跟踪代次 join，离开跟踪范围名单仍在、tracked=null；输入 `{name?, limit?:1..256=64}`，listedCount 不受 limit 截断。
- **entities@1 玩家名覆写**：玩家实体 kind 先按底层 type 判定，name 从名单 join 出用户名（修掉 follow/explore 按玩家名目标 NOT_FOUND）；名单不可用回退 `"player"`，不加 unknown。
- driver facts：`playerJoined/playerUpdated/playerLeft` 推进事实版本；关联实体按采样时刻重新解析，不信任 mineflayer 的 `player.entity` 缓存；`entityRefOf` 收敛实体引用方案一份；displayName 纯文本化排除 `Object.prototype.toString` 继承。
- Runtime/Host/历史持久格式不变，public-api.md 零改动（合同早已定型）。能力 **45/51**（15 查询 + 30 动作）；下一包按 §10.3 为 map（K6 收口，需 G11 图片出口 + `map_item_data` 捕获/色板）。真服验收（Paper 1.21.11：`dev:mc:players` 源码/构建产物各 11/11，第二玩家 ClientHost 真连接）与踩坑见 dev/MC-WORLD.md 批16 节。

## 2026-11-01 · 批15 K7 专用工作站（G2 关闭）

- 能力面 +5：`brew@1`（一批 ≤3 瓶，完成只认瓶子 `potion_contents` 变号）、`enchant@1`（三档等级要求来自 `properties[0..2]`，缺省取最高可负担档，完成后读物品 `enchantments` 组件）、`anvil@1`（rename 走 `name_item` 包，费用读属性 0；原版只在"真的有变化"时给结果）、`grindstone@1`（`xp` 恒 null：经验球无法归因）、`trade@1`（`trade_list` 报价 + `select_trade`，付款先收敛成"正好一份"再取货）。
- **G2 关闭**：`driver/window/layout.ts` 增 5 条布局（brewing_stand 41 / enchantment 38 / anvil·grindstone·merchant 39），同文件新增 `opensWindow()` 替换 `body/session.ts` 的硬编码正则——它原本把附魔台/铁砧全拒在门外，是比布局表更早的卡点。`container@1` 的容器策略不变（工作站仍拒绝）。
- `WindowSession` 增 4 个受控操作（`selectEnchant`/`renameItem`/`selectTrade`/`offers`，public-api §4.3 已先行登记）：只派发、不改 revision、不做槽位预测、不置 uncertain，完成合同与 chat 同口径；`trade_list` 在协议窄口捕获，`itemId` 经 registry 解名（未知报 `unknown` 不编名）。
- 共享件收口：`shared/workstation.ts`（`resolveStation`=原 smelt 的 `resolveFurnace`、`withStation`/`withEntity`、`moveExact` 按具体槽搬、`trimPayment`、组件读取族）；`checkBudget`/`waitFor`/`countInRegion`/`stackLimit` 自 smelt 上移，smelt 行为不变（既有 smelting 测试零改动通过）。
- 真服协议事实（决定实现，详见实施记录）：附魔三档是服务端随机算的、**已附魔物品三档全 0**；`minecraft:potion` 注册表不下发，药水名只能按入参报、编号进 `observedPotionIds`；`select_trade` 会把整摞付款搬进槽里，余量不清则取货后立刻补货 → 回执 unknown → 整个 run 被 `callHasUnknownEffects` 结算成 unknown；mineflayer 的 `clickWindow` 在商人窗口上会崩（驱动自写包是对的）。
- 顺带修复：`entityKind` 补 `type==="passive"` 分支——村民的 `category` 是 `UNKNOWN`，漏掉这一支 `entities@1 {kind:"passive"}` 看不见村民。
- Runtime/Host/历史持久格式不变。能力 **44/51**（14 查询 + 30 动作）；下一包按 §10.3 为玩家名单与地图（K6，`map` 另需 G11 图片出口）。真服验收（Paper 1.21.11：`dev:mc:stations` 源码/构建产物各 14/14）与协议事实见 dev/MC-WORLD.md 批15 节、[实施记录](archive/stations-implementation.md)。

## 2026-11-01 · 批14 蓝图与施工（K5 关闭）

- 能力面 +2：`build.plan@1`（派生只读：规范化 targets + need/missing/blocked/unreachable/estTicks；不可等待，组合根注入 `ConstructionPlanner` 窄端口，World 不依赖 Construction/Library）、`build@1`（开局读一次计划 → 派发前判 CONFLICT/MISSING_MATERIAL → 先清后放、按列自下而上、多轮 → 收尾逐格复读世界复核 remaining）。`build` 的 progress 必须总量守恒：`placed + cleared + skipped + remainingCount` 恒等于设计格数，超时或中断时队列里没轮到的格以 `reason: "not attempted yet"` 补进 `remaining`（真服先报出 `remainingCount: 0` 而实际还剩 67 格）。
- 新模块 `construction/`：Target 四分类与规范化/镜像/旋转（`target.ts`）、最小 NBT 读取（`nbt.ts`）、Sponge `.schem` v2/v3 解码（`schem.ts`）、`target.json` 两种写法（`target-json.ts`）、唯一差异实现（`plan.ts`）、组合端口（`index.ts`）。
- Library 增 `readDesign(name)`（原件 + target 字节与两个摘要，不进 `LibraryPort` 公共面）；`companion/side.ts` 把 Library 上移到 World 之前并用惰性 getter 注入施工端口。
- 共享原语抽取：`place-cell.ts` 的 `inspectPlacement`/`commitPlacement` 由 `place@1` 与 `build@1` 共用（`place@1` 行为逐字等价，原测试零改动通过）；`no-support` 与 `out-of-reach` 分开（前者延后重试，后者走位一次）；支撑面按候选轮换（服务端会拒绝门顶这类面）。
- 裁决登记（capabilities.md §3/§4 已写回）：`target.json` schema = `minecraft:construction.target@1`（密集 palette+cells / 稀疏 cells 列表）；`blueprint.digest` = **实际被解释来源**的 sha256（与 `library.get` 的原件摘要分开）；`.schem` 只支持 Sponge v2/v3，其余 `WRONG_STATE`；mirror 在包围盒内翻转、rotate 绕 Y 顺时针，状态只变换 facing/axis/rotation/hinge/shape；`targets` 上限 2048、`cells` 512；`blocked.by` = 现场方块名；`unreachable` = 结构支撑缺失（非寻路判决）；`estTicks` 常量模型；`scaffoldsUsed` 恒 0。
- Runtime/Host/历史持久格式不变。能力 **39/51**（14 查询 + 25 动作）；下一包按 §10.3 为玩家名单与地图（K6）。
- 已知缺口：G20 关闭（`build.plan` 落地）；新增 G22（施工不搭脚手架、不绕行）；G21 补批14 实测（平坦地面 goto 5 格 0.6s vs 跨 1 格石台 40s 超时，直接决定了按列自下而上的施工顺序）。真服验收（Paper 1.21.11：`dev:mc:build` 源码/产物各 12/12）与踩到的真实行为见 dev/MC-WORLD.md 批14 节、[实施记录](archive/construction-implementation.md)。

## 2026-10-31 · 批13 地形切片与空间作业

- 能力面 +3：`region@1`（闭区间/at+size 双形态，palette 第 0 项恒 air、order 固定 xzy、未加载格 -1 计 missing、体素 ≤8192 否则 INVALID_INPUT 带切片建议；逐格事实视图有界同步采样，48 格实测 ~3ms）、`tunnel@1`（L 形两轴走廊 + 台阶 1:1 + 段尾竖井；下坡列挖檐块、上坡列在前一位列挖跳跃净空；support 探测檐上重力方块先挖后挖 profile）、`excavate@1`（层自上而下、层内就近序、keep 保留、容器先 transfer@1 收内容再挖、drops 聚合背包正增量、收尾以世界读数复核 remaining）。
- G4 关闭：`ctx.verify` 注册表落地——`EffectVerifier` 合同（contracts/runtime.ts）+ `EngineOptions.verifiers` + `verify/dig@1`（capabilities/shared/verify.ts：按 effect facts 的 BlockTarget 读当前方块，air→met、原方块→not_met、未加载→unknown）；`ctx.verify` append-only 追加 `EffectVerification`（原 completion 不改写），`effect_verification` 突变落库为新的不可变截面，效果行跨重启恢复后仍可复查。程序桥补 `mc.verify(effect, verifier)`（shim + ProgramHostApi + program-host），runMining 的 dispatch/receipt 事实 detail 补 `target`。
- 能力纯函数收敛到 `capabilities/shared/spatial.ts`（planCorridor/expandProfile/planExcavation/orderNear/normalizeBox/方块分类，确定性可测）；tunnel 用"挖 reach 内数列 ↔ goto 走到最远已挖列"的挖走节拍（digThrough:true 兜底 + 实际落点复核 + stepTo 近距步进），excavate 用"goto 腿（失败按实际站位复核射程）+ withBody digCell"。
- 裁决登记：tunnel 走廊遇流体 → UNREACHABLE；当前库存无法采收（基岩/缺工具）→ 返回 `stopped:"unbreakable"` 保留已挖前缀；`path` = 已挖格 + 原方块名；stairs:"never" = 水平段恒高、高差段尾竖井衔接；excavate drops = 挖后短窗背包正增量（不承诺拾取完整）；excavate not_met 以世界读数复核（回执确认窗边界竞态时方块其实已开）；region watchable:true / feedback:false。
- Runtime/Host/历史持久格式不变（effects.verifications 列批 6 已预留）。能力 **37/51**（13 查询 + 24 动作）；下一包按 §10.3 为蓝图与施工（build.plan/build）。真服验收（Paper 1.21.11：`dev:mc:spatial` 8/8——region 对拍/未加载 missing、下坡隧道 ×2 连通可走、砾石支撑、excavate 保留+收集+清空、G4 met/not_met/未注册 NOT_FOUND）与已知缺口（上坡行走楔死，G21）见 dev/MC-WORLD.md 批13 节。

## 2026-10-31 · 批12 移动鲁棒性与完整战斗

- 能力面 +4：`follow@1`（跟踪跟随，ended=target_lost/timeout 如实）、`flee@1`（背向威胁 8 向轮换，威胁失联按最后已知差距结算）、`surface@1`（两相水中脱困 + 竖井上升，`escapeToSurface` 供 fight 复用）、`fight@1`（stance 决策表、武器/盾装备、击杀只认死亡观察、撤退线与 no_progress、ranged=useItem hold/release + awaitEvidence）。
- G3 关闭：`SurfaceProbe` 窄端口（contracts/world.ts + public-api §5）与 `driver/mineflayer/world-scan.ts`——站立/露天判据与螺旋露天出口查找；goto@1 的 GoalNear 节点语义不变。
- Driver 证据窗口扩为 `{hit, dead}`（dead 只由 entityDead 置位），新增 `BodyOps.awaitEvidence`（纯证据窗口，不派发动作）；public-api §4 更新。击杀掉落=死亡位置附近新出现 item 实体差集，目标失踪不算击杀。
- 能力层纯决策收敛到 `capabilities/shared/mobility.ts`（matchFollowTarget/fleeLegTarget/stanceParams/effectiveRetreatHealth/MELEE_DAMAGE 等，确定性可测）；fight 用 withBody↔navigate 顶层交替拍，不嵌套租赁。
- Runtime/Host/历史持久格式不变。能力 **34/51**（12 查询 + 22 动作）；下一包按 §10.3 为空间作业与施工（region 先行）。真服验收（Paper 1.21.11：mobility 源码/产物 7/7、combat 5/5）、版本事实（1.21.11 gamerule 拆分为 spawn_mobs 等）与证据边界见 dev/MC-WORLD.md 批12 节。

## 2026-10-30 · 批11 领域记录与地点、路径探索

- World 领域记录（known-gaps G1）落地：world-history.db 增 records 表，SCHEMA v3→v4（旧库明确拒绝、不迁移）；`WorldPort` 增 `removeRecord`，CAS/分区校验在存储 Worker 单事务内，非空 evidence 同事务核验存在性；`meta.record_version` 只随记录写推进，驱动 places 观察，不复用提交版本。
- 能力面 +5：`places@1`（watchable，kind/near 过滤，near 只作用于当前维度、原点不可得显式 DISCONNECTED）、`remember@1`（CAS 同名覆盖、显式维度照存、名字 1..32 可见字符）、`forget@1`（removeRecord + NOT_FOUND）、`route.plan@1`（只读试算：组合根注入 `WorldRoutePlanner` 窄端口，World 不依赖 Driver；steps/needs 从上游 Move 的 toBreak/toPlace 导出，estTimeSec 由 a* 代价折算，不占控制不产生效果）、`explore@1`（单次 navigate 作用域包多段 goto+扫描，TIMEOUT/NOT_FOUND 带 traveled/scanned）。
- 合同先行：public-api §5（removeRecord、route.plan 分派）、world.md §11（records 表）、capabilities.md 五节冻结细节（near/维度、探索失败映射与常量、试算推导、名字规则、删除语义）。
- Runtime v6/history v4/ledger v3/Host journal v4。能力 **30/51**（12 查询 + 18 动作）；下一包按 §10.3 为移动鲁棒性（follow/flee/surface）与完整战斗。验证与证据见 dev/MC-WORLD.md 批11 节。

## 2026-10-27 · 批10反馈与默认自保

- ClientHost 生命周期监听与化身退役修正；self 氧气、最大生命值和效果寿命沿实际客户端数据读取。
- Driver 在既有物理模拟前安装/核验反馈输入，模拟实际完成后采样并确认；Program 接 body.feedback/loop，流采用单在算帧/latest-only 待交付、250ms有效期与所属输入撤销。
- Runtime 在同一身体队列中退役旧作用域、授予 safety；默认岩浆/缺氧/低血新伤害反射不另建 Run，不自动吃、挖、放或反击。记录归 safety，旧程序可在外层捕获中断并重新观察。
- Runtime schema v6，旧v5拒绝自动迁移；history v3、ledger v3、Host journal v4保持。状态与重要提示可查实际介入记录；完整证据见 [批10实施记录](archive/feedback-implementation.md)。能力仍25/51，下一包地点与路径探索。

## 2026-10-25 · 批 8 Library 文件与发现复用

- 三类普通文件 CRUD、统一扫描/头诊断、compile-only、确切 Call 来源保存、四类统一发现和正式工具/IPC 已接通；Program 只消费注入的只读材料。
- 工作文件摘要和执行来源摘要分开，metadata 补丁不改正文；在途段固定源码，新段重读，删库文件不删运行快照。
- 蓝图本批只管理 Raw 与元数据；Target 只报告 schema/digest 和 validation:unavailable，语义验证及施工仍归 Construction。原件可读不代表格式有效。
- Runtime/Host 持久格式不变，能力数量仍为 25/51；下一批等待/决策与 I2。验证、裁决与未验证范围见 [实施记录](archive/library-implementation.md)。

## 2026-10-25 · 批 6 正式原生主脑入口

- WorldDef、六 action 原生 façade、同源目录、请求凭证与显式重试、固定报告和 Host receipt 可靠交付已接通；Program/Library 保持明确不可用。
- Runtime schema v3 保存不可变截面和交付处置；Executor ledger v2 保存原请求与尝试，旧数据拒绝自动迁移。
- BodyEndpoint、abort/stop、源/产物 manifest 与开发入口同步；首次真实模型完成采集生产、缺料纠错和显式停止。证据、校准修正及剩余范围见 [实施记录](archive/native-host-implementation.md)。

## 2026-10-25 · 批 5 Host 通用持久回执

- journal 同批升级 v4，旧 v3 明确拒绝，不迁移真实日志；SessionStore 暴露真实会话身份与 durable/volatile。
- 工具/输入携带 receipt；Broker 验证后同步登记尝试，canonical append 才确认。提交索引由既有 reducer 增量维护，回溯不删除历史交付事实。
- Mailbox 按来源/key 去重，render 后重验提交资格，retire 对 attempt 做 CAS；工具退役不删除协议消息，输入退役与原队列撤回共用持久路径。
- Host、Extension 与 World 共享来源绑定的 inspect/retire 端口。批 6 继续正式 MC 模型入口与可靠通知，本批未接真实模型或改变玩法数量。
- 实际进程中断、Host 重开与最终验证见 [实施记录](archive/host-delivery-implementation.md)。

## 2026-10-25 · 批 4 Executor 平台底座

- 新增 Windows x64 私有 Node-API 双 Job、精确进程句柄/异步退役、受管 bootstrap、Companion 静态装配、固定 IPC、身份/launch/本地门意图账本。没有添加模型工具或临时通知桥。
- Runtime 增加 Owner/心跳/独立三门及 CAS；受理与开始先提交，关闭停止控制再结算。库 schema v2 固定 worldOwner/storageId，旧库拒绝，不迁移真实数据。
- 开发 harness 复用执行侧装配，`submit` 的直接消费者改为 await；新入口 `pnpm dev:mc:executor`。实际 OS、故障、SQLite 与源码/产物真服证据见 [实施记录](archive/executor-platform-implementation.md)。
- 下一任务为批 5 通用 Host 回执；Host journal 仍为 v3，WorldDef/模型入口与可靠通知留批 6。

## 2026-10-25 · 开发规划按正式接入与模型反馈重排

- 保留已完成批 0–3；替换旧批 4–12 的剩余排期。当前 [总规划 §10](development-plan.md#10-剩余施工总纲2026-10-25-重排) 是施工顺序唯一来源：批 4 E 平台、批 5 H 回执可独立施工，批 6 正式原生主脑与首次校准，批 7 Program 执行、批 8 文件复用、批 9 等待/决策与完整 I2。P/H/E 不再等待蓝图施工。
- 校正真实目录为 **10 查询 + 15 动作（25/51）**；旧 12 查询/27 项是计数错误，不是本轮删除能力。同步 README、LEAD、能力验收状态、当前运行事实和开发索引。
- 地点/探索、跟随逃离、脱困、反馈自保、战斗、地形/空间作业、施工及各高级玩法按直接依赖分别排队；剩余 6 查询 + 20 动作全部有归属，Microsoft、历史保留、核验器等未完合同显式收口。
- Executor 正文明确同一正式 World 的分阶段交付：原生阶段不装配 Program 时容量为 null，未交付 API 明确失败；实际需要的 Job/Owner/Host 回执不降级，已声明模块/资产损坏仍启动失败。不是新增临时接入或第二套模式。
- 验证按 OS、Host/Session、引擎/文件、真服、真实模型分别选择，不统一要求每批真服；规划修改只做文档一致性、链接和差异检查，复用本会话已获得的源码/测试证据。规划文档单独提交，既有生产链源码、测试与修复记录保留；未修改运行数据或认证。

## 2026-10-25 · 生产链审查修复与收敛

- 合成/熔炼拆为独立动作，删除旧混合实现；取货共用组件匹配、多槽分装及实际堆叠上限。合成移除错误容量预测，消耗/入包分开累计。
- 熔炼在世界等待前关窗并释放自有身体，复查重新核验身份与炉子；批量同时受燃料与槽位约束，失败/取消保留累计装料、取货与剩余量。
- 点击回执直接携带确认时的服务端快照，删除已确认回执与记账之间再次读取的取消竞争；所有消费者直接替换，不留兼容入口。
- Paper 字节码核实最小燃料表，删除四种下界木材，干海带块修正4001刻。当前类型/9条边界、MC28文件236项、构建通过；真服最终证据见 [生产链修复实施](archive/production-repair-implementation.md)。


## 2026-10-25 · 批 3 生产链落地（craft@1 / smelt@1）

- 新能力 **`craft@1`**：手持 2×2 与工作台 3×3 两条路径同一套摆格算法，配方按"缺料种类→总量→手持优先"选择，`station:"crafting_table"` 允许把 2×2 配方放到工作台做；3×3 先找 8 格内的工作台、没有就把背包里的放到相邻格并回读确认，**用完不拆走**。产物最初按库存净差结算，现由上节的确认入包累计替换。
- 新能力 **`smelt@1`**：`wait:true`（装料→等待→取回）与 `wait:false`（下料即返回，取货走 `transfer@1`）两种模式；原料由熔炼表反查，燃料量按烹饪刻数算，燃料刻数未知直接 `MISSING_MATERIAL`；等待与复查现按上节分段执行。
- **结果槽无需新协议面**：每批只摆"恰好一批"料，结果槽点击就是纯交换，沿用现有 `expectedClick` 推演。**mode-1（shift/quickMove）本批不开**，§10.7 的待裁决项由此关闭。
- 窗口层：`driver/window/layout.ts` 成为布局唯一真源（玩家窗口/工作台/熔炉/普通容器），工作站窗口**不产出 `container` 区域**；`openContainer` 白名单加入 `crafting_table`/`furnace`；`BodyOps.withInventory` 交出玩家窗口作用域。
- `WindowSnapshot.revision` 收窄为"只随槽位与光标推进"：炉子进度每秒数次，否则燃烧期间每次点击都撞 `CONFLICT`。
- `container@1` 支持熔炉读数（`slots[].region` + `properties`），`container.last` 历史按"除玩家区外的全部区域"聚合；`transfer@1` 对熔炉只支持 `from`（取产物），`to` 明确拒绝。
- 知识层：`KnowledgeRecipe` 增加 `pattern`（摆格图案）与 `cookTicks`，删除从未赋值的 `fuel`；`station` 判据改为实际非空格数（修掉 27 条同种材料 shapeless 的误判）；熔炼配方来自新表 `driver/facts/smelting.ts`（Paper 1.21.11 jar 抽取 73 条，`scripts/extract-mc-smelting.mjs` 可复现）；燃料刻数手工最小集，未收录保持 null。
- 验证：MC 确定性回归 **26 files / 201 tests**；真服 `pnpm dev:mc:k3` **14/14 PASS**（原木→木板→工作台→木棍→木镐→熔炉→石镐→熔炼两种模式→铁镐，另含三条拒绝面与两条知识面）。当时目录应计 **25/51（10 查询 + 15 动作）**，原记 27 项已更正；当时的“下一批校准点”已由上节重排替换。

## 2026-10-25 · 状态校正与批 3 前置登记

- 提交归属校正：K1 收口、真服复验、批 1 采集、批 2 窗口容器四轮均已在 **d77d20f** 入库（84 files）；2026-10-25 修复与 Driver 收敛在 **6157834**。`dev/MC-WORLD.md`、[窗口容器实施记录](archive/window-container-implementation.md) 与 [Driver 修复实施](archive/driver-repair-implementation.md) 此前记作"未提交"，已更正。
- 新增 [development-plan §10.7](development-plan.md)：批 3 的三处底层前置按源码登记——`WindowSession.layout()` 只接受普通容器窗口（`crafting`/`furnace` 报 `UNSUPPORTED_WINDOW`，`container@1` 白名单同样不含这两种方块）；`KnowledgeRecipe` 拍平 `inShape`，摆格图案丢失；该数据版本无熔炼配方与燃料刻数。批 3 的前置列改为引用该节。
- 测试基线校正：MC 确定性回归实际为 **24 files / 176 tests**（入口文档此前仍写 16/125）。
- 未改动任何行为合同与源码。

## 2026-10-25 · 审查修复与 Driver 写入路径收敛

- 按连接的 DriverProtocol 集中物品编码、同步协议写入与服务端通知；先实现 Java 1.21.11，其他版本的相关操作明确拒绝，后续版本沿窄端口接入。
- 玩家库存和容器共用服务端快照/槽位期望/串行点击确认；装备、丢弃移除原生异步库存链。BodySession 收口资格与停止，库存、采矿、牌面各自持有局部操作资源。
- ItemValue 与选择器统一；采集工具由实际 harvestTools 集合判断，移除材质排序猜测。toss 改为 `{receipt,removed,remaining}`，drop 分别保留确认离包与地面观察进度。
- 采矿不再把客户端预测空气当服务端破坏；牌面取消后不再提交。查询恢复统一 schema 入口，导航禁放置覆盖全部耗材移动，Runtime 修复直接/嵌套未知效果的成功误报。
- 真服首轮暴露 Goto 欧氏完成复查与 GoalNear 节点判据不一致；先增加真实依赖失败回归，再统一 nodeGap，修正容器动作及继发历史读取失败。
- 本轮工程：`pnpm typecheck`（9 条边界）、MC 显式 **24 文件 / 176 项**、`pnpm build` 通过。最终 Paper 1.21.11 上 `pnpm dev:mc:repair` 与构建产物各 **15/15 PASS**，独立 Temp 数据根，含真实 max_damage/max_stack_size 覆盖、取消与完整关闭重开历史。取舍、独立审查五项修复和日志归属见 [Driver 修复实施](archive/driver-repair-implementation.md)。

## 2026-10-24 · 批 2 窗口与容器落地

- 能力面 **9 查询 + 11 动作 → 10 查询 + 13 动作**：新增 container/transfer/container.last；支持双向精确量、固定 all 清单、nearest 三候选、实体容器、部分 moved/remaining。下一批为 craft/smelt。
- Driver 增加独立 WindowSession 与窄线形适配：每次 mode-0 点击仅发一个 stateId=-1 的真实业务包，接完整服务端槽位/光标并比对本次前态，避免本地预测冒充完成。没有可归属变化则 unknown，不自动重发。期望必须覆盖直接点击槽，旧 revision 返回 CONFLICT；普通 close 要求空光标，失败清理显式 force。
- 独立复查修正双完整回包串到后次点击、取消未打开窗口却假称屏障已过两处缺陷；后一种情况复用既有连接封闭机制，要求重连。真实 Paper 的 block-use 突发丢包通过看向目标后等待一个实际物理步解决，不另建限流框架。
- World 复用 client.window@1/evidence 表保存观察，只聚合容器区域；同世界/存档代次/维度按位置查最后观察，不受临时 binding 变化阻断。实体容器观察不伪装成方块历史。补混合 schema、订阅前重放、reset 保留未确认材料、关闭前 flush。
- 真服场景 `pnpm dev:mc:containers`：独立测试区、实际区块/平台/落脚核验，13 项；构建产物同场景也通过。MC 确定性回归 16 files / 125 tests；pnpm typecheck、pnpm build 通过。准备和游戏动作分开，工具等待超时的显式停止只发生在验收脚本。
- 详细设计、替代方案与实施裁决见 [窗口容器实施记录](archive/window-container-implementation.md)。本轮没有实现 Program/Library、Host 回执或正式 WorldDef。

## 2026-10-24 · 批 1 采集闭环（collect / pickup / drop）落地

- **能力面 9+8 → 9+11**：新增 `collect@1`（知识反查方块 → 前沿搜索 → goto/mine/pickup 组合）、`pickup@1`（候选实体 → 走到 → 库存增量结算）、`drop@1`（库存核对 → 可选走近/朝向 → toss → 地面实体复核）。
- **Driver 补两块**：`BodyOps.toss(name, count)`（窗口外转移，可丢域只到主背包+快捷栏 9..44，回执只到 `unknown`）；`ClientEntityValue.item`（掉落物身份，走 `entity.getDroppedItem()`，不手写元数据索引）。
- **两个真服暴露的底层缺陷顺手修掉**：①`searchBlocks` 按段**中心**排序，玩家站在段边界时脚下这段会排到后面，命中上限就把最近的方块漏掉——改成按段"最近点"排序，并在上限后只继续扫"仍可能更近"的段；②`goto` 目标已在 GoalNear 邻域内时上游不发 `goal_reached`，表现是 `tolerance=1` 且隔一格就永久挂住——改成先在驱动层按节点距离判定并在邻域内直接结算。
- **`pickup` 的最后两格不用路径规划**：GoalNear 的 1 格容差在近距离经常 resolve 空路径（驱动层按 UNREACHABLE 结算），改成 `lookAt` + `drive` 步进，`goto` 只在 4 格外使用。
- **`collect` 不持身体、不挖脚下那一格**：Body 槽与 goto 槽互斥，逐步取放；脚下那格留到没有别的可选时才挖（一格竖井会让后续每次 goto 都失败）。
- 契约口径补齐：`mine@1` 的 `errors[]` 补 `WRONG_STATE`、`goto@1` 补 `WRONG_STATE`、`equip@1` 补 `TARGET_NOT_MET`；`pickup@1` 从两行补成完整的完成条件与失败码。
- 真服：K2 场景 11 步 PASS（新世界）；K1 回归 19 步 PASS、I1 PASS。`tests/mc` 13 files / 93 tests。

## 2026-10-24 · 剩余施工总纲（development-plan §10）

- **把"能力分组"和"施工批次"分开**：K1–K8 是能力范围标签，不是批次。新增 §10 给 12 个批次，每批的交付物必须是"一条能在真服跑完的玩家任务 + 一个场景脚本"，批 0 = 已完成的 K1。
- **显式登记六处与原 K 顺序的偏差**：①K2 拆成"采集闭环 / 窗口容器 / 生产链"三批（组合动作、窗口协议、生产逻辑三类风险不同量级）；②`drop@1` 需要新增 `BodyOps.toss`（Driver 目前明确不丢物品，原规划把它当纯能力层组合）；③K3 拆两批，`fight` 依赖 driver §8 反馈时序；④K4 内部改序，`tunnel/excavate` 先于 `region/places`；⑤新增批 4"自主游玩校准点"，用真实游玩重排后续批次（原规划没有使用驱动节点）；⑥K5 与 Library 的"只读蓝图"子集同批，不等整块 Library。
- **待裁决四项**：熔炼数据自建最小表 vs 等上游（建议自建）；H 回执是否插队（建议不插，保持批 10）；K6 `players/map` 暂缓；Program guest 边界按 QuickJS。是否为 P1/P2 扩面推迟到批 4 的评估结果。
- **技术债按触发条件挂起**（不提前还）：world 无保留/清理、事件 Watch、`ItemSelector.components`、`world.difficulty` 常 null、`vitest tests/mc` 过滤器误匹配。

## 2026-10-23 · 真服复验：可达性归调用方、eat 归因、K1 场景全过

- **"可达性归调用方"写进 §4 总则**：除移动类动作外，破坏/放置/右键/攻击只作用于当前姿态够得着的目标（方块交互自眼位 4.5 格，实体交互 4 格），够不着返回 `UNREACHABLE` 并提示先 `goto@1`，动作内部不寻路；`collect`/`tunnel`/`excavate` 这类本身含行走的组合动作不受此限。据此校正 mine/attack/use 三处"走近"表述——原文读起来像每个动作都要自己走过去，与实现（以及"导航只此一个入口"的取向）相反。
- **射程判定收成一份实现**（`capabilities/shared/reach.ts`）：`BLOCK_REACH=4.5`（自眼位）、`ENTITY_REACH=4`、`blockReach/eyeOf`。mine/place/use(方块/牌子)/attack 全部改用它；此前 use 用"feet 到方块角 6 格"、place 根本没查、attack 自带 `ATTACK_RANGE=4`——同一件事三套口径，超射程的交互只会以 `TARGET_NOT_MET` 的形式晚到。place 量的是真正被点的支撑面，不是目标格。
- **mine@1 补射程判定**：此前能在 4.5 格外派发挖掘，服务端要么拒绝、要么掉落不在拾取半径内而 `dropped` 恒缺省；现在派发前拒绝，`hint` 带实测距离。`dropped` 的可观察条件因此明确：**先站到被挖格上，再谈掉落**。
- **eat@1 归因顺序**：点名的物品不在包里 → `NOT_FOUND`；在包里但不是食物 → `WRONG_STATE`；两者都排在"已经吃饱"之前。此前吃饱时传 `dirt` 会得到"food is already full"，状态掩盖了输入错误。
- **真服结果（Paper 1.21.11 / 端口 25565 / UinaDev op）**：I1 复验 PASS；K1 场景 19 步 PASS——world/item/recipe/inventory/self、equip→place(dirt/sign/lever)→use(写牌/拉杆)、mine(掉落入包)、mine 越界拒绝、blocks/entities、attack(命中证据)、eat 非食物拒绝、eat 饥饿进食(food 0→5、面包 -1)、events 尾窗+after 正向分页+空增量页。
- 分页口径澄清（不是代码缺陷）：**无 `after` 的读只给"最近 limit 条"+ `after`，不给 `next`**；`next` 只出现在 `after` 之后的正向分页。按"首读给 next"写场景会误判成 bug，改用 `after` 起步后 3 条消息稳定得到 page1(2)+`next` → page2(1)。

## 2026-10-23 · K1 能力面收口（9 查询 + 8 动作）

- **能力层重写为"一族一文件 + 共享工具"**：`capabilities/{queries,actions}/` 取代原来的两个大文件；`shared/` 收敛 schema 片段、目标换算、观察窗口、事实组装、实体解析、查询声明。重复 ref 在装配时显式失败。
- **查询分三路读取**：`current`（同步采样）/ `static`（版本知识，不需要连接）/ `history`（events@1，提交屏障后读存储）。`Observation.cursor` 允许 null：静态与派生查询（recipe 的 plan）没有观察水位；events 的增量位置是页内不透明 `after` 令牌。
- **blocks@1 名实对齐**：`blocks@1` 回到"按名搜方块"（World 负责排除/计数/截断，Driver 负责按 section palette 跳过扫描），`regions` 式的段读取不再占用这个名字；`block@1` 支持 `{at}` 与 `{below}`；`self@1` 从同一次库存采样补 held/armor；`inventory@1` 补 counts/usedSlots/freeSlots；`entities@1` 支持 radius/kind/limit 并排除自身（`ClientEntitiesValue.selfRef`）。
- **Driver 新增事实与操作**：`world()` 环境读数（时间/天气/维度/群系/难度/模式，读不到为 null）、`searchBlocks()`（palette 跳过 + 近段优先 + 上限 capped）、`Static 知识`（registry-knowledge：物品/食物/工具/掉落/配方/实体分类）、damage/death/connection 事件捕获；`equip` 扩到护甲槽（EquipSlot）；`attack` 增加受击证据窗口（`AttackOutcome.hit: boolean|null`）；`writeSign` 真实路径（open_sign_entity 匹配 + update_sign + blockEntityData 确认，文本不可读时如实 unknown）。
- **World 事件历史**：复用 evidence 表与 rowid 顺序（不建第二份聊天队列），新增事件读取消息与提交屏障；游标编码分区/过滤/位置/上界/页大小，分页固定上界，空页推进 after，分区不符报 SNAPSHOT_EXPIRED。
- **完成口径如实**：mine 只认客户端空气（未加载不算 air），掉落只在短窗口内报观察到的增量；place 先查冲突/材料/支撑面再取身体；eat/attack/use 的可预判失败都在 `withBody` 之前；use 明确拒绝窗口类方块并指向 container/craft/smelt；attack 的 hit 不把"没看到"写成"打中"。
- **构建接线**：`tsconfig.build.json` 纳入 `.uina/worlds/minecraft`，worker 路径按产物/源码双态解析；`dist` 内两个 worker 均有 .js 产物。
- 数据版本事实：1.21.11 的 minecraft-data 只有合成/方块/实体三类来源，没有熔炼与交易数据，因此 item.sourcesComplete 恒为 false、fuel 恒为 null、recipe 只有合成配方；`sourcesComplete=false` 是数据覆盖说明，不是"无法获得"。
- 验收：`tsc --noEmit`、`check:boundaries`（9 规则）、`tests/mc` 12 files / 76 tests 全绿；`tsc -p tsconfig.build.json` 全绿。**真服未复验**，本轮全部新路径只有确定性单测覆盖。

## 2026-10-22 · I1 原生化重构：K1 回退、缺陷修复与结构收口

- **K1 能力子集整批回退**：`capabilities/{mine,place,knowledge,body-common}.ts`、`contracts/knowledge.ts`、`driver/registry-knowledge.ts` 删除，`package.json`、`public-api.md`、`modules/capabilities.md` 一并回到 10-21 之前的 I1 口径；不保留兼容层，也不把草图当后续基准（`KnowledgeSource`、`body.attack` 的 `targetHurt`、equip 护甲槽等增补随之作废）。现行实现是 5 查询（self/inventory/block/blocks/entities）+ 2 动作（chat/goto）。
- **Body 申请收敛为单槽 FIFO 队列**（`runtime/body-queue.ts`）：同步占槽、单在途 acquire、授予前复验 `signal.aborted || !isOwnerLive(owner)`。修掉两处：同 tick 两次 acquire 都看到"无持有者"而双持有；Run 停止后排队/在途申请仍被照常授予并执行 work。
- **证据释放水线只统计证据消费者**：新增 `ClientFactsSubscribeOptions.consumesEvidence`，释放水线只在登记为消费者且处于同一 stream 的接收方之间取最小值。修掉 CurrentWatch 不 ack 导致水线永不推进（有界缓冲被无谓耗尽、按溢出报假缺口），以及 `acknowledge` 忽略 `ack.stream` 使旧流高位释放新流证据。
- **self 事实不造值**：`SelfState.health`/`food` 改 `number | null`，读不到即 unknown + 声明；`inWater`/`inLava` 改读客户端物理写在实体上的判定结果，不再按脚部方块名推导（waterlogged、气泡柱、流动水此前全错）。断线报 `unavailable`，不再报 `starting`。
- **完成语义如实**：dig 的 receipt 不再声称 "server block update confirmed"——I1 不区分本地预测与服务端更新，改为如实陈述并标 `client_block_update`；dispatch 失败不再记 `sent`。drive 任何退出路径（正常/停滞/中止）都撤键并释放 hold 使用，不再只在成功分支清理。
- **ref 发号带启动命名空间**：`ev:`/`gap:`/`body:`/`op:`/`eff:` 此前每进程从 1 发号，与持久历史库主键跨启动冲突；`world.md §5.3` 的命名空间规则统一到全部发号点。
- **查询校验统一到 schema**：能力输入交给本地 Ajv 实例编译 `descriptor.input`，删除手写的 sections 范围、整型向量与空输入检查；`ItemSelector.components` 这类未实现匹配显式 `INVALID_INPUT`，不再静默忽略。
- **结构收口**：新增 `driver/execution.ts`（EffectRecorder + fail）、`runtime/state.ts`（RunState/CallState 形状）、`runtime/rows.ts`（投影与持久行的纯函数）、`driver/facts/{index,view}.ts`（挂接与水线 / prismarine 值捕获分离）。engine 1613→1240 行、facts 754→408 行；三处 `recordFact` 转发层、两份逐字相同的 `fmtVec`/`fmtPos`、`fail`/`plain`/`nowIso` 的重复副本删除。
- 验收：`tsc --noEmit`、`check-boundaries`（9 规则含反证样例）、`tests/mc` 9 files / 46 tests 全绿；`tests/mc` 首次纳入版本库。**真服未复验**，本轮修复全部只有确定性单测覆盖。

## 2026-10-19 · 总开发规划与开发规范

- 重建总开发规划：先落实最小共享接缝，再并行推进正式基础设施，设原生真实闭环与完整主脑闭环两个集成节点；覆盖全部 16 查询 + 35 动作，按实际依赖组织八组玩法。
- 明确 Host 回执/v4、Minecraft 类型/构建接线和真环境基线的实际缺口；领域详细设计到工作包开始时补齐，不把基础设施也留到集成末尾设计。
- 新增开发规范，统一接口/资源/真实结果、成熟代码复用、局部重构与验证选择；取消每条能力都先做假 Bot 再跑真服的施工要求，不新增测试/插件框架。
- 将规范接入 README、概要和实现目录 LEAD；仅修订规划与规范，未开始产品实现。

## 2026-10-18 · 补全模型感知与交互

- 新增 events@1、players@1、map@1 三个查询；目录为 16 查询 + 35 动作（P0 23、P1 18、P2 10）。事件复用历史/提交/Watch，明确增量位置、分页、缺口与等待；名单不等于实体，地图不推断中心。
- 获取来源并入 item.sources，实体探索并入 explore，告示牌读写并入 block/use；补齐 SelfState 与反馈。没有新增科技树规划器、条件 DSL、图片工具或学习系统。
- 地图工具通过既有 ToolExecutionResult.images 交付真实 PNG；guest 仍只收 JSON。图片缓存和原始事实分开，缺失与未知有明确呈现。
- 安全介入沿既有身体仲裁，明确默认触发/预算/结束和记录；EffectRecord.owner 分清 run 与 safety，不伪造 Call。普通饥饿由程序决定，不默认自动反击；重生不重跑旧任务。
- 同步模型指南、模块正文、公开类型、阶段门和反例；只修订文档，静态检查不证明产品实现或真实 Minecraft 验收。

## 2026-10-18 · 统一操作与模块职责

- take/stow 合并为 transfer@1：from/to 恰一，另一端为自身库存；统一选物、固定数量、moved/remaining、部分失败与未知。give 并入 drop.toward，只报告丢弃，不认证接收。现行目录为 13 查询 + 35 动作（P0 22、P1 16、P2 10），旧名无兼容别名。
- route.plan/goto、build.plan/build 共用业务目标；计划和执行仍各有只读/动作入口。Construction 以同一 Target/现场差异处理放置、清空、建造与修复，保留单格等便捷能力。
- Library 唯一管理三类工作文件、头、CRUD 与扫描；ProgramPort 删除文件 CRUD，保留执行材料、编译、逻辑段与 guest。describe 只展开合同/路径，原文由 get 读取，同一材料不建两套索引。
- 查询统一使用 QueryDescriptor，删除 NativeCallable.read；完整执行记录统一 readRecord，删除三种专用读取端口。Runtime 唯一身体队列，Driver 不再保存 grant FIFO。
- contracts 收缩为所有权/协作导航，行为归所属模块；概要收缩为目标/组成/流程。常驻指南只留 Program 附录 A；统一按工具/通知携带摘要，不逐模型请求隐式注入状态。
- 本轮仅修订文档。静态检查单独记录，不代表产品实现、Windows 或真实 Minecraft 验收。

本文件只记"何时改了什么、为什么"。当前状态与文档地图在 [README](README.md)，合同在各模块文档里；**冲突时以模块文档为准，本文件不作规范**。

倒序：最新在上。

## 2026-10-18 · 离线连接与 chat 指令

- 将 Microsoft 与 offline 列为并列连接路径；offline 不需要 accountId/正版 UUID，离线账号独占按配置服务器端点和名字划分，LAN 使用实际端口。
- 将原 say action/能力/PlayerPort 方法统一改为 chat，不保留调用别名。保持 `{text}`；首字符 `/` 发送一条玩家服务器指令，普通消息和指令共享 Runtime 受理及效果记录。
- 明确单行、版本长度、实际发送边界、上游发送队列与取消；sent 不证明服务器指令成功，未知发送不重试。开发规划和两种认证/命令验收同步更新。
- 本轮仅修订设计，未恢复产品代码、未连接服务器。

## 2026-10-18 · 完整开发规划

- 新增全模块实施路线，区分风险验证、Host 回执、Runtime、Driver/World、Program/Library、Executor 装配、P0/P1/P2 与真实服务器验收。
- 把 session v3/v4 兼容明确为编码前阻塞裁决；旧数据只在临时副本上验证，不自动改写。
- 阶段验收分开记录 Fake、Worker/进程、Windows OS、真实 Minecraft 和模型复用证据；这是一份规划，不代表实现已开始。

## 2026-10-18 · 清理旧 Minecraft 实现

- 按终态设计重新开始：删除旧 Driver、World、Assets、contracts、Executor、WorldDef 及 21 个旧专属测试/helper，不把旧行为当作新实现基线。
- 删除旧 Worker 验证脚本和 package 命令，移除指向旧源码的 TypeScript/格式配置与 Mineflayer 边界自测；保留 Mineflayer 依赖供新 Driver 继续采用。
- 保留并标注终态设计；更新开发入口，清楚标记旧 fake bot/源码核查为历史证据。没有删除 world-data 或 profile 数据。
- 本次仅重置代码；未重写新实现，未运行测试或游戏验收。

## 2026-10-18 · Executor 终态收敛

- 确定 Windows 双命名 Job：同一适配内保留目录/账号两种真实独占，不做跨 Uina 自动抢占；自己的旧实例沿现有关闭/确认退役流程重建，不维护替代锁架构。
- 交付终态改为真实 Host 回执确认的 pending/committed。新增通用 Host 标记、状态查询和尝试退役合同；它依赖现有 Tool execution/Mailbox/Canonical history，尚未实现，不再接受旧工具交接窗口静默漏掉主动通知。
- 直返与后台共用 key=completionRef，查询补齐丢失回调/ACK；暴露交付状态与明确恢复，Host 忙碌不触发反复入队，允许重复呈现而不重跑动作。
- 16 KiB 仅为默认摘要预算，超出时保留 record 读取引用，不先导出；完整记录 auto 初始 256 KiB 内直接读，另可选 inline/file。文件只用于显式全文读取超预算或明确导出，缓存仍不是权威。
- 移除普通 config.json 的 timing/transport 参数，策略由内部统一注入；执行 façade 收敛为 selector/code，裸 selector 调保存程序，Library 的 name 与内部 SourceRequest 不改。
- 本轮完成终态合同修订与静态核对，未改产品代码、未提交；Host 接缝、IPC、原生绑定与真实游戏仍须实施验收。

## 2026-10-18 · Executor 审查修订

- 增加当前 launch 的可信 retirement 请求，使用优先 IPC 与 status/心跳锁存；心跳健康但隔离失败也能升级整树退役。
- 恢复确认同时绑定 attachment/gateRevision；带确认的调用不重建实例，不把旧确认移交新连接。
- stop 同一入口支持 Run 或原动作 requestId。撤销屏障、受理、continue 与调度启动在 Runtime 闭合；未受理撤销不虚建 Run。
- 同键准备 singleflight 与受理唯一约束支持明确重试，删除等待旧 attachment 退役的限制和发送前独立 attempted 提交；自动恢复仍只查证、不重发动作。
- readRecord 按不可变 record/completionRef 精确读原件，身份 Ref 固定最新截面；大记录导出 Runtime 所有的普通 JSON。报告 header 与正文形态分开，一份载荷失败不阻塞其他通知。
- 默认 wait 等完成/待决策并立即返回已有报告；显式 afterRevision 等变化，未来修订拒绝。控制/列表使用有完整性标记的小投影。
- 移除泛化 Run/Context policy 与 Executor defaultPolicy，保留具体能力参数及其有效值记录；校正 Uina 本地短窗口、取消与 void/null wire 规则。
- 本轮仅修改设计文档及静态检查材料；未实现上述协议、数据表、进程监管或游戏链路。

## 2026-10-18 · Executor 详细设计

- 增加 Executor 权威正文：一层六 action façade、请求与记录展开、配置、启动/关闭、受理查证和明确重试、状态与错误、BodyEndpoint、通知和故障推演。
- 采用 Uina 管理的 Node 伴生进程及私有 IPC；首个支持平台为 Windows。命名目录/账号 Job 合并独占、父退出绑定和进程树退役，不另建守护服务、锁文件抢锁或 Runtime 副本；实际 OS 行为待验收。
- 接入凭证独占 executor.db；Runtime 仍唯一拥有受理、执行与结算。say 复用 say@1 的 Runtime 路径；save from 在执行侧取快照，不搬源码绕回 Uina。
- 统一短窗口、input_accepted/input_settled、允许的通知重复/缺口；pendingDeliveries 改为分页引用，避免搬运整份结果集。无 Core 新事件、Host journal 扫描或动作自动重放。
- 查询 descriptor 补 examples，精确描述复用作者示例；无示例的文件条目明确缺失，不凭空猜参数。公开合同中的旧 world.status 名称对齐现行 world@1。
- Runtime/Driver/公开合同改为链接所属算法；概要、导航和旧 LEAD 同步。仅修改文档，未实现进程监管、IPC、接入账本或真实 Minecraft 链路。

## 2026-10-18 · Library 命名统一

- 将 `modules/assets.md` 改名为 `modules/library.md`，更新文档链接与现行模块名称，不保留旧文件别名。
- 清除受理和 World 保留合同中的旧资产发布语义；Library 仍是普通文件库，只保存弱链接，不参与证据强保留。旧 Assets 产品代码不在本轮修改范围内。

## 2026-10-18 · Program 最简设计修订

本轮仅修订文档，以下规则取代此前冲突裁决；产品实现、历史微基准及真实 Minecraft 验收均未更新。

- withBody 回调等待期间保留身体；waitUntil/sleep 不自动释放或延长输入有效期。原生能力自行持有时在长期等待前释放，接受委托时保留祖先身体。phase 与 control 分开描述。
- 领域能力自行判断目标，Runtime 删除独立目标状态、通用目标 verifier 与父子/跨段进度聚合；保留执行结果、效果核验和未知项。续段按新入口结算，不认证旧目标。
- decide 改为 guest 内同步异常，不发宿主 RPC；跨可信调用边界关联来源，根未处理才交还。
- 文件只允许一个可选结构化头。update 的完整源码替换与 metadata 补丁互斥；坏头通过完整源码修复。
- 保留共享 worker 与独立 guest，删除程序调用深度限制。通知保留三种递送状态，删除直返交接的专用恢复补报；交接缺口查询恢复，动作不重放。
- Program 与 Runtime 按开发阅读顺序重排，Driver 接缝合入所属章节；公开类型、示例、指南、导航及验收同步。

## 2026-10-18 · Program 组合、执行与复用合同修订

本轮为设计修订，未修改产品实现，未复跑历史微基准或真实 Minecraft 验收。以下条目取代早先同日的“终审/定稿”中与之冲突的裁决，历史原文仅记录当时选择。

- 保留 JS 文件与 call/read；等待改 waitUntil/timeoutMs，predicate 第二参数统一 {unknown}，多目标保留各自 versions，不合成全局游标。
- body.call 显式委托后，子上下文普通 call 继续传播同一 BodyScope；外部捕获上下文不升级，普通子退出不释放祖先身体。
- decide 产生可捕获的 NEEDS_DECISION；父可处理，根未处理才交还。程序 checkpoint 为自由 JSON + 来源，新段根只读 mc.checkpoint；领域 checkpoint 保留 schema。
- 改共享 worker + 每次调用独立 QuickJS runtime；取消段级容量队列。初始 1 worker/全局 32 guest/每 guest 16 RPC，满即拒绝。身体内 sleep(0) 仅让出计算，实际世界等待仍拒绝。移除默认累计 CPU 终止，保留连续计算预算并真正让出线程。
- 单段关闭只退役所属 guest；worker 故障先封闭其全部来源、撤销控制再终止确认，公开影响范围与未知效果。进度覆盖合并、日志有界批量传输。
- 目标型 collect 按本次入包数量完成，craft/build 不足抛带实际进度的领域错误；会话型 fight/follow 明确 ended，fight 可覆盖 retreatHealth。方块目标支持状态，物品选择复用 ItemSelector，区分连续/整数坐标与持久维度身份。
- 窗口回执给出可确认的自身变化，参照视图随其前进；后态不完整要求 snapshot。将原 orphans 推断改为记录父关闭时真实中断的 interruptedChildren。
- 程序元数据补 output/examples；损坏结构化头运行拒绝，完整新头可修复。普通文件可局部编辑；快照仅承诺源码追溯/恢复，不等于依赖锁定。
- 发现覆盖能力/程序/蓝图/经验并标 kind/callable。聊天事件明确属于 World 历史/游标扩展边界，本轮不新增事件系统。
- 更新权威正文、共享类型、完整脚本示例、模型指南与八条跨模块验收；历史案例和基准明确为旧证据，不记作当前通过。

## 2026-10-18 · 文档审查（不改设计，只改写法与去重）

- `README.md` 重写：状态表 + 文档地图 + 四步读法 + 按问题查阅；删掉 3 KB 单段修订流水账（在 git 历史与本文件里）。
- `public-api.md` 828 → 657 行：§6 由整章旧程序/资产接口压成 8 行"旧概念 → 现在"对照表；头与 §1 只留"读什么、谁拥有什么"；§5 删掉对 World 内部算法的复述（留类型 + 一句指针）；`ReadCallScope` 删掉 `wait`/`decide`/`checkpoint`（那是 Program 的面），`Entry.program.source` 统一为 `SourceRequest`。
- `runtime.md` §9/§10 重写：原 §9 一边写"已被 program.md 取代"一边继续用 `ProgramExecutionPort`/段级子进程/已取消的 `PROGRAM_CAPACITY` 写成现行规格，现在只留 Runtime 侧硬保证、容量规则与指针；§10 的 `WaitConditionDef` 与条件注册删除，等待按 `mc.waitForChange(targets, predicate, {afterMs})` 的三种结局重写。
- `driver.md` §5.1 的"等 Runtime 定了再决定 Driver 排队形态"闭合为"一个在途 `acquire` + FIFO 交接"；`SOURCE_UNAVAILABLE` 不再被 Driver 复用为租约拒绝（改 `DISCONNECTED`/`INTERRUPTED`）。
- `world.md`：`world.status@1` → `world@1`（状态落字段，不造查询）；`historySettled` 改为内部 `historyReady`；§17 的公开合同增补表改为指针（唯一形状在 public-api）；首屏修订史移入本文件。
- `contracts.md`：`contractRef` → `CallableDescriptor`/`ExactRef`；`mc.decision` → `mc.decide`（仅根调用）；`UNSUPPORTED`/`PRECONDITION`/`EFFECT_UNCERTAIN` 收编为 13 码 + `dispatch`/`unknownEffects`；删"复查意图"（那是第二套任务系统）。
- `design.md`：示例与能力名统一到扁平动作（`collect@1`/`craft@1`/`goto@1`/`fight@1`…）；"沙箱待验证/配额按实测"改为已定的 worker + QuickJS 与预算表；容量段补 guest/RPC 槽位超限即失败。
- 全库删掉 52 个指向不存在标题的 `#english-anchor`，只留文件链接。

## 2026-10-18 · 终审后做减法

用户 review 指出"反复追极端并发、加机制"已经过度防御。删减如下（均已在 `modules/program.md`、`modules/capabilities.md` 生效）：

- **校验与执行统一到同一个 QuickJS**：`validate` 用 `compileOnly` 只编译，删掉宿主 V8 预编译与两套诊断（实测 0.4–0.5 ms，V8 的 0.37 ms 没有速度优势）。
- **`waitForChange` 收窄到 8 个有观察游标的查询**（self/inventory/block/blocks/region/entities/world/places）；静态与派生查询（item/recipe/route.plan/build.plan/container.last）`version: null`，不进 watch——不为派生计算建响应式依赖图。
- **程序头删掉 `lesson`/`addLesson`**：程序存"怎么做"，Experience 存"发生了什么、学到了什么"；三处写经验必然互相矛盾。
- **`mc.decide` 降为仅根调用**：子程序得 `DECIDE_NOT_ROOT`，要交还就返回一个值。任意深度打断父任务是非局部控制，与 JS 组合语义冲突。
- **`computeBurstMs` 5000 → 20 ms**：一个 worker 内所有 guest 共享线程，5 秒等于让兄弟 guest 断 100 个 tick；QuickJS 中断只能终止、不能挂起，长计算由程序 `await mc.sleep(0)` 分片。
- **验收重心移到真实玩法**：新增"阶段 0"五个场景（取得木镐、采矿回基地、按图建屋、整箱与熔炉、探索遇敌撤退）定义"可用"，四组压测降为支撑证据。
- **发现质量用黄金查询锁住**：`describe {query:"造房子"/"挖矿"/"整理背包"}` 的三条测试规定"该进前排的进、无关的不占前排"，不过就改 descriptor 措辞，不建检索层。
- 明确 `§0.3`：不在隔离、身体仲裁、窗口校验、效果结算之外再造调度器/状态机/安全层；附录 C 标注为参考骨架，冲突以正文为准。

## 2026-10-18 · Program 详细设计定稿

- 程序 = **单文件合法 JS**（`programs/<name>.js` + 一行 `// uina {json}` 头注释，入口 `async function main(mc, input)`）；取消版本号、Manifest、依赖表、绑定表、发布流水线。
- **执行即快照**：每次调用按 `sha256` 内容寻址存 `runs/<run>/sources/<sha256>.js`；段内同名固定同一份字节。
- 身体控制统一到**调用谱系上的 BodyScope**：`mc.withBody` 独立申请、`body.call` 委托继承、`mc.call` 从不继承；一次一个委托，第二个 `BODY_BUSY`。
- 执行域 = world 伴生进程内的 worker + 每调用一个 QuickJS-WASM；容量"计数 + 立即拒绝"：4 域（跨段排队）、8 guest/域、16 在途 RPC/guest。
- 取消只取消等待，不取消已发生的事：已派发操作继续进 `EffectRecord`，迟到证据以稳定 `effectId` 追加，Run 不重开；无法确认 → `unknownEffects`，不报 `succeeded`。
- 库只有五个操作（list/get/save/update/delete）；程序不是 AssetKind，蓝图与经验归 Library。

## 2026-10-18 · 能力面详细设计

- 新增 `modules/capabilities.md`：**13 个查询 + 37 个动作**，扁平名 + `@1`，取代 `program.md` 旧 §3.4 的 7 查询 + 10 动作目录。
- 统一 **13 个失败码**（NOT_FOUND / UNREACHABLE / MISSING_MATERIAL / MISSING_TOOL / INVENTORY_FULL / CONFLICT / WRONG_STATE / TARGET_NOT_MET / INTERRUPTED / TIMEOUT / INVALID_INPUT / INTERNAL / DISCONNECTED）+ `hint` + `progress` + `remaining`。
- 参数冻结三层：Run 输入与策略在受理时冻结；Call 的输入/默认值/能力版本在派发前冻结（记 `CallRecord`）；世界状态、路径、目标选择持续观察。原则"意图稳定，世界动态"。
- 三个试算查询（`route.plan` / `build.plan` / `recipe.plan`）与执行共享实现；`build.plan` 返回蓝图 `digest`，`build` 用 `expectDigest` 发现漂移。
- 收编：`region@1` 几何读（palette + 索引，≤8192 格）、`container.last@1` 只记真实观察、`goto`（当前维度内）与 `transit`（跨维度/交通）分工、`fight` 的 `stance` 三档落成阈值表。

## 2026-10-18 · 数据布局固定

所有 Minecraft 数据在同一 `worldDataDir`（`.uina/world-data/minecraft/`）下并列：`programs/`、`blueprints/`、`experiences/`、`runs/<run>/sources/<sha256>.js`、`world-history.db`、`runtime.db`。程序按约定路径读写，不散落。**（批25 起被双根布局取代：world-history.db 与 library/ 留稳定根，executor.db/runtime.db/runs/exports 归 `sessions/<profileId>/`，见 2026-11-05 条与 multi-world-v3.md §4。）**

## 2026-10-17 · 架构重构

- World SQLite 迁入专用 Worker（提交屏障化历史查询）。
- ACK 收敛 durable-only：删 received 层/重传/outbox 与 R/recv 持久字段，schema v3。
- Driver 状态唯一所有权收编：gate 资格、会话使用归属、KeyHold、窗口 revision live getter、`setSlot` 单路径、say 停用准入。
- 历史 cursor 改取读取视图提交版本（双量纲水位：current=失效事件序，history=存储提交版本；混声明拒绝）。
- 身体调度唯一权威归 Runtime；`driver.close` 必须结算排队申请；durable 物理前提（WAL + synchronous=FULL）显式设定并核验；`pnpm verify:mc-worker` 用真实构建产物验证 Worker。

## 2026-10-15 · 目录整理

六份编号讨论稿合并为本目录的概要（`design.md`）、行为契约（`contracts.md`）、公开接口（`public-api.md`）、研究记录（`archive/research.md`）与各模块详细设计；原稿快照存 `../../../.artifacts/minecraft-design-originals-20261015-144602.zip`。

## 2026-10-15 ~ 10-17 · 各模块定稿与重构（原先写在正文首屏，已移到这里）

- **Driver（10-15 定稿，10-17 修订）**：PHY-STEP 物理窄接缝降为条件条款（同进程事件计数已满足 drive/feedback 合同，接缝只在安装异步化或插件归属取证时实现）。10-17 架构重构：Gate 成为资格与操作记录的唯一权威（无第二份 active 指针/操作集合）；原生使用状态唯一权威 = Body 会话；按键持有收编为 KeyHold（撤销只清本根）；窗口 revision 唯一权威 = WindowSession；`say` 经 gate 停用准入（不要求 Body Permit）；删除 Operation 的资源标签字段，资源归属改由 KeyHold/useControl/会话登记等具体机制承载。
- **World（10-16 定稿，10-17 三轮修订）**：SQLite 专用 Worker + 提交屏障化历史查询 + ACK 收敛为 durable-only；历史 cursor 改取读取视图版本、双量纲水位、durable 物理前提核验；§9.1 失效只按查询可见边界定义（混合查询与时间阈值为条件条款）；§13.1 两段初始化（当前基线先行、历史独立 opening）；存储身份冲突核验；schema v3 对齐。
- **Runtime**：§9/§10 的 Program 执行合同、等待原语在 10-18 由 `program.md` 取代，正文已改为指针与 Runtime 侧硬保证。
