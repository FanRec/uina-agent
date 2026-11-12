/** Public extension authoring surface. Runtime implementation modules are not part of this contract. */
export type { ImageContent } from "../core/content.js";
export type {
	AgentMessage,
	ChatMsg,
	ContextRead,
	ContextSource,
	ContextSourceKind,
	ContextValue,
	Model,
	ModelRequest,
	ModelToolView,
	Provider,
	ToolResultStatus,
} from "../core/types.js";
export type { RewindRequest, RewindResult, SessionAccess, SessionEntry, SessionNodeInfo } from "../session/types.js";
export type { Tool, ToolExecutionContext, ToolExecutionResult } from "../tools/broker.js";
export type { ExtensionActivation, ExtensionAPI, ExtensionTeardown } from "./runner.js";
export type { CallOptions, ServiceContext, ServiceHandler } from "./services.js";
export type {
	BuiltinUIActionRequest,
	Component,
	CustomEntry,
	CustomMessage,
	ExtensionUIContext,
	MarkdownTransformer,
	MessageRenderer,
	ToolRenderer,
} from "./ui-contract.js";
