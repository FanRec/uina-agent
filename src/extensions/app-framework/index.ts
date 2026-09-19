import type { ExtensionAPI } from "../runner.js";
import { AppRegistry } from "./app-registry.js";
import type { AppDef } from "./types.js";

export * from "./types.js";
export * from "./facade-tool.js";
export * from "./context-viewport.js";
export * from "./app-registry.js";

// 单例/共享注册表映射（按 ExtensionAPI 隔离）
const REGISTRIES = new WeakMap<ExtensionAPI, AppRegistry>();

/**
 * 获取或创建给定 ExtensionAPI 绑定的 AppRegistry
 */
export function getAppRegistry(pi: ExtensionAPI): AppRegistry {
	let registry = REGISTRIES.get(pi);
	if (!registry) {
		registry = new AppRegistry(pi);
		REGISTRIES.set(pi, registry);
	}
	return registry;
}

/**
 * 开发者使用的顶层 App 声明函数
 * @param pi ExtensionAPI 上下文
 * @param app 应用契约定义
 * @returns 注销函数
 */
export async function defineApp(pi: ExtensionAPI, app: AppDef): Promise<() => Promise<void>> {
	const registry = getAppRegistry(pi);
	const unregister = await registry.register(app);
	return unregister;
}


import { createAppStoreApp } from "./builtins/app-store.js";
import { loadExternalApps } from "./app-loader.js";

export * from "./builtins/app-store.js";
export * from "./app-loader.js";

/**
 * 官方内置扩展激活入口
 */
export async function activateAppFramework(pi: ExtensionAPI): Promise<void> {
	const registry = getAppRegistry(pi);
	await registry.register(createAppStoreApp(registry));
	const teardownApps = await loadExternalApps(pi, registry);
	pi.signal.addEventListener("abort", () => {
		void teardownApps();
	});
}

