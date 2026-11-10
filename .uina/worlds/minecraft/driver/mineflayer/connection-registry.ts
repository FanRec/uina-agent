import type { ConnectionRegistry } from "../../contracts/protocol.js";
import type { MineflayerBot } from "./adapter.js";

const customName = /^(?!minecraft:)[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const idValid = (id: number): boolean => Number.isSafeInteger(id) && id >= 0;

export function installConnectionRegistry(bot: MineflayerBot, evidence: ConnectionRegistry): void {
	const registry = bot.registry;
	const items = { ...registry.items };
	const itemsByName = { ...registry.itemsByName };
	const itemsArray = [...registry.itemsArray];
	const blocks = { ...registry.blocks };
	const blocksByName = { ...registry.blocksByName };
	const blocksArray = [...registry.blocksArray];
	const blocksByStateId = { ...registry.blocksByStateId };
	const collisionShapes = { ...registry.blockCollisionShapes, blocks: { ...registry.blockCollisionShapes.blocks } };
	for (const { name, id } of evidence.items) {
		if (!customName.test(name) || !idValid(id) || items[id] || itemsByName[name])
			throw new Error(`invalid or conflicting item registry entry ${name}=${id}`);
		const item = { name, id, displayName: name, stackSize: 64 };
		items[id] = itemsByName[name] = item;
		itemsArray.push(item);
	}
	for (const { name, id, stateId, hardness } of evidence.solidBlocks) {
		if (
			!customName.test(name) ||
			!idValid(id) ||
			!idValid(stateId) ||
			!Number.isFinite(hardness) ||
			blocks[id] ||
			blocksByName[name] ||
			blocksByStateId[stateId]
		)
			throw new Error(`invalid or conflicting block registry entry ${name}=${id}/${stateId}`);
		const block = {
			name,
			id,
			displayName: name,
			hardness,
			stackSize: itemsByName[name]?.stackSize ?? 64,
			diggable: hardness >= 0,
			boundingBox: "block" as const,
			transparent: false,
			emitLight: 0,
			filterLight: 15,
			drops: [],
			minStateId: stateId,
			maxStateId: stateId,
			defaultState: stateId,
			states: [],
			shapes: [[0, 0, 0, 1, 1, 1]],
		};
		blocks[id] = blocksByName[name] = blocksByStateId[stateId] = block;
		blocksArray.push(block);
		collisionShapes.blocks[name] = collisionShapes.blocks.stone!;
	}
	for (const [kind, ids] of Object.entries(evidence.synchronizedIds)) {
		const entries = kind === "minecraft:item" ? itemsByName : kind === "minecraft:block" ? blocksByName : null;
		if (!entries) throw new Error(`unsupported synchronized registry ${kind}`);
		for (const [name, id] of Object.entries(ids)) {
			const localName = name.startsWith("minecraft:") ? name.slice("minecraft:".length) : name;
			if (entries[localName]?.id !== id) throw new Error(`unsupported registry mapping ${kind}:${name}=${id}`);
		}
	}
	for (const [kind, entries] of [
		["minecraft:item", evidence.items],
		["minecraft:block", evidence.solidBlocks],
	] as const) {
		for (const entry of entries)
			if (evidence.synchronizedIds[kind]?.[entry.name] !== entry.id)
				throw new Error(`missing registry mapping ${kind}:${entry.name}`);
	}
	Object.assign(registry, {
		items,
		itemsByName,
		itemsArray,
		blocks,
		blocksByName,
		blocksArray,
		blocksByStateId,
		blockCollisionShapes: collisionShapes,
	});
}
