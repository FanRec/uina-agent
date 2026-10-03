/** MCP 测试共享夹具：内存版 JSON-RPC responder，配合 InMemoryTransport.createLinkedPair()
 * 为 server-manager / proxy-tool 协议测试充当最小 MCP server（initialize/tools/list/tools/call）。 */
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/client";

export interface HeldCall {
	/** 请求到达该方法时 resolve。 */
	whenCalled: Promise<void>;
	/** 放行默认响应。 */
	release: () => void;
}

export class FakeMcpServer {
	readonly clientTransport: InMemoryTransport;
	tools: Array<Record<string, unknown>> = [];
	instructions: string | undefined;
	callResult: Record<string, unknown> = { content: [{ type: "text", text: "ok" }] };
	/** 非 undefined 时 tools/list 返回该 JSON-RPC error。 */
	listError: { code: number; message: string } | undefined;
	listChanged = false;
	listPages: Array<Array<Record<string, unknown>>> | undefined;
	/** 非 undefined 时 tools/call 返回该 JSON-RPC error。 */
	callError: { code: number; message: string } | undefined;

	private readonly serverTransport: InMemoryTransport;
	private readonly gates = new Map<string, { gate: Promise<void>; release: () => void; arrive: () => void }>();

	constructor() {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		this.clientTransport = clientTransport;
		this.serverTransport = serverTransport;
		serverTransport.onmessage = (message) => {
			void this.handle(message);
		};
	}

	hold(method: string): HeldCall {
		let release!: () => void;
		let arrive!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const whenCalled = new Promise<void>((resolveArrive) => {
			arrive = resolveArrive;
		});
		this.gates.set(method, { gate, release, arrive });
		return { whenCalled, release };
	}

	private async handle(message: JSONRPCMessage): Promise<void> {
		const request = message as { id?: unknown; method?: string; params?: Record<string, unknown> };
		if (request.id === undefined || request.id === null || typeof request.method !== "string") return;
		const id = request.id;
		const respond = (result: unknown): void => {
			void this.serverTransport.send({ jsonrpc: "2.0", id, result } as unknown as JSONRPCMessage);
		};
		const respondError = (error: { code: number; message: string }): void => {
			void this.serverTransport.send({ jsonrpc: "2.0", id, error } as unknown as JSONRPCMessage);
		};
		const gate = this.gates.get(request.method);
		if (gate) {
			gate.arrive();
			await gate.gate;
		}
		switch (request.method) {
			case "initialize": {
				const protocolVersion =
					typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18";
				respond({
					protocolVersion,
					capabilities: { tools: { listChanged: this.listChanged } },
					serverInfo: { name: "fake-mcp", version: "0.0.1" },
					...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
				});
				return;
			}
			case "tools/list": {
				if (this.listError) {
					respondError(this.listError);
					return;
				}
				if (this.listPages) {
					const page = typeof request.params?.cursor === "string" ? Number(request.params.cursor) : 0;
					respond({
						tools: this.listPages[page] ?? [],
						...(this.listPages[page + 1] ? { nextCursor: String(page + 1) } : {}),
					});
				} else {
					respond({ tools: this.tools });
				}
				return;
			}
			case "tools/call": {
				if (this.callError) {
					respondError(this.callError);
					return;
				}
				respond(this.callResult);
				return;
			}
			case "ping": {
				respond({});
				return;
			}
			default:
				respondError({ code: -32601, message: `method not found: ${request.method}` });
		}
	}

	async emitToolsChanged(tools: Array<Record<string, unknown>>): Promise<void> {
		this.tools = tools;
		await this.serverTransport.send({
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: {},
		} as unknown as JSONRPCMessage);
	}
}
