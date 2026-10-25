import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { selfProcessIdentity, acquireOwnership } from "../../../.uina/worlds/minecraft/executor/platform/index.ts";

const mode = process.argv[2];
const children = [];
let ownership;
let externalJob;
if (mode === "probe") {
	try {
		const platform = await import(pathToFileURL(process.argv[3]));
		platform.selfProcessIdentity();
		process.send({ loaded: true });
	} catch (error) {
		process.send({ code: error.code, cause: error.cause?.code });
	}
} else if (mode === "claim") {
	try {
		ownership = acquireOwnership(process.argv[3], process.argv[4]);
		process.send({ acquired: true });
	} catch (error) {
		process.send({ acquired: false, code: error.code });
	}
} else if (mode === "external") {
	externalJob = createRequire(import.meta.url)(process.argv[3]).external();
	const child = fork(new URL(import.meta.url), ["tree"], {
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	children.push(child);
	child.once("message", (hello) => process.send(hello));
} else if (mode === "owner") {
	ownership = acquireOwnership(process.argv[3], process.argv[4]);
	const child = fork(new URL(import.meta.url), ["tree"], {
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	children.push(child);
	child.once("message", (hello) => {
		const managed = ownership.openProcess(child.pid);
		if (managed.identity.createdAt !== hello.identity.createdAt) throw new Error("identity mismatch");
		ownership.assign(managed);
		child.once("message", (tree) =>
			process.send({ identity: selfProcessIdentity(), tree: [hello.identity, ...tree.tree] }),
		);
		child.send("tree");
	});
} else {
	process.send({ identity: selfProcessIdentity() });
}
process.on("message", (message) => {
	if (message?.op === "breakaway") {
		process.send({ error: createRequire(import.meta.url)(message.helper).breakaway() });
	}
	if (message === "exit") process.exit(0);
	if (message === "tree") {
		const child = fork(new URL(import.meta.url), ["leaf"], {
			execArgv: [],
			detached: true,
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.push(child);
		child.once("message", (hello) => process.send({ tree: [hello.identity] }));
	}
});
setInterval(() => {
	void ownership;
	void externalJob;
}, 1000);
