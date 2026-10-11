import { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";

/** 旧假体没有协议 ACK；使用真实观察器保留这一未知事实。 */
export function unconfirmedInjections(): Pick<
	VTSClient,
	"observeMotionInjections" | "getModelGeneration" | "getInjectionStats"
> {
	const recorder = new VTSClient({ token: "fixture" });
	return {
		observeMotionInjections: recorder.observeMotionInjections.bind(recorder),
		getModelGeneration: recorder.getModelGeneration.bind(recorder),
		getInjectionStats: recorder.getInjectionStats.bind(recorder),
	};
}
