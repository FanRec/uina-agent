#!/usr/bin/env node
import { runApp } from "./cli/app.js";
import { errorMessage } from "./core/errors.js";

void runApp(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`[启动失败] ${errorMessage(error)}\n`);
	process.exitCode = 1;
});
