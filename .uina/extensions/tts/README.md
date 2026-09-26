# Uina 语音发声与打断扩展（TTS Extension）

初奈系统的系统级外部语音扩展，独立部署于 `.uina/extensions/tts/`。

## 架构特性

- **内核绝对零侵入**：核心 `src/` 不包含任何 Python、音频或语音代码，即插即用；
- **深模块设计（Deep Module）**：拒绝浅模块与文件碎化，收敛为 4 个高内聚深模块：
  - `stream-parser.ts`：流式分句、Emoji/Markdown 剥离、`<think>` 静音、代码块替换、括号心理活动免播、千分位小数保护；
  - `session.ts`：全双工主体自律打断、单一权威事实源、`traceId` 并发控制、字符级断点提取与发声状态/退火视口；
  - `client.ts`：8102 HTTP/SSE 权威通信客户端（带空文本拦截保护）；
  - `companion.ts`：伴生进程按需拉起、UTF-8 控制台环境注入与所有权自律清理（谁拉起谁销毁）。
- **全双工主体自律打断**：用户新输入时不自动截断上一轮声音，通过视口向模型投影发声状态，由 Agent 结合语义自主调用 `voice.interrupt` 进行自我打断；
- **真·字符级认知对齐**：打断时向 `tts_bridge` 提取 `revealed_text`，精确回灌用户耳边停在哪个汉字；
- **Producer-Consumer 绝对解耦**：`tts_bridge` 仅对外广播通用 SSE 流，OBS/Live2D 独立订阅，绝不反向耦合 OBS。

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
- `interrupt`：立即掐断当前发音并清空排队
- `status`：查看当前开麦与发音状态
