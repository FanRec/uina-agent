import type { ExtensionAPI } from "../runner.js";
import { WorldRegistry } from "./world-registry.js";
import type { WorldDef } from "./types.js";

export * from "./types.js";
export * from "./world-tool.js";
export * from "./world-activation.js";
export * from "./world-registry.js";
export * from "./result.js";

// 单例/共享注册表映射（按 ExtensionAPI 隔离）
const REGISTRIES = new WeakMap<ExtensionAPI, WorldRegistry>();

/**
 * 获取或创建给定 ExtensionAPI 绑定的 WorldRegistry
 */
export function getWorldRegistry(pi: ExtensionAPI): WorldRegistry {
	let registry = REGISTRIES.get(pi);
	if (!registry) {
		registry = new WorldRegistry(pi);
		REGISTRIES.set(pi, registry);
	}
	return registry;
}

/**
 * 开发者使用的顶层 World 声明函数
 * @param pi ExtensionAPI 上下文
 * @param world 世界契约定义
 * @returns 注销函数
 */
export async function defineWorld(pi: ExtensionAPI, world: WorldDef): Promise<() => Promise<void>> {
	const registry = getWorldRegistry(pi);
	const unregister = await registry.register(world);
	return unregister;
}

import { createWorldStoreWorld } from "./builtins/world-store.js";
import { loadExternalWorlds } from "./world-loader.js";
import { WORLD_EXPOSED_SHARED_NAME } from "./types.js";

export * from "./builtins/world-store.js";
export * from "./world-loader.js";

/**
 * 官方内置扩展激活入口
 *
 * 生命周期收拢：不再自持 fire-and-forget 的中止监听。activation 返回的 teardown
 * 由统一 ResourceScope 接管取消、等待和资源释放。
 */
export async function activateWorldFramework(pi: ExtensionAPI): Promise<() => Promise<void>> {
	const registry = getWorldRegistry(pi);
	// 向宿主同进程共享表登记"世界暴露表"：世界用 ctx.expose 写入，系统扩展用
	// pi.shared(WORLD_EXPOSED_SHARED_NAME) 读取。这是 World 与 Extension 之间唯一的
	// 活引用通道——callService 双向 structuredClone，承载不了带原型方法的对象。
	pi.share(WORLD_EXPOSED_SHARED_NAME, registry.exposedRegistry());
	await registry.register(createWorldStoreWorld(registry));
	const teardownWorlds = await loadExternalWorlds(pi, registry);
	// teardown：统一回收 registry 内全部世界，再摘除外置世界。
	return async () => {
		await registry.disposeAll();
		await teardownWorlds();
	};
}
