import type { BodyEndpoint } from "../../../../src/extensions/world-framework/seams.js";
import { MinecraftExecutor } from "../executor/index.js";

export function createBodyEndpoint(executor: MinecraftExecutor): BodyEndpoint {
	const bodyId = `minecraft:${executor.status().accountKey.slice(0, 16)}`;
	return {
		bodyId,
		bodyType: "humanoid",
		affordance: () => ({
			bodyId,
			bodyType: "humanoid",
			description: "Minecraft player; physical actions continue independently of model turns",
			cues: [],
		}),
		state: () => {
			const s = executor.status();
			return {
				online: s.side?.connection === "ready",
				paused: !s.actionsAllowed,
				...(s.fault ? { fault: s.fault.message } : {}),
			};
		},
		emitCue() {},
		supportsCue: () => false,
		interrupt() {},
		onFocus() {},
		async safeStop() {
			try {
				const receipt = await executor.setOwnerGate("emergency", true);
				if (receipt.persistence !== "confirmed") throw new Error("emergency persistence unconfirmed");
				if (receipt.control !== "stopped") {
					const deadline = Date.now() + 400;
					while (Date.now() < deadline) {
						const next = await executor.setOwnerGate("emergency", true);
						if (next.persistence === "confirmed" && next.control === "stopped") return;
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					await executor.retireControl();
				}
			} catch (error) {
				await executor.retireControl();
				throw error;
			}
		},
		async resume() {
			const current = await executor.inspect(),
				owner = current.side?.owner;
			if (!owner) throw new Error("current owner unavailable");
			const reply = await executor.resumeEmergency({ attachment: owner.attachment, gateRevision: owner.gateRevision });
			if (reply.persistence !== "confirmed") throw new Error("emergency release persistence unconfirmed");
		},
		formatStatus: () => JSON.stringify(executor.status()),
	};
}
