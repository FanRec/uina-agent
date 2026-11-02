/** Node's native .ts loader does not resolve .js imports to source .ts inside a Worker. */
if (import.meta.url.endsWith(".ts")) {
	const { register } = await import("tsx/esm/api");
	register();
}
const file = import.meta.url.endsWith(".js") ? "./worker.js" : "./worker.ts";
await import(new URL(file, import.meta.url).href);

export {};
