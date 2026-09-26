# Bilibili 直播接入应用 (`bilibili-live`)

`bilibili-live` 是 Uina 的官方应用（App）之一，存放于 `.uina/apps/bilibili-live/`。

它向数字主体（初奈）提供了纯原生、零外部依赖的 B 站直播间弹幕监听、礼物、醒目留言（SuperChat）、上舰与人气值感知能力。

---

## 1. 核心架构与特性

- **纯 TypeScript 完整重构（`blivedm` 引擎）**：
  - **零外部依赖**：基于 Node 22 原生能力（`globalThis.WebSocket`、`node:zlib`、`node:crypto`、`globalThis.fetch`），无需任何外部 npm 包，彻底告别 Python 虚拟环境与 IPC 子进程。
  - **严格 16 字节大端协议包**：完整实现 B 站底层二进制协议头编解码与单包/多包粘包偏移循环切分。
  - **原生解压**：支持 Brotli（`brotliDecompressSync`）与 Deflate（`inflateSync`）多层解包。
  - **完整 WBI 签名算法**：内置 32 位置换表混淆与 MD5 鉴权，支持动态获取 `img_key` 与 `sub_key`，彻底解决 `-352` 校验风控。
- **生产级长连接自愈能力 (`WebSocketClientBase`)**：
  - **线性退避重连**：默认 1s 起步、步进 1s、封顶 10s 渐进重连。
  - **多 CDN 节点故障转移**：自动按重试周期轮询 `host_list` 节点，连续失败 3 次自动重新获取 Token。
  - **连接假死超时检测**：默认 35 秒内若无任何服务器消息返回，主动判定连接假死并触发自愈重连。
- **双协议客户端支持**：
  - **Web 端直播间客户端 (`BilibiliLiveClient`)**：支持房间短号转真实长号、WBI 签名拉取 Token、实时弹幕/礼物/SC/上舰/人气值分发。
  - **官方开放平台客户端 (`OpenLiveClient`)**：支持官方开发者 HMAC-SHA256 请求签名、项目场次开启（`/v2/app/start`）、20 秒心跳自愈与优雅停机（`/v2/app/end`）。

---

## 2. 代码地图

```text
.uina/apps/bilibili-live/
  ├── package.json          # 声明 "type": "module", "main": "./src/index.ts"
  ├── README.md             # 本说明文档
  ├── DESIGN.md             # ⭐ 架构设计规范与认知学视口设计
  └── src/
      └── blivedm-ts/
          ├── protocol.ts     # 1. Wire 协议深模块 (16字节头编解码, Brotli/Deflate递归解压, 畸变包防御)
          ├── wbi.ts          # 2. WBI 安全鉴权深模块 (32位置换表混淆, MD5签名, TTL缓存与动态秘钥拉取)
          ├── events.ts       # 3. 领域事件与解析深模块 (Web与开放平台事件模型, 纯解析函数)
          ├── connection.ts   # 4. 弹力长连接传输深模块 (代际控制防幽灵连接, 退避重连, 假死检测, 严格鉴权)
          ├── client.ts       # 5. Web 直播间客户端 (BilibiliLiveClient)
          ├── open-live.ts    # 6. 官方开放平台客户端 (OpenLiveClient, HMAC签名, 项目生命周期)
          └── index.ts        # blivedm-ts 统一总导出
```

---

## 3. 快速使用示例

### 3.1 Web 直播间监听 (最常用)

```typescript
import { BilibiliLiveClient } from "./src/blivedm-ts/index.js";

const client = new BilibiliLiveClient({
  roomId: 6, // 支持短号或长号
  autoReconnect: true,
});

client.on("connected", () => {
  console.log("成功连接直播间！");
});

client.on("danmaku", (event) => {
  console.log(`[弹幕] ${event.uname}: ${event.text}`);
});

client.on("gift", (event) => {
  console.log(`[礼物] ${event.uname} 赠送了 ${event.count} 个 ${event.giftName}`);
});

client.on("superChat", (event) => {
  console.log(`[SC ￥${event.price}] ${event.uname}: ${event.message}`);
});

client.on("guardBuy", (event) => {
  console.log(`[上舰] ${event.uname} 开通了 ${event.giftName}`);
});

client.on("heartbeat", (event) => {
  console.log(`[人气值] ${event.popularity}`);
});

await client.connect();
```

---

## 4. 测试与验证

全量单元与真实网络测试位于 `tests/bilibili-live.test.ts`：

```bash
pnpm test tests/bilibili-live.test.ts
```
