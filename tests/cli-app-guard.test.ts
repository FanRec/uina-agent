// CRAP C4：runApp guard 路径钉住——help/version 早期返回与 profile 解析失败。
// runApp 是组合根，完整启动链路属真机/进程级测试范畴；此处覆盖它仅有的
// 三条无副作用早退路径（readPipedStdin 予以桩定以脱离 stdin 依赖）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { runApp } from "../src/cli/app.js";
import { UINA_VERSION } from "../src/cli/args.js";

vi.mock("../src/cli/args.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cli/args.js")>();
	return { ...actual, readPipedStdin: async () => undefined };
});

const captureStream = (stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } => {
	const lines: string[] = [];
	vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	}) as typeof stream.write);
	return { lines, restore: () => vi.restoreAllMocks() };
};

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("runApp：无副作用早退路径", () => {
	it("--help 打印帮助文本后直接返回，不装配宿主", async () => {
		const out = captureStream(process.stdout);
		await runApp(["--help"]);
		expect(out.lines.join("")).toContain("用法");
	});

	it("--version 打印版本号", async () => {
		const out = captureStream(process.stdout);
		await runApp(["--version"]);
		expect(out.lines.join("")).toBe(`v${UINA_VERSION}\n`);
	});

	it("--profile 指向不存在的主体：写启动失败到 stderr 且置退出码 1", async () => {
		const err = captureStream(process.stderr);
		await runApp(["--profile", "crap-probe-absent"]);
		expect(err.lines.join("")).toContain("[启动失败]");
		expect(err.lines.join("")).toContain("profile.json 不存在");
		expect(process.exitCode).toBe(1);
	});
});
