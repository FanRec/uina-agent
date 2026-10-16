/**
 * FakeClientBot：Driver 切片（S-D1..S-D3）的替身客户端。
 *
 * 按 mineflayer 7b4bb8d2 的已核实行为建模（physics/digging/inventory 的关键路径），
 * 供 tests/minecraft-driver-*.test.ts 使用。它证明 Driver 逻辑对"形状正确"的客户端成立；
 * 不证明真实服务器行为——真实 Mineflayer 适配与实服验收归 M5。
 *
 * 与真实实现一致的关键点：
 * - physicsTick 只在实际模拟后发出；不可模拟路径（区块未加载/physicsEnabled=false/
 *   实体未就绪）不发出（physics.js L84-96）。
 * - dig 内部 await look 后才"派发"；完成后本地预测目标格为空气（digging.js L121-160）；
 *   stopDigging 取消在途挖掘并 reject。
 * - activateItem 空手是静默 no-op（inventory.js L120-122）。
 * - 库存点击先做本地预测再"发包"（acceptClick 顺序）。
 */

import type {
	BotBlockInfo,
	BotBlockPos,
	BotEntity,
	BotEvents,
	BotItemSelector,
	BotItemStack,
	BotSectionData,
	BotSelfState,
	BotVec3,
	BotWindowData,
	ClientBot,
} from "../internal/bot-shape.js";
import type { Key } from "../../contracts/body.js";

type Listener = (...args: never[]) => void;

class FakeEmitter {
	#listeners = new Map<string, Set<Listener>>();

