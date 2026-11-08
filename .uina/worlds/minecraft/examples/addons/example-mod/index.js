/**
 * Example Uina Minecraft addon (api 1).
 *
 * 这个包演示一条完整的非原版闭环，且不需要改内置 Minecraft World 源码：
 *   自定义通道 Payload（attach 订阅 / body scope 写入）
 *     -> 连接级模组事实（publishFact）
 *     -> current 查询（example.machine@1）
 *     -> 动作（example.press@1）在 Runtime 授权的 BodyScope 内发送并回读验证。
 *
 * 纯 ESM JavaScript，无运行时依赖：Companion 直接 import 本文件。
 * 失败结算契约（与 addons/sdk.ts 一致）：抛出 name="CallFailure" 且带字符串 code
 * 的错误时，Runtime 按 dispatch/effects/recoverable 原样结算。
 */

const ADDON_ID = "example-mod";
const CHANNEL = "uina:example";

const MACHINE_REF = "example.machine@1";
const RECIPES_REF = "example.recipes@1";
const PRESS_REF = "example.press@1";

/** 包内静态工艺知识：不是原版 3×3 合成，因此不进 recipe@1，只由本包的查询暴露。 */
const RECIPES = [
	{
		machine: "example:press",
		inputs: [{ item: "minecraft:iron_ingot", count: 2 }],
		output: { item: "example:uina_token", count: 1 },
	},
];

function failure(code, message, dispatch) {
	const error = new Error(message);
	error.name = "CallFailure";
	error.code = code;
	error.source = "capability";
	error.dispatch = dispatch;
	error.effects = [];
	error.recoverable = false;
	return error;
}

