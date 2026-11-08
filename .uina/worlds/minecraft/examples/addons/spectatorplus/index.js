/**
 * SpectatorPlus integration addon (api 1)。
 *
 * 事实边界（docs/proposals/mc/addons.md §5）：
 * - SpectatorPlus 的 HUD/GUI/附身界面由**真实 Java 客户端 Mod**渲染，Bot 不需要也无法
 *   伪造那部分；Bot 侧真正需要的是服务器侧 `/spectate` 与游戏模式观察。
 * - 因此本包**不发明**任何 spectatorplus 私有通道：只用既有 chat@1 组合命令，
 *   再用 world@1 的 gameMode 回读证明状态真的变了。
 * - 没有服务端插件时 `/spectate` 会失败，动作如实报 EFFECT_UNCONFIRMED，不假装成功。
 */

const ADDON_ID = "spectatorplus";
const MODE_REF = "spectatorplus.mode@1";
const SPECTATE_REF = "spectatorplus.spectate@1";

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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readGameMode(world) {
	const observation = await world.read({ ref: "world@1", input: {} });
	const value = observation && observation.value;
	return value != null && typeof value.gameMode === "string" ? value.gameMode : null;
}

export const api = 1;
export const id = ADDON_ID;

export function create(ctx) {
	const logger = ctx.logger;
	const config = ctx.config != null && typeof ctx.config === "object" ? ctx.config : {};
	const verifyTimeoutMs = Number(config.verifyTimeoutMs) > 0 ? Number(config.verifyTimeoutMs) : 2500;
	logger.info("created", { minecraftVersion: ctx.minecraftVersion });

	return {
		queries: [
			{
				descriptor: {
					ref: MODE_REF,
					summary: "Current client game mode as observed by the driver (survival/creative/spectator/...)",
					input: { type: "object", properties: {}, additionalProperties: false },
					output: { type: "object" },
					access: "read",
					watchable: true,
					feedback: false,
					facts: ["world"],
					tags: ["addon", ADDON_ID, "observer"],
					examples: [{ input: {}, output: { value: { gameMode: "spectator" } } }],
				},
				reader: {
					kind: "current",
					cursor: "observed",
					read: (view) => {
						const fact = view.world();
						return {
							...fact,
							value: { gameMode: fact.value.gameMode },
						};
					},
				},
			},
		],

		actions: [
			{
				descriptor: {
					ref: SPECTATE_REF,
					summary: "Spectate a player through the server /spectate command and verify the client entered spectator mode",
					input: {
						type: "object",
						properties: {
							target: { type: "string", minLength: 1, maxLength: 16 },
						},
						required: ["target"],
						additionalProperties: false,
					},
					output: {
						type: "object",
						properties: { gameMode: { const: "spectator" }, target: { type: "string" } },
						required: ["gameMode", "target"],
						additionalProperties: false,
					},
					access: "act",
					completion: {
						scope: "capability",
						description: "the driver observes gameMode=spectator after the command; the command receipt alone is not success",
					},
					errors: [
						{ code: "EFFECT_UNCONFIRMED", meaning: "command was sent but the game mode did not change" },
						{ code: "INVALID_INPUT", meaning: "target is not a plausible player name" },
					],
					requires: ["connection"],
					examples: [{ input: { target: "Steve" }, output: { gameMode: "spectator", target: "Steve" } }],
					implementation: "native",
				},
				invoke: async (callCtx, input) => {
					const target = input && typeof input.target === "string" ? input.target.trim() : "";
					if (!/^[A-Za-z0-9_]{1,16}$/.test(target))
						throw failure("INVALID_INPUT", `invalid player name ${JSON.stringify(target)}`, "not_sent");
					await callCtx.call("chat@1", { text: `/spectate ${target}` });
					const deadline = Date.now() + verifyTimeoutMs;
					let last = await readGameMode(callCtx.world);
					while (Date.now() < deadline) {
						await sleep(120);
						last = await readGameMode(callCtx.world);
						if (last === "spectator") return { gameMode: "spectator", target };
					}
					throw failure(
						"EFFECT_UNCONFIRMED",
						`/spectate ${target} was sent but gameMode stayed ${JSON.stringify(last)}; the server may lack SpectatorPlus or the permission`,
						"sent",
					);
				},
			},
		],

		close() {
			logger.info("closed");
		},
	};
}

export default { api, id, create };
