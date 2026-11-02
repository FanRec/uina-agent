/** The same formal Host/World acceptance assembly, selecting the Program scenarios. */
process.argv.push("--program");
const file = import.meta.url.endsWith(".js") ? "./native-host.js" : "./native-host.ts";
await import(new URL(file, import.meta.url).href);

export {};
