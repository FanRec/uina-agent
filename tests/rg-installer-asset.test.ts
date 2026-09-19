// 批次 3（ui-crap-debt-plan）：ripgrep 资产名解析矩阵与解压候选路径（纯函数）。
// 这是下载链路中最易藏平台 bug 的决策点，此前随 downloadRgInner 整体 0% 覆盖。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { binaryCandidates, resolveRgAsset } from "../src/extensions/workspace-tools/rg-installer.js";

describe("resolveRgAsset", () => {
	it("win32：x64 与 arm64 → msvc zip", () => {
		expect(resolveRgAsset("win32", "x64")).toBe("ripgrep-14.1.1-x86_64-pc-windows-msvc.zip");
		expect(resolveRgAsset("win32", "arm64")).toBe("ripgrep-14.1.1-aarch64-pc-windows-msvc.zip");
	});

	it("darwin：x64 与 arm64 → apple-darwin tar.gz", () => {
		expect(resolveRgAsset("darwin", "x64")).toBe("ripgrep-14.1.1-x86_64-apple-darwin.tar.gz");
		expect(resolveRgAsset("darwin", "arm64")).toBe("ripgrep-14.1.1-aarch64-apple-darwin.tar.gz");
	});

	it("linux：x64 与 arm64 → musl tar.gz", () => {
		expect(resolveRgAsset("linux", "x64")).toBe("ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz");
		expect(resolveRgAsset("linux", "arm64")).toBe("ripgrep-14.1.1-aarch64-unknown-linux-musl.tar.gz");
	});

	it("不支持的平台抛出带平台信息的错误", () => {
		expect(() => resolveRgAsset("freebsd", "x64")).toThrow("不支持的 freebsd/x64 平台");
	});
});

describe("binaryCandidates", () => {
	it("嵌套目录优先、平铺兜底；zip 与 tar.gz 都能剥出嵌套目录名", () => {
		const [nested, flat] = binaryCandidates(join("tmp", "ex"), "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip", "rg.exe");
		expect(nested).toBe(join("tmp", "ex", "ripgrep-14.1.1-x86_64-pc-windows-msvc", "rg.exe"));
		expect(flat).toBe(join("tmp", "ex", "rg.exe"));

		const [nestedTar] = binaryCandidates(join("tmp", "ex"), "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz", "rg");
		expect(nestedTar).toBe(join("tmp", "ex", "ripgrep-14.1.1-x86_64-unknown-linux-musl", "rg"));
	});
});
