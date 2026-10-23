/**
 * 临时脚本：直连 Provider 实测 DeepSeek Flash 的流式解码速率（TPS）。
 * 绕开 Uina 客户端，用最朴素的一条 SSE 请求量出真实吞吐，用于和 UI 表盘对照。
 *
 * 用法（在仓库根目录）：
 *   node scripts/measure-deepseek-tps.mjs                          # 默认 provider，关闭思考，3 轮
 *   node scripts/measure-deepseek-tps.mjs --provider deepseek      # 指定 auth.json 里的 provider 名
 *   node scripts/measure-deepseek-tps.mjs --thinking high --thinking-format deepseek
 *   node scripts/measure-deepseek-tps.mjs --rounds 5 --prompt "自定义问题"
 *
 * 口径：ttft = 请求发出 → 首个内容 delta（思考或正文）；decode = 首个内容 delta → 末个
 * 内容 delta（不含 usage 尾部 RTT）；tps = usage.completion_tokens ÷ decode。
 * 与 Uina 表盘同口径，因此两边数字应当一致；若不一致，说明客户端还有问题。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 参数 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argOf(name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const DEFAULT_PROMPT = "请直接输出一段约 500 字的连贯短文，介绍 TCP 与 UDP 的区别。不要分点，不要标题，直接开始正文。";
const rounds = Number(argOf("--rounds", 3));
const providerArg = argOf("--provider", undefined);
const thinking = argOf("--thinking", "off");
const thinkingFormat = argOf("--thinking-format", "effort");
const prompt = argOf("--prompt", DEFAULT_PROMPT);
// 填充上下文：在用户消息前面拼 N 字填充文本，模拟大上下文会话（用于验证解码速率是否随上下文长度下降）。
const ctxChars = Number(argOf("--ctx-chars", 0));

const FILLER =
	"下面是一段与任务无关的技术背景资料，仅供上下文，不需要总结、不需要引用、不需要回应其中的任何内容。" +
	"计算机网络中，路由器工作在网络层，根据 IP 地址转发分组；交换机工作在数据链路层，根据 MAC 地址转发帧。" +
	"TCP 提供面向连接的可靠传输，通过序列号、确认应答、超时重传保证不丢不乱；UDP 提供无连接的尽力交付，开销小、时延低。" +
	"操作系统的进程调度策略包括先来先服务、最短作业优先、时间片轮转与多级反馈队列，各有取舍。" +
	"数据库的 ACID 分别指原子性、一致性、隔离性与持久性，事务是实现它们的基本单位。";
function buildUserContent() {
	if (ctxChars <= 0) return prompt;
	const repeated = FILLER.repeat(Math.ceil(ctxChars / FILLER.length)).slice(0, ctxChars);
	return `${repeated}\n\n---\n以上是无关背景资料。现在回答真正的问题：${prompt}`;
}
const userContent = buildUserContent();

// ── 配置：读 ~/.uina/auth.json（与 Uina 同源，不另设密钥） ───────────────────
const home = process.env.UINA_HOME ?? homedir();
const authPath = join(home, ".uina", "auth.json");
if (!existsSync(authPath)) {
	console.error(`找不到 ${authPath}；本脚本与 Uina 共用同一份配置。`);
	process.exit(1);
}
const config = JSON.parse(readFileSync(authPath, "utf8"));
const providers = config.providers ?? {};
const providerName =
	providerArg ?? Object.keys(providers).find((name) => /flash/i.test(providers[name]?.model ?? "")) ?? config.default;
const provider = providers[providerName];
if (!provider) {
	console.error(`provider "${providerName}" 不在 ${authPath} 里。现有：${Object.keys(providers).join(", ")}`);
	process.exit(1);
}
if (provider.apiKey === undefined) {
	const envKey = process.env[`UINA_API_KEY_${providerName.toUpperCase()}`];
	if (envKey !== undefined) provider.apiKey = envKey;
}
if (!provider.apiKey) {
	console.error(`provider "${providerName}" 缺少 apiKey。`);
	process.exit(1);
}
const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;

// ── thinking 的三种 wire 形态（与 src/ai/gateway.ts thinkingRequest 对齐） ────
function thinkingFields(level, format) {
	if (level === "off") return {};
	if (format === "deepseek") return { thinking: { type: "enabled" }, reasoning_effort: level };
	if (format === "qwen") return { enable_thinking: true };
	return { reasoning_effort: level };
}

// ── 单轮测量 ────────────────────────────────────────────────────────────────
async function measureOnce(index) {
	const body = {
		model: provider.model,
		messages: [{ role: "user", content: userContent }],
		stream: true,
		stream_options: { include_usage: true },
		...thinkingFields(thinking, thinkingFormat),
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 120_000);
	const startedAt = Date.now();
	let firstDeltaAt = 0;
	let lastDeltaAt = 0;
	let usage = undefined;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
		}
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of response.body) {
			// fetch 流的 chunk 是 Uint8Array，TypedArray.toString() 是逗号字节码——必须走 TextDecoder。
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const data = line.startsWith("data:") ? line.slice(5).trim() : "";
				if (!data || data === "[DONE]") continue;
				let parsed;
				try {
					parsed = JSON.parse(data);
				} catch {
					continue;
				}
				const delta = parsed.choices?.[0]?.delta;
				const hasContent =
					typeof delta?.content === "string" && delta.content.length > 0
						? true
						: typeof (delta?.reasoning_content ?? delta?.thinking) === "string" &&
							(delta?.reasoning_content ?? delta?.thinking).length > 0;
				if (hasContent) {
					const now = Date.now();
					if (firstDeltaAt === 0) firstDeltaAt = now;
					lastDeltaAt = now;
				}
				if (parsed.usage) usage = parsed.usage;
			}
		}
	} finally {
		clearTimeout(timer);
	}

	if (firstDeltaAt === 0 || !usage) {
		throw new Error("没有收到内容增量或 usage，无法计量");
	}
	const decodeMs = lastDeltaAt - firstDeltaAt;
	const tokens = usage.completion_tokens ?? 0;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
	const tps = decodeMs > 0 ? (tokens / decodeMs) * 1000 : 0;
	return { index, ttftMs: firstDeltaAt - startedAt, decodeMs, tokens, reasoning, tps };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log(
	`provider=${providerName} model=${provider.model} thinking=${thinking} rounds=${rounds} ctx-chars=${ctxChars}`,
);
console.log(`prompt: ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}\n`);

const results = [];
for (let i = 1; i <= rounds; i += 1) {
	try {
		const r = await measureOnce(i);
		results.push(r);
		const reasoningNote = r.reasoning > 0 ? `，其中思考 ${r.reasoning}` : "";
		console.log(
			`[${i}/${rounds}] 首包 ${(r.ttftMs / 1000).toFixed(2)}s · 解码 ${(r.decodeMs / 1000).toFixed(2)}s · ` +
				`${r.tokens} tok${reasoningNote} → ${r.tps.toFixed(1)} tok/s`,
		);
	} catch (error) {
		console.error(`[${i}/${rounds}] 失败：${error.message}`);
	}
}

if (results.length === 0) {
	console.error("\n全部轮次失败，无结论。");
	process.exit(1);
}
const sorted = results.map((r) => r.tps).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(
	`\n解码速率：中位 ${median.toFixed(1)} · 最小 ${sorted[0].toFixed(1)} · 最大 ${sorted[sorted.length - 1].toFixed(1)} tok/s` +
		`（${results.length}/${rounds} 轮有效）`,
);
console.log("口径提示：关闭思考时测的是纯正文解码速率；开思考时混合了 reasoning 段（其速率通常更低）。");
