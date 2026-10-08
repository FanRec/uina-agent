import type { ErrorObject } from "ajv";

type Schema = Record<string, unknown>;
interface Branch {
	schema: Schema;
	path: string;
}
interface Location {
	schemaPath: string;
	instancePath: string;
}

function isObject(value: unknown): value is Schema {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isWithin(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

function choices(schema: unknown): unknown[] | undefined {
	if (!isObject(schema)) return undefined;
	if (Object.hasOwn(schema, "const")) return [schema.const];
	return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function propertyChoices(schema: Schema, key: string): unknown[] | undefined {
	return isObject(schema.properties) ? choices(schema.properties[key]) : undefined;
}

/** Only formats AJV's failure; the compiled full schema remains the validation authority. */
export function formatValidationErrors(schema: unknown, input: unknown, errors: readonly ErrorObject[]): string {
	const excluded: Location[] = [];
	const unions: Location[] = [];
	const selectors: Array<{ instancePath: string; message: string }> = [];

	function visit(node: unknown, value: unknown, schemaPath: string, instancePath: string): void {
		if (!isObject(node)) return;
		for (const keyword of ["oneOf", "anyOf"] as const) {
			const alternatives = node[keyword];
			if (!Array.isArray(alternatives)) continue;
			const unionPath = `${schemaPath}/${keyword}`;
			unions.push({ schemaPath: unionPath, instancePath });
			let branches: Branch[] = alternatives.flatMap((branch, index) =>
				isObject(branch) ? [{ schema: branch, path: `${unionPath}/${index}` }] : [],
			);
			const keys = new Set(
				branches.flatMap(({ schema: branch }) => (isObject(branch.properties) ? Object.keys(branch.properties) : [])),
			);
			if (isObject(value)) {
				for (const key of keys) {
					const values = branches.map(({ schema: branch }) => propertyChoices(branch, key));
					if (!values.length || values.some((allowed) => !allowed)) continue;
					const present = Object.hasOwn(value, key);
					const matching = branches.filter(({ schema: branch }) => {
						if (!present) return !Array.isArray(branch.required) || !branch.required.includes(key);
						return propertyChoices(branch, key)!.some(
							(allowed) => JSON.stringify(allowed) === JSON.stringify(value[key]),
						);
					});
					if (!matching.length) {
						const allowed = [...new Set(values.flatMap((items) => items!.map((item) => JSON.stringify(item))))];
						const path = `${instancePath}/${pointer(key)}`;
						selectors.push({
							instancePath: path,
							message: `${path} ${present ? "must be one of" : "is required; valid values:"} ${allowed.join(", ")}`,
						});
						for (const branch of branches) excluded.push({ schemaPath: branch.path, instancePath });
						branches = [];
						break;
					}
					for (const branch of branches) {
						if (!matching.includes(branch)) excluded.push({ schemaPath: branch.path, instancePath });
					}
					branches = matching;
				}
			}
			for (const branch of branches) visit(branch.schema, value, branch.path, instancePath);
		}
		if (Array.isArray(node.allOf)) {
			for (const [index, branch] of node.allOf.entries())
				visit(branch, value, `${schemaPath}/allOf/${index}`, instancePath);
		}
		if (isObject(node.properties) && isObject(value)) {
			for (const [key, child] of Object.entries(node.properties)) {
				if (Object.hasOwn(value, key))
					visit(child, value[key], `${schemaPath}/properties/${pointer(key)}`, `${instancePath}/${pointer(key)}`);
			}
		}
		if (isObject(node.items) && Array.isArray(value)) {
			for (const [index, item] of value.entries())
				visit(node.items, item, `${schemaPath}/items`, `${instancePath}/${index}`);
		}
	}

	visit(schema, input, "#", "");
	const relevant = errors.filter(
		(error) =>
			!excluded.some(
				(location) =>
					isWithin(error.schemaPath, location.schemaPath) && isWithin(error.instancePath, location.instancePath),
			),
	);
	const leaves = relevant.filter((error) => error.keyword !== "oneOf" && error.keyword !== "anyOf");
	const messages = relevant
		.filter((error) => {
			if (error.keyword !== "oneOf" && error.keyword !== "anyOf") return true;
			const union = unions.find(
				(location) => location.schemaPath === error.schemaPath && location.instancePath === error.instancePath,
			);
			if (!union) return true;
			return (
				!leaves.some(
					(leaf) => isWithin(leaf.schemaPath, union.schemaPath) && isWithin(leaf.instancePath, union.instancePath),
				) && !selectors.some((selector) => isWithin(selector.instancePath, union.instancePath))
			);
		})
		.map((error) => {
			let path = error.instancePath;
			if (error.keyword === "required") path += `/${pointer(String(error.params.missingProperty))}`;
			if (error.keyword === "additionalProperties") path += `/${pointer(String(error.params.additionalProperty))}`;
			const allowed = error.keyword === "const" ? [error.params.allowedValue] : error.params.allowedValues;
			const suffix = Array.isArray(allowed) ? `: ${allowed.map((value) => JSON.stringify(value)).join(", ")}` : "";
			return `${path || "/"} ${error.message ?? error.keyword}${suffix}`;
		});
	return [...new Set([...selectors.map((selector) => selector.message), ...messages])].join("; ") || "参数格式不匹配";
}
