if (import.meta.url.endsWith(".ts")) {
	const { register } = await import("tsx/esm/api");
	register();
}
const file = import.meta.url.endsWith(".js") ? "./runtime-db-worker.js" : "./runtime-db-worker.ts";
await import(new URL(file, import.meta.url).href);
export {};
