# Uina 语音发声与打断扩展（TTS Extension）

初奈系统的系统级外部语音扩展，独立部署于 `.uina/extensions/tts/`。

## 架构特性

- **内核绝对零侵入**：核心 `src/` 不包含任何 Python、音频或语音代码，即插即用；
- **高内聚、单一事实源**：
  - `stream-parser.ts`：流式分句、Emoji/Markdown 剥离、`<think>` 静音、代码块替换、括号心理活动免播、千分位小数保护；
  - `driver-impl.ts`：正文与 `voice.speak` 的统一来源调度、播放账本、epoch、幂等、poison/unknown 屏障；
  - `client.ts`：8102 HTTP/SSE 权威通信客户端，并在复用 Bridge 前完成 `/health` + OpenAPI 能力握手；
  - `companion.ts`：伴生进程按需拉起、UTF-8 环境注入与所有权自律清理（只停止本扩展明确拉起的进程）。
- **全双工主体自律打断**：用户新输入时不自动截断上一轮声音；Agent 可显式调用 `voice.interrupt`，结果严格区分已打断、无需操作、失败和未知；
- **估计式字符断点**：打断时向 `tts_bridge` 提取 `revealed_text` 与播放时钟，向模型报告估计的听觉断点，不宣称逐字声学对齐；
- **Producer-Consumer 绝对解耦**：`tts_bridge` 对外广播按物理播放身份标记的事件流和完整播放快照 SSE；Live2D 与独立 `E:/Uina/ThirdParty/realtime-subtitles` 服务各自订阅，TTS 不向 OBS 发同步 HTTP 请求。

## 配置项 (`config.json`)

```json
{
  "serviceUrl": "http://127.0.0.1:8102",
  "pythonPath": "E:\\Uina\\ThirdParty\\gpt_sovits_v2pro\\runtime\\python.exe",
  "bridgeScript": "bridge/main.py",
  "bridgeConfig": "bridge/config/service.toml",
  "startupTimeoutMs": 30000,
  "requestTimeoutMs": 5000,
  "autoSpawn": true,
  "maxSentenceChars": 20
}
```

## 音频文件工具 (`tts_generate`)

`tts_generate({text})` 将完整台词合成为 WAV 文件，不播放；正文只返回普通文件 `resource` 和实际 `durationMs`。成品及中间件使用项目级 `uina/tmp/`，可把结果直接交给 QQ 的 `audio.resource`。生成独立于静音、字幕、口型和播放任务生命周期。部署可选 `generationTimeoutMs`，默认总期限 120000ms；无需修改模型参数。新接口需要当前 Bridge 源码，旧 Bridge 会明确提示更新重启。完整合同及失败边界见 [TTS 文件生成](../../../docs/tts-file-generation.md)。

## 门面工具 (`voice`)

大模型与用户可通过 `voice` 工具进行交流控制与查询：
- `speak`：将一段台词提交到统一播放路径，可选 `replace`；受 `invocationId` 幂等保护
- `interrupt`：请求立即掐断当前发音并清空排队；结果区分已打断、无需操作、失败和未知
- `status`：查看是否仍在说、是否有未完成内容、当前播放断点和可确认的交付事实
- `manage.mute` / `manage.unmute`：管理静音偏好，不把偏好当作设备播放成功
- `manage.set_text_reading`：独立管理正文自动朗读偏好


## 真实边界

- `Bridge /health`、端口可达、OpenAPI 可达或任务已受理，都不等于合成完成、设备播放完成或用户听见。
- 复用外部 Bridge 前必须通过协议能力握手；旧协议只会被报告为可达但不兼容，不会被扩展自动杀死。
- `tts.inspect` 观察物理事实，`tts.recover` 只执行一次有限维修，`tts.test` 才执行真实 synthesis/playback 验证路径。
- 默认 `tts.recover({action:"recover"})` 对连接、订阅和原任务进行有限恢复；只有存在未确认缺口时才尝试一次停止确认与 reset。模型接口不再暴露手动 reconnect/reset；重启仍需明确指定自有目标。
- 每次激活有固定控制会话，正文流与显式 speak 各有独立来源和从 1 开始的编号。声音协议版本为 2。正文提交未知不等于服务离线；新回合不覆盖旧声音，恢复不重播旧台词，静音立即停止并保留偏好。详见 [当前合同](../../../docs/voice-tts-runtime.md)。
- `runtime.perception` 是 Voice 的一次性瞬态投影，不进入 canonical history 或 compaction；正常进度、idle 和排空不会生成感知候选。
- 真实 Vendor、声卡、外部进程退出和用户是否听见，必须在对应环境现场验证，不能由 mock 或 HTTP ready 代替。

## 播放事实流

当前播放快照通过以下接口提供给可选消费者：

```text
GET /v1/tts/playback/events
```

第一帧和后续帧都是完整快照，包含 `sourceInstance`、实例内 `revision`、物理 `playback.id`、播放位置、时钟质量和清洗后的对白。慢消费者只保留最新快照，不会阻塞音频；字幕服务不可用也不会影响 TTS 播放。

旧的 `/v1/tts/events` 继续服务 Live2D 和现有电平消费者。OBS 字幕由独立服务负责，当前扩展不保存 OBS 地址或管理 OBS 生命周期。


### OBS 字幕伴生启动

当前 TTS Extension 激活时会并行检查字幕服务的 `/health`。服务未运行时，默认启动 `E:/Uina/ThirdParty/realtime-subtitles`；启动失败会报告降级，TTS 仍可正常发声。已运行的外部服务直接复用，扩展卸载时只关闭自己启动的进程。

配置位于本扩展的 `config.json`：

- `subtitleServiceUrl`：默认 `http://127.0.0.1:18140`。
- `subtitleServiceDir`：默认 `E:/Uina/ThirdParty/realtime-subtitles`。
- `subtitleAutoSpawn`：默认 `true`，设为 `false` 后只连接已运行的服务。
- `subtitleStartupTimeoutMs`：默认 `10000`。

启动优先使用 `dist/main.js`，未构建时使用已安装的 `tsx` 运行源码。首次安装字幕服务依赖并构建后，重新加载 TTS 扩展即可自动启动。设置页为 `http://127.0.0.1:18140/`，OBS Browser Source 地址为 `http://127.0.0.1:18140/overlay/`。这是由 TTS 扩展暂时管理的伴生进程，不引入 Core 生命周期接口。
