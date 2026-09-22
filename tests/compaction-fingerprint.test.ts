/**
 * 摘要复用指纹的单元级验证：prefixFingerprint 必须对"被摘要内容"敏感——
 * 同坐标（coveredUpTo）但内容变化即失配，杜绝旧摘要错误复用；内容相同则稳定，
 * 保证正常滚动摘要可复用。
 */
import { describe, expect, test } from "./harness/index.js";
import { fingerprintMessages } from "../src/extensions/compaction/index.js";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

describe("compaction prefixFingerprint", () => {
	test("同前缀两次计算得到同指纹（可复用的前提）", () => {
		const prefix = [user("你好"), assistant("你好，有什么可以帮你")];
		expect(fingerprintMessages(prefix)).toBe(fingerprintMessages(prefix));
	});

	test("same coveredUpTo 但被摘要内容变化 → 指纹不同（不得复用）", () => {
		// 两条前缀长度相同（coveredUpTo 坐标一致），仅替换其中一条内容。
		const original = [user("问题A"), assistant("回答A")];
		const changed = [user("问题A替换"), assistant("回答A")];
		expect(fingerprintMessages(original)).not.toBe(fingerprintMessages(changed));
	});

	test("tool 调用的 name/args 参与指纹", () => {
		const base = [user("q"), { role: "assistant", content: "用工具", tool_calls: [{ name: "read", args: { path: "/a" } }] }];
		const otherArgs = [user("q"), { role: "assistant", content: "用工具", tool_calls: [{ name: "read", args: { path: "/b" } }] }];
		expect(fingerprintMessages(base)).not.toBe(fingerprintMessages(otherArgs));
	});
});