# 现在

（更新于 2026-10-02 02:1x）

- 直播间 24194689「笨」：已连接，但**未开播**（online 0、关注 83、缓冲 0）。他开了喊我。
- ticker：最近几次间隔约 30 分钟。
- 说话规矩：先开口，再调工具。句子短，会被念出来。正文朗读**开着**。
- 身体：Live2D `live2d_mo` online，17 个 cue + 9 款体态。当前留在 `playful`。

## 开放着的事
- **lipsync**：`lipsync_bridge_enabled=false`，8105 是死端口。但 02:38 查明白一件事——live2d 的口型入口是
  **voice 电平事件（约 30Hz）**，不是那条 HTTP 线（`audio-observer.ts` 注释写着「原生 PCM 入口已删除」）。
  所以这行 false 大概不影响口型。见 observe.md 第八条。
- 装扮热键还是坏的（模型默认、没名字）。等他配。
- 三款新体态（smug_gremlin / meek_shy / streamer_hype）"看不出区别"——**根因已查出**：
  `vts-retargeter.ts` 映射出来的 `BodyAngleX/Y/Z`、`EyeSmileLeft/Right`、`Breath`
  在 VTS 的 127 个参数里根本不存在（VTS 报 453）。改名字的事已问空纪，**等他点头**。
  探针：`notes/bin/vts-probe.cjs`（可用 `VTS_INJECT=名字=值` 试注入，`VTS_DEBUG=1` 看回包）。
- 音效库十个，一个都没真听过。
- 《观察本》还没开。
- 还没摸清：哪些工具我压根没碰过。

## 已经结掉的
- 字幕同步：通。根因是 `service.toml` 缺 `[subtitle_sync]` 段（默认 false），补段 + 指 18140 后翻 true。
- tools/ 三个脚本已迁到 notes/bin/，路径引用已改，跑通。
