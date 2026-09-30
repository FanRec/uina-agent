# Uina 语音发声与打断扩展（TTS Extension）

初奈系统的系统级外部语音扩展，独立部署于 `.uina/extensions/tts/`。

## 架构特性

- **内核绝对零侵入**：核心 `src/` 不包含任何 Python、音频或语音代码，即插即用；
- **深模块设计（Deep Module）**：拒绝浅模块与文件碎化，收敛为 4 个高内聚深模块：
  - `stream-parser.ts`：流式分句、Emoji/Markdown 剥离、`<think>` 静音、代码块替换、括号心理活动免播、千分位小数保护；
  - `session.ts`：全双工主体自律打断、单一权威事实源、播放身份并发控制与发声状态/退火视口；
  - `client.ts`：8102 HTTP/SSE 权威通信客户端（带空文本拦截保护）；
  - `companion.ts`：伴生进程按需拉起、UTF-8 控制台环境注入与所有权自律清理（谁拉起谁销毁）。
- **全双工主体自律打断**：用户新输入时不自动截断上一轮声音，通过视口向模型投影发声状态，由 Agent 结合语义自主调用 `voice.interrupt` 进行自我打断；
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

## 门面工具 (`voice`)

大模型与用户可通过 `voice` 工具进行状态控制与查询：
- `mute`：关麦（静音模式，后续只打字不发音）
- `unmute`：开麦（恢复发音）
- `interrupt`：请求立即掐断当前发音并清空排队；结果区分已打断、无需操作、失败和未知
- `status`：查看当前开麦与发音状态

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
