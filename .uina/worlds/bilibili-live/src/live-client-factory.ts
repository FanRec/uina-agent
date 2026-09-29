import { BilibiliLiveClient } from "./blivedm-ts/client.js";
import { OpenLiveClient } from "./blivedm-ts/open-live.js";
import type { ResolvedLiveWorldConfig } from "./config.js";
import type { LiveClientAdapter } from "./live-client-adapter.js";

export function createLiveClient(config: ResolvedLiveWorldConfig, roomId: number): LiveClientAdapter {
	if (config.openPlatform) {
		return new OpenLiveClient({
			accessKeyId: config.openPlatform.accessKeyId,
			accessKeySecret: config.openPlatform.accessKeySecret,
			appId: config.openPlatform.appId,
			roomOwnerAuthCode: config.openPlatform.code,
			autoReconnect: config.network.autoReconnect,
		});
	}
	return new BilibiliLiveClient({ roomId, sessdata: config.sessdata, buvid: config.buvid3, autoReconnect: config.network.autoReconnect });
}