	on(event: string, listener: Listener): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return () => set!.delete(listener);
	}

	emit(event: string, ...args: unknown[]): void {
		for (const l of [...(this.#listeners.get(event) ?? [])]) {
			(l as (...a: unknown[]) => void)(...args);
		}
	}
}

export interface FakeBotOptions {
	/** look() 的受控延迟门：测试在 look 恢复前后注入停止，验证迟到写入拒绝。 */
	lookGate?: (pos?: BotVec3) => Promise<void>;
	/** dig 完成计时（毫秒）；默认 0（当步完成）。 */
	digTimeMs?: number;
	/** 窗口点击的本地预测钩子（模拟上游 acceptClick 在发包前改窗口状态）。 */
	clickPrediction?: (window: BotWindowData, slot: number, button: number, mode: number) => void;
}

const KEY_LIST: Key[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];

export class FakeClientBot implements ClientBot {
	readonly version = "fake-1.21.4";
	#emitter = new FakeEmitter();
	#controlState: Record<Key, boolean> = {
		forward: false,
		back: false,
		left: false,
		right: false,
		jump: false,
		sprint: false,
		sneak: false,
	};
	#blocks = new Map<string, BotBlockInfo>();
	#sections = new Map<string, BotSectionData>();
	#slots: (BotItemStack | null)[] = new Array(46).fill(null);
	#selectedSlot = 36; // 绝对槽位索引（hotbar 首槽）。
	#currentWindow: BotWindowData | null = null;
	#nextWindowId = 1;
	#programmedWindow: Omit<BotWindowData, "id"> | null = null;
	#entities = new Map<number, BotEntity>();
	#digging: {
		pos: BotBlockPos;
		timer: ReturnType<typeof setTimeout>;
		resolve: () => void;
		reject: (e: Error) => void;
		done: boolean;
	} | null = null;
	#usingHeldItem = false;
	#lookGatePending = false;
	#quit = false;

	readonly options: FakeBotOptions;
	/** 协议包日志：断言"已派发"用（sent ≠ 服务器已处理）。 */
	readonly packets: { name: string; data: unknown }[] = [];
	/** 聊天记录。 */
	readonly chatLog: string[] = [];
	/** 攻击派发记录。 */
	readonly attackLog: number[] = [];

	// ---- 世界状态（测试直接读写）----
	position: BotVec3 = { x: 0, y: 64, z: 0 };
	velocity: BotVec3 = { x: 0, y: 0, z: 0 };
	yaw = 0;
	pitch = 0;
	onGround = true;
	health = 20;
	food = 20;
	dimension: string | null = "minecraft:overworld";
	physicsEnabled = true;
	/** 模拟 play 状态；false 对应连接建立前/配置阶段。 */
	playState = true;

	constructor(options: FakeBotOptions = {}) {
		this.options = options;
	}

	// ---- ClientBot 接口 ----

	on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): () => void {
		return this.#emitter.on(event, listener as Listener);
	}

	setControlState(key: Key, on: boolean): void {
		this.#controlState[key] = on;
	}

	getControlState(key: Key): boolean {
		return this.#controlState[key];
	}

	clearControlStates(): void {
		for (const k of KEY_LIST) this.#controlState[k] = false;
	}

	async look(yaw: number, pitch: number, _force?: boolean): Promise<void> {
		// lookGate：模拟上游 look 的异步间隙（如 lookAt 的平滑过程）。
		if (this.options.lookGate) {
			this.#lookGatePending = true;
			try {
				await this.options.lookGate();
			} finally {
				this.#lookGatePending = false;
			}
		}
		this.yaw = yaw;
		this.pitch = pitch;
	}

	physicsEnabledGetter(): boolean {
		return this.physicsEnabled;
	}

	self(): BotSelfState {
		return {
			position: { ...this.position },
			velocity: { ...this.velocity },
			yaw: this.yaw,
			pitch: this.pitch,
			onGround: this.onGround,
			health: this.health,
			food: this.food,
			dimension: this.dimension,
		};
	}

	blockAt(pos: BotBlockPos): BotBlockInfo | null {
		return this.#blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? null;
	}

	entities(): BotEntity[] {
		return [...this.#entities.values()];
	}

	inventorySlots(): { slotCount: number; slots: (BotItemStack | null)[]; selectedSlot: number } {
		return { slotCount: 46, slots: this.#slots, selectedSlot: this.#selectedSlot };
	}

	currentWindow(): BotWindowData | null {
		return this.#currentWindow;
	}

	section(section: BotBlockPos): BotSectionData | null {
		return this.#sections.get(`${section.x},${section.y},${section.z}`) ?? null;
	}

	chat(text: string): void {
		this.chatLog.push(text);
		this.#write("chat_message", { message: text });
	}

	dig(pos: BotBlockPos, opts: { forceLook: boolean }): Promise<void> {
		if (this.#digging) return Promise.reject(new Error("Digging already in progress"));
		const block = this.blockAt(pos);
		if (!block) return Promise.reject(new Error("block not loaded"));
		void opts; // preserve/target 的瞄准差异由 Driver 的 look 调用体现；替身内部不再重复瞄准。
		return new Promise<void>((resolve, reject) => {
			// 派发 start digging（上游先写 block_dig status 0 再计时）。
			this.#write("block_dig", { status: 0, location: pos });
			const timer = setTimeout(() => {
				// 本地预测：目标格变空气（digging.js finishDigging → _updateBlockState(position, 0)）。
				this.#digging = null;
				this.setBlock(pos, { name: "air", properties: {} });
				this.#write("block_dig", { status: 2, location: pos });
				resolve();
			}, this.options.digTimeMs ?? 0);
			this.#digging = { pos, timer, resolve, reject, done: false };
		});
	}

	stopDigging(): void {
		const digging = this.#digging;
		if (!digging) return;
		clearTimeout(digging.timer);
		this.#digging = null;
		// 上游写 block_dig status 1 取消（"Replicate the odd vanilla cancellation face value"）。
		this.#write("block_dig", { status: 1, location: digging.pos });
		digging.reject(new Error("Digging canceled"));
	}

	attack(networkId: number): void {
		this.attackLog.push(networkId);
		this.#write("arm_animation", {});
		this.#write("interact_entity", { entityid: networkId, type: "attack" });
	}

	activateItem(offHand: boolean): void {
		// 上游：空手不派发 use_item（静默 no-op）。
		const held = offHand ? this.#slots[45] : this.#slots[this.#selectedSlot];
		if (!held) return;
		this.#usingHeldItem = true;
		this.#write("use_item", { hand: offHand ? 1 : 0 });
	}

	deactivateItem(): void {
		if (!this.#usingHeldItem) return;
		this.#usingHeldItem = false;
		this.#write("block_dig", { status: 5 }); // player_digging: release use
	}

	usingHeldItem(): boolean {
		return this.#usingHeldItem;
	}

	activateBlock(pos: BotBlockPos, face: BotVec3 | null, cursor: BotVec3 | null): void {
		this.#write("block_place", {
			location: pos,
			direction: face ?? null,
			cursorX: cursor?.x,
			cursorY: cursor?.y,
			cursorZ: cursor?.z,
		});
		// 编程了窗口的方块：激活触发 windowOpen（真实 openBlock = activateBlock + wait windowOpen）。
		if (this.#programmedWindow) {
			const w: BotWindowData = { ...structuredClone(this.#programmedWindow), id: this.#nextWindowId++ };
			this.#programmedWindow = null;
			this.#openWindow(w);
		}
	}

	activateEntity(networkId: number): void {
		this.#write("interact_entity", { entityid: networkId, type: "interact" });
		if (this.#programmedWindow) {
			const w: BotWindowData = { ...structuredClone(this.#programmedWindow), id: this.#nextWindowId++ };
			this.#programmedWindow = null;
			this.#openWindow(w);
		}
	}

	async equip(selector: BotItemSelector, hand: "main" | "off"): Promise<void> {
		const names = [selector.name, ...(selector.substitutions ?? [])];
		const idx = this.#slots.findIndex((s) => s !== null && names.includes(s.name));
		if (idx === -1) throw new Error("item not found");
		if (hand === "off") {
			const tmp = this.#slots[45];
			this.#slots[45] = this.#slots[idx];
			this.#slots[idx] = tmp;
			this.#emitter.emit("setSlot", 0, idx, this.#slots[idx], null);
			this.#emitter.emit("setSlot", 0, 45, this.#slots[45], null);
			return;
		}
		// 主手：物品须在 hotbar（36-44）；不在则搬移。
		if (idx >= 36 && idx <= 44) {
			this.#selectedSlot = idx;
		} else {
			const tmp = this.#slots[36];
			this.#slots[36] = this.#slots[idx];
			this.#slots[idx] = tmp;
			this.#selectedSlot = 36;
			this.#emitter.emit("setSlot", 0, 36, this.#slots[36], null);
			this.#emitter.emit("setSlot", 0, idx, this.#slots[idx], null);
		}
		await Promise.resolve();
	}

	async clickWindow(windowId: number, slot: number, button: number, mode: number): Promise<void> {
		const w = this.#currentWindow;
		if (!w || w.id !== windowId) throw new Error("no such window");
		// 上游顺序：预测（acceptClick 改本地槽位/光标）先于发包。
		this.options.clickPrediction?.(w, slot, button, mode);
		this.#write("window_click", { windowId, slot, mouseButton: button, mode });
		await Promise.resolve();
	}

	closeWindow(windowId: number): void {
		if (!this.#currentWindow || this.#currentWindow.id !== windowId) return;
		this.#write("close_window", { windowId });
		const id = this.#currentWindow.id;
		this.#currentWindow = null;
		this.#emitter.emit("windowClose", id);
	}

	async resyncWindow(_windowId: number): Promise<void> {
		await Promise.resolve();
	}

	quit(): void {
		this.#quit = true;
	}

	get quitRequested(): boolean {
		return this.#quit;
	}

	// ---- 测试辅助（模拟服务器/协议输入）----

	#write(name: string, data: unknown): void {
		this.packets.push({ name, data });
	}

	setBlock(pos: BotBlockPos, info: BotBlockInfo | null): void {
		const key = `${pos.x},${pos.y},${pos.z}`;
		if (info === null) this.#blocks.delete(key);
		else this.#blocks.set(key, info);
		this.#emitter.emit("blockUpdate", pos, info);
	}

	setSection(section: BotBlockPos, data: BotSectionData): void {
		this.#sections.set(`${section.x},${section.y},${section.z}`, data);
	}

	setSlot(slot: number, item: BotItemStack | null): void {
		this.#slots[slot] = item;
		// 库存属窗口 0；窗口内槽位由 openWindow 后的调用方用 windowId 指定。
		this.#emitter.emit("setSlot", 0, slot, item, this.#currentWindow?.cursor ?? null);
	}

	setHealth(health: number): void {
		this.health = health;
		this.#emitter.emit("health");
	}

	setFood(food: number): void {
		this.food = food;
		this.#emitter.emit("health");
	}

	/** 编程下一次 activateBlock/activateEntity 打开的窗口。 */
	programWindow(
		type: string,
		slotCount: number,
		slots: (BotItemStack | null)[] = [],
		properties: Record<string, never> = {},
	): void {
		this.#programmedWindow = { type, slotCount, slots, cursor: null, properties };
	}

	addEntity(entity: BotEntity): void {
		const e: BotEntity = { ...entity, uuid: entity.uuid ?? null, type: entity.type ?? null };
		this.#entities.set(e.networkId, e);
		this.#emitter.emit("entitySpawn", e);
	}

	removeEntity(networkId: number): void {
		const e = this.#entities.get(networkId);
		if (!e) return;
		this.#entities.delete(networkId);
		this.#emitter.emit("entityGone", e);
	}

	#openWindow(w: BotWindowData): void {
		this.#currentWindow = w;
		this.#emitter.emit("windowOpen", w);
	}

	/** 服务端更新当前窗口槽位（触发 setSlot 事件，windowId 为当前窗口）。 */
	setWindowSlot(slot: number, item: BotItemStack | null): void {
		if (!this.#currentWindow) return;
		this.#currentWindow.slots[slot] = item;
		this.#emitter.emit("setSlot", this.#currentWindow.id, slot, item, this.#currentWindow.cursor);
	}

	/** 服务端主动关闭窗口。 */
	serverCloseWindow(): void {
		if (!this.#currentWindow) return;
		const id = this.#currentWindow.id;
		this.#currentWindow = null;
		this.#emitter.emit("windowClose", id);
	}

	/**
	 * 物理步进：模拟条件检查 → 模拟 → emit physicsTick（与真实顺序一致）。
	 * 不可模拟路径不发出 physicsTick；tick 消费由 drive/feedback 的步计数负责。
	 */
	stepPhysics(n = 1): void {
		for (let i = 0; i < n; i++) {
			if (!this.playState) return;
			if (!Number.isFinite(this.position.x)) return;
			// 区块未加载（脚下无方块数据）→ 不模拟、不 emit（真实 bot.blockAt == null）。
			if (
				this.blockAt({
					x: Math.floor(this.position.x),
					y: Math.floor(this.position.y - 0.5),
					z: Math.floor(this.position.z),
				}) === null
			)
				return;
			if (!this.physicsEnabled) return;
			// 简化运动学：forward/back 沿 yaw 推进，jump 提升高度。
			const speed = this.#controlState.sprint ? 0.28 : 0.2;
			const dx = -Math.sin(this.yaw);
			const dz = Math.cos(this.yaw);
			let vx = 0;
			let vz = 0;
			if (this.#controlState.forward) {
				vx += dx * speed;
				vz += dz * speed;
			}
			if (this.#controlState.back) {
				vx -= dx * speed;
				vz -= dz * speed;
			}
			if (this.#controlState.left) {
				vx += dz * speed;
				vz -= dx * speed;
			}
			if (this.#controlState.right) {
				vx -= dz * speed;
				vz += dx * speed;
			}
			this.velocity = { x: vx, y: this.velocity.y, z: vz };
			this.position = {
				x: this.position.x + vx,
				y: this.position.y + (this.#controlState.jump ? 0.25 : 0),
				z: this.position.z + vz,
			};
			this.onGround = !this.#controlState.jump;
			this.#emitter.emit("physicsTick");
		}
	}

	end(reason: string): void {
		this.#emitter.emit("end", reason);
	}

	kicked(reason: string): void {
		this.#emitter.emit("kicked", reason);
	}

	fail(err: Error): void {
		this.#emitter.emit("error", err);
	}

	die(): void {
		this.#emitter.emit("death");
	}

	respawn(): void {
		this.#emitter.emit("spawn");
	}

	get lookPending(): boolean {
		return this.#lookGatePending;
	}
}
