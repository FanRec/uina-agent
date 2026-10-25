/** Fixed Mineflayer wire seam. No acceptClick, native click queue or deferred activation. */
import { createRequire } from "node:module";
import type { WindowItemValue } from "../../contracts/body.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { toMineflayerVec3, type MineflayerBot } from "./adapter.js";

const require = createRequire(import.meta.url);
const mineflayerRequire = createRequire(require.resolve("mineflayer"));

export type NativeWindow = NonNullable<MineflayerBot["currentWindow"]>;
interface NativeItem {
	name: string;
	count: number;
	stackSize?: number;
	components?: unknown;
	removedComponents?: unknown;
	nbt?: unknown;
	maxDurability?: number;
	durabilityUsed?: number | null;
}
interface ItemCodec {
	fromNotch(value: unknown): NativeItem | null;
	toNotch(value: unknown): unknown;
}

/** Components can contain bigint NBT values. Preserve them as decimal strings in pure JSON. */
function json(value: unknown): JsonValue {
	return JSON.parse(
		JSON.stringify(value, (_key, part) => (typeof part === "bigint" ? part.toString() : part)),
	) as JsonValue;
}

export class WindowWire {
	private readonly item: ItemCodec;
	private readonly hashed: boolean;
	constructor(private readonly bot: MineflayerBot) {
		this.item = mineflayerRequire("prismarine-item")(bot.registry) as ItemCodec;
		this.hashed = bot.registry.version[">="]("1.21.5");
	}

	decode(raw: unknown): JsonValue | null {
		const item = this.item.fromNotch(raw);
		if (item == null) return null;
		let durability: number | null = null;
		if (typeof item.maxDurability === "number") {
			const used = item.durabilityUsed;
			if (typeof used === "number") durability = item.maxDurability - used;
		}
		const value: WindowItemValue = {
			name: item.name,
			count: item.count,
			stackSize: typeof item.stackSize === "number" ? item.stackSize : null,
			components:
				item.components === undefined
					? item.nbt == null
						? null
						: json(item.nbt)
					: json({ added: item.components, removed: item.removedComponents ?? [] }),
			durability,
		};
		return json(value);
	}

	/** Mineflayer 4.39 lacks a set_cursor_item listener on 1.21.11. Repair only this bound native window. */
	setCursor(window: NativeWindow, raw: unknown): void {
		window.selectedItem = this.item.fromNotch(raw) as NativeWindow["selectedItem"];
	}

	/** Keep native closeWindow/copyInventory from restoring stale player slots after a server update. */
	setSlot(window: NativeWindow, slot: number, raw: unknown): void {
		// Upstream's declaration omits null although updateSlot explicitly supports empty slots.
		window.updateSlot(slot, this.item.fromNotch(raw) as Parameters<NativeWindow["updateSlot"]>[1]);
	}

	click(window: NativeWindow, slot: number, button: number): void {
		this.bot._client.write("window_click", {
			windowId: window.id,
			// Paper applies the click, then full-syncs the mismatched state. Exactly one response per request.
			stateId: -1,
			slot,
			mouseButton: button,
			mode: 0,
			changedSlots: [],
			// A null hashed cursor asserts no client prediction. A mismatch only requests a full sync.
			// Computing component hashes would duplicate the server's item implementation.
			cursorItem: this.hashed ? null : this.item.toNotch(window.selectedItem),
		});
	}
}

/** Same modern activation payload as inventory.js, with its pending look removed. */
export function activateContainerBlock(bot: MineflayerBot, position: Vec3): void {
	bot._client.write("block_place", {
		location: toMineflayerVec3(position),
		direction: 1,
		hand: 0,
		cursorX: 0.5,
		cursorY: 0.5,
		cursorZ: 0.5,
		insideBlock: false,
		sequence: 0,
		worldBorderHit: false,
	});
	bot.swingArm("right");
}

export function activateContainerEntity(bot: MineflayerBot, networkId: number): void {
	bot._client.write("use_entity", {
		target: networkId,
		mouse: 0,
		sneaking: false,
		hand: 0,
		location: toMineflayerVec3({ x: 0, y: 0, z: 0 }),
	});
}