function decode(data) {
	try {
		const text = Buffer.from(data).toString("utf8");
		const value = JSON.parse(text);
		return value != null && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读本包发布的连接级事实；未发布时 null（不猜机器状态）。
 * 一并带回观察证据 ref——确认派发时要用它，不能拿"我看到过"当证据。
 */
async function readMachine(world) {
	const observation = await world.read({ ref: MACHINE_REF, input: {} });
	const value = observation && observation.value;
	if (value == null || typeof value.counter !== "number") return null;
	const evidence = observation && Array.isArray(observation.evidence) ? observation.evidence : [];
	return { value, evidence };
}

/**
 * 在期限内等一个已知基线。没有基线就没有"计数器前进了 times"可判，
 * 不能拿第一次回读当成功。
 */
async function waitForMachine(world, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const known = await readMachine(world);
		if (known != null) return known;
		if (Date.now() >= deadline) return null;
		await sleep(120);
	}
}

export const api = 1;
export const id = ADDON_ID;

export function create(ctx) {
	const logger = ctx.logger;
	const config = ctx.config != null && typeof ctx.config === "object" ? ctx.config : {};
	const verifyTimeoutMs = Number(config.verifyTimeoutMs) > 0 ? Number(config.verifyTimeoutMs) : 3000;
	logger.info("created", { minecraftVersion: ctx.minecraftVersion, verifyTimeoutMs });

	return {
		client: {
			attach(port) {
				// 只读订阅：服务器在本通道回送的权威状态。
				port.onCustomPayload(CHANNEL, (data) => {
					const message = decode(data);
					if (message == null || message.op !== "state") return;
					const counter = typeof message.counter === "number" ? message.counter : null;
					port.publishFact(
						"machine",
						{
							counter,
							item: typeof message.item === "string" ? message.item : null,
							serverTime: typeof message.serverTime === "string" ? message.serverTime : null,
						},
						{
							// 服务器回送的权威状态，本连接内换代后仍有效。
							scope: "connection",
							source: "server",
							unknown: counter == null ? ["server did not report a numeric counter"] : [],
						},
					);
				});
				// 重生/换维度后旧状态不再可信：显式清成未知，等下一次回读。
				// 这不是服务端观测，按原始证据标 derived。
				port.onEvent("spawn", () => {
					port.publishFact(
						"machine",
						{ counter: null, item: null, serverTime: null },
						{
							scope: "connection",
							source: "derived",
							unknown: ["no machine state received on this incarnation yet"],
						},
					);
				});
				logger.info("attached", { connection: port.connection, version: port.version });
			},
		},

		queries: [
			{
				descriptor: {
					ref: MACHINE_REF,
					summary: "Server-authoritative state of the example mod machine (counter and last granted item)",
					input: { type: "object", properties: {}, additionalProperties: false },
					output: { type: "object" },
					access: "read",
					watchable: true,
					feedback: false,
					facts: ["addon"],
					tags: ["addon", ADDON_ID, "machine"],
					examples: [{ input: {}, output: { value: { counter: 1, item: "example:uina_token", serverTime: null } } }],
				},
				reader: {
					kind: "current",
					cursor: "observed",
					read: (view) => {
						const fact = view.addonFact(ADDON_ID, "machine");
						if (fact != null) return fact;
						return {
							value: { counter: null, item: null, serverTime: null },
							observedAt: new Date().toISOString(),
							source: "server",
							coverage: "partial",
							unknown: ["no machine state has been received on this connection"],
							evidence: [],
						};
					},
				},
			},
			{
				descriptor: {
					ref: RECIPES_REF,
					summary: "Static machine recipes declared by the example-mod package (not vanilla crafting or smelting)",
					input: {
						type: "object",
						properties: { machine: { type: "string", minLength: 1 } },
						additionalProperties: false,
					},
					output: { type: "object" },
					access: "read",
					watchable: false,
					feedback: false,
					tags: ["addon", ADDON_ID, "knowledge"],
					examples: [{ input: {}, output: { value: { recipes: RECIPES } } }],
				},
				reader: {
					kind: "static",
					read: (input) => {
						const machine = input && typeof input.machine === "string" ? input.machine : null;
						const recipes = machine == null ? RECIPES : RECIPES.filter((recipe) => recipe.machine === machine);
						return {
							value: { recipes, machine },
							observedAt: new Date().toISOString(),
							source: "derived",
							coverage: "complete",
							unknown: [
								"package-declared recipe; station semantics are not vanilla crafting and are not executable through craft@1",
							],
							evidence: [],
						};
					},
				},
			},
		],

		actions: [
			{
				descriptor: {
					ref: PRESS_REF,
					summary: "Press the example mod machine through the custom channel and verify the server counter advanced",
					input: {
						type: "object",
						properties: { times: { type: "integer", minimum: 1, maximum: 10 } },
						additionalProperties: false,
					},
					output: {
						type: "object",
						properties: { counter: { type: "integer" }, verified: { const: true } },
						required: ["counter", "verified"],
						additionalProperties: false,
					},
					access: "act",
					completion: {
						scope: "capability",
						description:
							"the server reported a counter at least `times` higher than before; the payload alone is not success",
					},
					errors: [
						{ code: "BODY_REQUIRED", meaning: "protocol write is only available inside an authorized body scope" },
						{
							code: "EFFECT_UNCONFIRMED",
							meaning:
								"no verifiable baseline was observed, or the payload was sent but the server counter did not advance",
						},
						{ code: "DISCONNECTED", meaning: "the client connection is gone" },
					],
					requires: ["connection", "body"],
					examples: [{ input: { times: 1 }, output: { counter: 1, verified: true } }],
					implementation: "native",
				},
				invoke: async (callCtx, input) => {
					const requested = input && typeof input.times === "number" ? input.times : 1;
					const times = Math.max(1, Math.min(10, Math.trunc(requested)));
					return await callCtx.withBody(async (scope) => {
						if (scope.protocol == null)
							throw failure("BODY_REQUIRED", "protocol write requires an authorized body scope", "not_sent");
						// 没有基线就没有"计数器前进了 times"可判。先看已发布事实，未知就向服务端
						// 要一次状态；仍然拿不到就如实失败，不拿第一次回读冒充成功。
						let before = await readMachine(scope.world);
						if (before == null) {
							const stateEffect = scope.protocol.send(CHANNEL, JSON.stringify({ op: "state" }));
							before = await waitForMachine(scope.world, verifyTimeoutMs);
							if (before == null)
								throw failure(
									"EFFECT_UNCONFIRMED",
									`no server counter baseline within ${verifyTimeoutMs}ms after a state request`,
									"sent",
								);
							// 状态请求本身也有服务端回读作证据，可以结算成 met。
							scope.protocol.confirm(stateEffect, before.evidence);
						}
						const pressEffect = scope.protocol.send(CHANNEL, JSON.stringify({ op: "press", times }));
						const deadline = Date.now() + verifyTimeoutMs;
						let last = before.value.counter;
						while (Date.now() < deadline) {
							await sleep(120);
							const now = await readMachine(scope.world);
							if (now == null) continue;
							last = now.value.counter;
							if (now.value.counter >= before.value.counter + times) {
								// 服务端回的 counter 前进就是这次派发的业务 ACK：用它把效果结算成 met。
								scope.protocol.confirm(pressEffect, now.evidence);
								return { counter: now.value.counter, verified: true };
							}
						}
						throw failure(
							"EFFECT_UNCONFIRMED",
							`press payload was sent but the server counter did not advance by ${times} within ${verifyTimeoutMs}ms (last known ${last})`,
							"sent",
						);
					});
				},
			},
		],

		knowledge: {
			items: [{ name: "example:uina_token", displayName: "Uina Token", stackSize: 64, placeAs: null }],
		},

		close() {
			logger.info("closed");
		},
	};
}

export default { api, id, create };
