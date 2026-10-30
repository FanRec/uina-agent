/**
 * 浏览器薄面：多前端 v1 的第二个 Surface（SurfaceAdapter 的第一个实现者）。
 *
 * 只做三件事：SyncClient 维持同步（重连即快照）、PresentationController 持有
 * 视图、SurfaceAdapter 把视图接到 DOM 并把意图经 dispatch 发回网关。
 * 纯文本渲染（薄面纪律，无 markdown 管线）；状态条消费未经投影的状态事实旁路。
 */

import type { PresentationIntent } from "../presentation/actions.js";
import { PresentationController } from "../presentation/controller.js";
import type { PresentationNode } from "../presentation/projection.js";
import { sanitizeExternal } from "../presentation/sanitize.js";
import type { SurfaceAdapter, SurfaceCapabilities } from "../presentation/surface.js";
import { SyncClient, type SyncTransport } from "../presentation/sync.js";

// ── DOM 骨架 ──────────────────────────────────────────────────────────
const transcriptEl = require0<HTMLDivElement>("transcript");
const statusEl = require0<HTMLDivElement>("status");
const connEl = require0<HTMLDivElement>("conn");
const inputEl = require0<HTMLTextAreaElement>("input");
const sendBtn = require0<HTMLButtonElement>("send");
const cancelBtn = require0<HTMLButtonElement>("cancel");

function require0<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (el === null) throw new Error(`页面骨架缺少 #${id}`);
	return el as T;
}

// ── 状态（事实旁路维护；视图渲染只读投影节点）─────────────────────────
let modelName = "";
let busy = false;

function readToken(): string {
	const match = /[#&]token=([^&]+)/.exec(location.hash);
	return match?.[1] === undefined ? "" : decodeURIComponent(match[1]);
}

function wsUrl(): string {
	const protocol = location.protocol === "https:" ? "wss" : "ws";
	return `${protocol}://${location.host}/ws`;
}

function openWebSocket(url: string): Promise<SyncTransport> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		let opened = false;
		ws.addEventListener("open", () => {
			opened = true;
			resolve({
				send: (data) => ws.send(data),
				close: () => ws.close(),
				onMessage: (handler) =>
					ws.addEventListener("message", (event) => {
						handler(String(event.data));
					}),
				onClose: (handler) => ws.addEventListener("close", () => handler()),
			});
		});
		ws.addEventListener("error", () => {
			if (!opened) reject(new Error("WebSocket 连接失败"));
		});
		ws.addEventListener("close", () => {
			if (!opened) reject(new Error("WebSocket 已关闭"));
		});
	});
}

// ── 渲染（纯文本，薄面纪律）─────────────────────────────────────────
function nodeElement(node: PresentationNode): HTMLElement {
	if (node.kind === "turn") {
		const el = document.createElement("div");
		el.className = "node turn";
		el.textContent = `❯ ${node.userText}`;
		return el;
	}
	if (node.kind === "thinking") {
		const details = document.createElement("details");
		details.className = `node thinking ${node.status}`;
		const summary = document.createElement("summary");
		summary.textContent = node.status === "running" ? "思考中…" : "思考";
		const body = document.createElement("pre");
		body.textContent = node.text;
		details.append(summary, body);
		return details;
	}
	if (node.kind === "assistant") {
		const el = document.createElement("div");
		el.className = `node assistant ${node.status === "running" ? "streaming" : ""}`;
		el.textContent = node.text;
		return el;
	}
	const el = document.createElement("details");
	el.className = `node tool ${node.status}`;
	const summary = document.createElement("summary");
	const duration = node.durationMs === undefined ? "" : ` · ${(node.durationMs / 1000).toFixed(1)}s`;
	summary.textContent = `${node.name} [${node.status}]${duration}`;
	const body = document.createElement("pre");
	body.textContent = sanitizeExternal(node.result ?? "");
	el.append(summary, body);
	return el;
}

let stickToBottom = true;
transcriptEl.addEventListener("scroll", () => {
	stickToBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
});

function render(): void {
	const view = controller.view();
	transcriptEl.replaceChildren(...view.transcript.map(nodeElement));
	if (stickToBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
	statusEl.textContent = `${modelName || "未知模型"} · ${busy ? "工作中" : "空闲"} · ${client.state === "synced" ? "已连接" : "同步中…"}`;
}

// ── 意图 ─────────────────────────────────────────────────────────────
function submit(): void {
	const text = inputEl.value.trim();
	if (text.length === 0) return;
	const intent: PresentationIntent = { type: "input.submit", text, mode: busy ? "followUp" : "direct" };
	if (client.sendIntent(intent)) {
		inputEl.value = "";
		connEl.hidden = true;
	} else {
		connEl.hidden = false;
		connEl.textContent = "尚未同步（等待连接/快照），消息未发送";
	}
}

sendBtn.addEventListener("click", submit);
inputEl.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		submit();
	}
});
cancelBtn.addEventListener("click", () => {
	client.sendIntent({ type: "turn.cancel" });
});

// ── SurfaceAdapter：本页是它的第一个实现者 ──────────────────────────
const webCapabilities: SurfaceCapabilities = {
	interactive: true,
	richText: false,
	images: false,
	overlays: false,
	pointer: true,
	clipboard: true,
	notifications: false,
};

const webSurface: SurfaceAdapter = {
	id: "web",
	capabilities: webCapabilities,
	attach(attachController) {
		const detach = attachController.subscribe(() => render());
		// 意图出口：Surface 只 dispatch，发送成败由 SyncClient 决定。
		attachController.onIntent((intent) => {
			client.sendIntent(intent);
		});
		render();
		return detach;
	},
};

const controller = new PresentationController();
const scheduler = {
	schedule: (delayMs: number, fn: () => void) => {
		const timer = setTimeout(fn, delayMs);
		return () => clearTimeout(timer);
	},
};

const client = new SyncClient(controller, () => openWebSocket(wsUrl()), {
	auth: readToken(),
	client: "web",
	scheduler,
	onError: (text) => {
		connEl.hidden = false;
		connEl.textContent = text;
	},
	onRecord: (record) => {
		if (record.event.type === "model_select") modelName = record.event.model;
		if (record.event.type === "turn_start") busy = true;
		if (record.event.type === "turn_end" || record.event.type === "turn_aborted" || record.event.type === "error")
			busy = false;
	},
});

webSurface.attach(controller);
client.start();
render();
