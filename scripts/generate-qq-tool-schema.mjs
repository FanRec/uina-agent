// 由 docs/proposals/qq-world-tool.json（参数唯一真源）生成 .uina/worlds/qq/src/tool-schema.ts。
// 用法：node scripts/generate-qq-tool-schema.mjs
// ToolDef 与实现 schema 的等价性由 tests/qq-world-contract.test.ts 强制。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const toolDefPath = join(here, "..", "docs", "proposals", "qq-world-tool.json");
const outPath = join(here, "..", ".uina", "worlds", "qq", "src", "tool-schema.ts");

const toolDef = JSON.parse(readFileSync(toolDefPath, "utf8"));
const { name, description, parameters } = toolDef.function;

/** ToolDef 单工具 oneOf → 每动作 { description, parameters } 映射（world-framework 动作字典形状）。 */
const actions = {};
for (const branch of parameters.oneOf) {
	const actionName = branch.properties.action.const;
	if (actions[actionName]) throw new Error(`ToolDef 中动作重复: ${actionName}`);
	actions[actionName] = {
		description: branch.properties.action.description,
		parameters: branch.properties.params,
	};
}

const file = `// 由 docs/proposals/qq-world-tool.json 生成（参数唯一真源），手工修改会被覆盖。
// 重新生成：node scripts/generate-qq-tool-schema.mjs

export const QQ_TOOL_NAME = ${JSON.stringify(name)};

/**
 * 固定认知合同（交互合同 §2 唯一注入面：工具描述只出现一次，不随消息重复）。
 */
export const QQ_TOOL_DESCRIPTION = ${JSON.stringify(description)};

export const QQ_ACTION_SCHEMAS = ${JSON.stringify(actions, null, "\t")} as const;
`;

writeFileSync(outPath, file, "utf8");
console.log(`generated ${outPath} (${Object.keys(actions).length} actions)`);
