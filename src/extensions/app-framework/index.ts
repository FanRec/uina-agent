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
import { APP_EXPOSED_SHARED_NAME } from "./types.js";

export * from "./builtins/app-store.js";
export * from "./app-loader.js";

/**
 * 官方内置扩展激活入口
 *
 * 生命周期收拢：不再自持 fire-and-forget 的中止监听。activation 返回的 teardown
 * 由现有 Extension ActivationScope 统一接管（abort → await pending → await dispose），
 * 责任唯一、顺序确定。
 */
export async function activateAppFramework(pi: ExtensionAPI): Promise<() => Promise<void>> {
	const registry = getAppRegistry(pi);
	// 向宿主同进程共享表登记"应用暴露表"：应用用 ctx.expose 写入，系统扩展用
	// pi.shared(APP_EXPOSED_SHARED_NAME) 读取。这是 App 与 Extension 之间唯一的
	// 活引用通道——callService 双向 structuredClone，承载不了带原型方法的对象。
	pi.share(APP_EXPOSED_SHARED_NAME, registry.exposedRegistry());
	await registry.register(createAppStoreApp(registry));
	const teardownApps = await loadExternalApps(pi, registry);
	// teardown：统一回收 registry 内全部应用，再摘除外置应用；由 ActivationScope await。
	return async () => {
		await registry.disposeAll();
		await teardownApps();
	};
}

