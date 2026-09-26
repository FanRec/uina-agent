# 网易云音乐点歌机（Jukebox）应用与开发指南

`netease-jukebox` 是 Uina 的官方标杆大模型应用程序（App）之一，存放于 `.uina/apps/netease-jukebox/`。

它向数字主体（初奈）提供了完整的音乐点播、搜索、音量调节、播放控制与当前状态感知能力，并完整演示了 **长音频播放内核**、**外部伴生服务守护（Companion Service）** 与 **三档上下文视口（Context Viewport）** 的标准实现。

---

## 1. 核心特性

- **大模型单一门面工具（Facade Tool）**：向大模型仅暴露一个 `jukebox` 工具，聚合搜索、点播、暂停、继续、停止、音量与状态查询，避免平铺大量零散工具。
- **MPV 真实硬件音频输出**：基于 MPV 播放器内核，支持高清音频流硬件解码输出，具备毫秒级播放进度查询与音量线性控制。
- **伴生进程自动托管（api-enhanced）**：启动时自动探测 `3000` 端口健康状态，若未运行则自动拉起本地网易云 API 后台服务，并在退出时优雅终止，**绝不残留孤儿进程**。
- **环境感知视口（Ambient Viewport）**：音乐在后台播放时，每回合仅占用 ~15 Tokens 维持单行环境状态感知。即使用户在和初奈聊哲学，中途问“现在放的是哪首歌？”，初奈也能直接准确回答，无需额外打开控制面板。
- **防 Prompt Injection 隔离**：搜索到的歌曲名、歌手名与专辑名等不可信外部数据，在进入上下文前强制包裹在 `<data>...</data>` 标签中。

---

## 2. 交互动作（Actions）详解

大模型在调用门面工具 `jukebox` 时，支持以下 7 个动作：

| 动作 (Action) | 说明 | 参数与别名支持 | 调用示例 |
| :--- | :--- | :--- | :--- |
| **`play`** | 搜索并播放歌曲，或按 ID 播放 | - `query`（别名：`keyword`, `song`, `name`, `q`）<br>- `song_id`（别名：`id`, `music_id`） | `{ action: "play", params: { query: "晴天" } }`<br>`{ action: "play", params: { song_id: "186016" } }` |
| **`search`** | 搜索歌曲列表（返回前 N 首） | - `query`（必填，关键词）<br>- `limit`（可选，默认 10） | `{ action: "search", params: { query: "周杰伦", limit: 5 } }` |
| **`pause`** | 暂停当前正在播放的曲目 | 无 | `{ action: "pause" }` |
| **`resume`** | 恢复播放已暂停的曲目 | 无 | `{ action: "resume" }` |
| **`stop`** | 停止播放并清空当前曲目 | 无（执行后视口自动隐退为 `hidden`） | `{ action: "stop" }` |
| **`volume`** | 调整播放音量或查询当前音量 | - `level`（别名：`volume`, `value`, `percent`，0-100）<br>- 留空时查询当前音量 | `{ action: "volume", params: { level: 80 } }`<br>`{ action: "volume" }` |
| **`status`** | 查询当前播放曲目、状态与进度 | 无 | `{ action: "status" }` |

---

## 3. 配置文件：`config.json` 详解

点歌机遵循配置与代码分离原则，在应用根目录下读取：  
👉 `.uina/apps/netease-jukebox/config.json`

### 3.1 完整配置示例
```json
{
  "apiBaseUrl": "http://localhost:3000",
  "apiEnhancedDir": "E:\\Uina\\ThirdParty\\api-enhanced",
  "mpvPath": "C:\\Program Files\\MPV Player\\mpv.com"
}
```

### 3.2 字段说明与优先级
| 配置项 | 类型 | 默认值 | 说明与环境变量覆盖 |
| :--- | :--- | :--- | :--- |
| **`apiBaseUrl`** | `string` | `"http://localhost:3000"` | 网易云 API 服务 HTTP 请求基地址。<br>*环境变量*：`NETEASE_API_URL`。如果使用局域网/远端 API，填入对应地址即可免拉起本地进程。 |
| **`apiEnhancedDir`** | `string` | `"E:\\Uina\\ThirdParty\\api-enhanced"` | 本地 `api-enhanced` 源码目录路径。<br>*环境变量*：`NETEASE_API_DIR`。伴生服务管理器在端口未启动时，会在此目录下执行 `node app.js`。 |
| **`mpvPath`** | `string \| null` | `null` (自动探测) | 指定 MPV 播放器可执行文件路径。<br>*环境变量*：`MPV_PATH`。留空时系统会自动在常见安装目录探测。 |

---

## 4. 架构设计与内部模块职责

