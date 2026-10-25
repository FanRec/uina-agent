/** Narrow dependencies shared by actual Body operations, owned by BodySession. */
import type { Ref } from "../../contracts/values.js";
import type { EffectRecorder } from "../execution.js";
import type { MineflayerBot } from "../mineflayer/adapter.js";
import type { DriverProtocol } from "../mineflayer/protocol.js";

export interface BodyOperationDeps {
	bot: MineflayerBot;
	protocol: DriverProtocol;
	signal: AbortSignal;
	guard(): void;
	canCleanup(): boolean;
	recorder: EffectRecorder;
	mintOp(): Ref;
	mintEff(): Ref;
}
