import type { Model, ModelRequest, ModelStreamFn } from "../core/types.js";
export interface CallOptions {
	signal?: AbortSignal;
}
export interface ServiceContext {
	readonly callerId: string;
	readonly signal: AbortSignal;
}
/** A named operation. Use explicit names such as search.query/v1 for incompatible contracts. */
export type ServiceHandler<I = unknown, O = unknown> = (input: I, context: ServiceContext) => O | Promise<O>;
export interface ExtensionModelAccess {
	current(): Model;
	list(): readonly Model[];
	resolve(name: string): Model;
	select(name: string): Promise<void>;
	stream: ModelStreamFn;
}
export type ExtensionModelRequest = Omit<ModelRequest, "providerHooks">;