```text
.uina/apps/netease-jukebox/
  ├── package.json          # 声明 "type": "module", "main": "./index.ts"
  ├── config.json           # 外部配置文件
  ├── config.ts             # 配置加载器（入参 > config.json > 环境变量 > 默认值）
  ├── types.ts              # 领域模型：SongInfo, JukeboxState, JukeboxAppConfig
  ├── api-client.ts         # 网易云 API HTTP 客户端（含超时与降级容错）
  ├── companion.ts          # 伴生服务守护者（端口探测、进程拉起与终止闭环）
  ├── player.ts             # MPV 硬件播放器与静音模拟器实现
  └── index.ts              # App 组合根：契约组装、三档视口渲染与默认导出
```

### 4.1 伴生服务管理机制 (`companion.ts`)
采用**“探测优先，谁拉起谁清理”**的黄金准则：
```text
调用 play / search
       │
       ▼
[CompanionManager.ensureRunning]
       │
       ├─► 1. 探测: apiClient.isHealthy(1500)
       │     └─ 成功: 外部服务已在运行，直接复用 (spawnedByUs = false)
       │
       └─► 2. 失败: 本地未运行
             ├─ 检查 apiEnhancedDir 下是否存在 app.js
             ├─ spawn("node", ["app.js"], { cwd: apiEnhancedDir, windowsHide: true })
             ├─ 标记 spawnedByUs = true
             └─ 轮询等待健康检查就绪 (超时 10 秒)
```
- **优雅停机**：应用卸载或 Uina 退出时触发 `onStop()`，若 `spawnedByUs === true`，则立即发送 `kill()` 终止子进程，**绝不遗留死锁 3000 端口的孤儿进程**。

### 4.2 播放内核设计 (`player.ts`)
- **`MusicPlayer` 统一抽象**：
  提供 `load(url, durationMs)`、`pause()`、`resume()`、`stop()`、`setVolume(vol)` 与 `progress()` 接口；
- **`MpvPlayer` 硬件实现**：
  - 基于 IPC（Windows Named Pipe `\\.\pipe\uina-mpv-xxx` 或 Unix Domain Socket）与 MPV 守护进程保持双向通信；
  - 监听 `end-file` 事件，在歌曲自然播放结束时自动重置播放器状态为 `idle`；
- **`SimulatedMusicPlayer` 模拟器降级**：
  - 本地未安装 MPV 时自动激活，模拟播放计时与状态流转，保证无头服务器与测试环境 100% 通过。

---

## 5. 三档上下文视口（Context Viewport）规范

点歌机根据播放生命周期动态切换三档视口：

### 5.1 `hidden`（0 Token）
- **触发时机**：应用停用、未启动，或执行 `stop` 之后；
- **效果**：大模型上下文中不注入任何点歌机文本。

### 5.2 `ambient`（~15 Tokens 常驻环境感知）
- **触发时机**：歌曲正在播放中（`playing`）或暂停中（`paused`）；
- **呈现效果**：
  ```text
  [Jukebox: 正在播放 "晴天" - 周杰伦 (01:23/04:29)]
  ```
  或者：
  ```text
  [Jukebox: 已暂停 "晴天" - 周杰伦 (01:23/04:29)]
  ```
- **核心价值**：极省 Token，同时让大模型拥有“耳朵”，知晓当前正在放什么音乐。

### 5.3 `expanded`（~150 Tokens 完整交互面板）
- **触发时机**：大模型调用 `jukebox({})`（空参数）主动展开控制台时；
- **呈现效果**：
  ```text
  ## 网易云音乐点歌机 (Jukebox)
  状态: ▶ 播放中
  播放内核: 🔊 MPV 硬件解码音频输出
  音量: 80%
  当前曲目: 晴天 - 周杰伦
  专辑: 叶惠美
  进度: 01:23 / 04:29

  ### 最近搜索结果:
    1. [186016] 晴天 - 周杰伦 (04:29)
    2. [186017] 晴天 (伴奏) - 周杰伦 (04:29)

  ### 常用操作调用示例:
  - 搜索歌曲: { action: "search", params: { query: "歌名" } }
  - 点播歌曲: { action: "play", params: { query: "歌名" } } 或 { action: "play", params: { song_id: "歌曲ID" } }
  - 调整音量: { action: "volume", params: { level: 80 } }
  - 播放控制: { action: "pause" } / { action: "resume" } / { action: "stop" }
  ```

---

## 6. 测试与质量保证

点歌机拥有完善的自动化测试覆盖：
- 单元与集成测试：[`tests/netease-jukebox.test.ts`](file:///e:/Uina/Uina/tests/netease-jukebox.test.ts)
  - `SimulatedMusicPlayer` 播放/暂停/继续/进度/自然结束事件验证；
  - `NeteaseApiClient` 健康检查、搜索解析、歌曲直链获取与异常容错验证；
  - `CompanionManager` 服务已存在直接复用与非存在目录容错验证；
  - `AppFramework` 门面工具挂载、全动作执行、视口切换与 `loadExternalApps` 外部动态装配全流程验证。
- 质量指标：全模块 CRAP 复杂度 $\le 5.0$（远低于 30 重构警戒线）。
