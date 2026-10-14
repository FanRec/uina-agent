# QQ P7 / G8 媒体验收证据

日期：2026-10-07，显示时间 Asia/Shanghai（GMT+08:00），证据 JSON 时间保持 UTC。

1. **用户可见行为**：speak 支持普通文件形式的图片/音频/文件/视频，也支持当前账号已知的 qq_media 平台地址；set_avatar 复用图片资源管线。模型可见入站媒体引用、URL、文件名及“未展开”。禁止从媒体引用推断理解内容。
2. **唯一 owner**：QQ World 持有媒体 staging 与派生索引；facts-journal 的消息事实是索引唯一权威，operation-log 是清理/unknown 判据。修改 `media-root.ts/media.ts/config.ts/types.ts/ingest.ts/facts-journal.ts/app.ts/render.ts/operation-log.ts/transport.ts/index.ts`，新增 `tests/qq-world-media.test.ts` 与 `scripts/verify-qq-media.mts`，补充传输测试。不新增 Core、Host、UI 接缝。
3. **结果语义**：资源验证/复制/意图保存失败 → failed + not_started，零平台派发；file/video 独立批次，按输入顺序发送，停止时返回已确认部分；取消前不派发，派发后超时/不明负回执 → unknown；不自动重发。unknown/孤儿副本跨重启保留，确定结论启动清理；源文件仍由生成/播放侧独立拥有。
4. **当前验证命令**：

   - `pnpm typecheck` → 通过，含格式、6 条边界规则和 TypeScript。
   - `pnpm test` → 126 文件通过，1548 passed + 1 expected fail，2026-10-07 22:05:18 GMT+08:00 开始；不是零 expected-fail 声明。
   - `pnpm build` → exit 0。
   - `pnpm exec vitest run tests/qq-world-contract.test.ts tests/qq-world-framework-seams.test.ts tests/qq-world-actions.test.ts tests/qq-world-lifecycle.test.ts tests/qq-world-media.test.ts tests/qq-world-persistence.test.ts tests/qq-world-render.test.ts tests/qq-world-scheduler.test.ts tests/qq-world-transport-ingest.test.ts` → 190/190。
   - 独立只读审查定位上游实际 file 重排、video fallback 和 bridge failed 包装；修复有 RED→GREEN 回归。审查使用固定 `87527cb` 源码，真实部署版本另列，不假定两者完全等同。

5. **真实证据**：使用已有 QQ 配置但不修改，绑定账号 `3768832841`，唯一获授权目标 `3415086023`；真实只读 `get_version_info` 返回 `SnowLuma 1.14.21-node / v11`。

   | 验证 | 命令 / 证据 | 结论 |
   | --- | --- | --- |
   | 图片、WAV、文本文件 | `pnpm exec tsx scripts/verify-qq-media.mts --target 3415086023`；[原始回执](../../../generated/qq-media-verification/2026-10-07T13-54-09-506Z/evidence.json) | 三项平台成功；用户回复“三项均正常”确认显示、播放、打开。WAV 是生成的 1 秒 440Hz 测试音，没有调用 TTS/播放。 |
   | 能力与越界 | 同脚本 `--probe-only`；[探测结果](../../../generated/qq-media-verification/2026-10-07T13-57-15-009Z/evidence.json) | image/audio yes=true；video/file 保持未知；根外临时 fixture rejected 为 failed/outside_roots/not_started，无操作日志记录。 |
   | 最终分批顺序 | 同脚本 `--mixed-only`；[最终回执](../../../generated/qq-media-verification/2026-10-07T14-04-58-265Z/evidence.json) | 三独立 operationRef 与 messageRef；用户随后附图确认 first.txt → 文字 → last.txt。 |

   原始证据 JSON 的 peerPresentation 保留运行时当刻“未验证”标记；对端确认发生在运行之后，以上用户回复/截图作为补充证据，不倒填程序观察。

6. **范围限制**：头像路径离线验证；真实配置只有 observation/messaging，未获头像修改授权。视频离线验证分批/映射，未做真实视频格式/播放验收。仅确认本次 WAV 通过，不宣称所有音频格式/转码可用。TTS render_file → QQ 的真实组合未验，入站下载/vision 不在 v1。G9 的完整管理事务与 G10 真实模型仍未验。
7. **工作树归属**：本轮修改仅限上述 QQ 媒体链、测试、验证脚本及规划/证据文档；其他脏改动未主动修改、未重置。QQ 前期实现本就整组未跟踪，因此没有把之前各阶段一起提交为本次 P7，也没有创建不含其依赖的残缺提交；本轮未 commit/push。验证使用隔离数据目录，不读取或修改真实 qq-facts/qq-operations/Session；不访问含账号数据的 SnowLuma 发行版。
