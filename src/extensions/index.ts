/** Public extension authoring surface. Runtime implementation modules are not part of this contract. */
export type { ExtensionAPI, ExtensionActivation, ExtensionTeardown } from "./runner.js";
export type { CallOptions, ServiceContext, ServiceHandler } from "./services.js";
export type {
	ExtensionUIContext,
	Component,
	ToolRenderer,
	MarkdownTransformer,
	CustomMessage,
	CustomEntry,
	MessageRenderer,
} from "./ui-contract.js";
export type { Model, ModelRequest, Provider, ChatMsg, AgentMessage, ToolResultStatus } from "../core/types.js";
export type { ImageContent } from "../core/content.js";
export type { Tool, ToolExecutionContext, ToolExecutionResult } from "../tools/broker.js";

export type { SessionAccess, RewindRequest, RewindResult, SessionEntry, SessionNodeInfo } from "../session/types.js";
