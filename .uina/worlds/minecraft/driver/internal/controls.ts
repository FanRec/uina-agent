/**
 * 连续控制根的输入持有：按键资源的单一记账。
 *
 * 每个连续根（drive / feedback 流）持有一个实例；实例即"本根当前按住哪些键"的
 * 唯一归属记录。撤销只清自己按住的键，不碰其他根或新主人的键（§6.3/§7 交接语义）。
 * bot 内部的 controlState 是物理事实，不在这里记账。
 */

import type { ControlInput, Key } from "../../contracts/body.js";
import type { ClientBot } from "./bot-shape.js";

export const CONTROL_KEYS: Key[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];

export class KeyHold {
	readonly #keys = new Set<Key>();

	constructor(private readonly bot: ClientBot) {}

	/** 安装单键状态并记账；on=false 时解除持有（清不在册键是 no-op）。 */
	set(key: Key, on: boolean): void {
		this.bot.setControlState(key, on);
		if (on) this.#keys.add(key);
		else this.#keys.delete(key);
	}

	/** 按输入对象的声明键位安装（drive 语义：只处理显式给出的键）。 */
	applyInput(input: ControlInput): void {
		for (const [k, on] of Object.entries(input.keys ?? {})) {
			const key = k as Key;
			if (!CONTROL_KEYS.includes(key)) throw new Error(`未知控制键: ${k}`);
			if (on === undefined) continue;
			this.set(key, on);
		}
	}

	/** 反馈帧语义：全部键位统一安装到声明状态。 */
	applyFrame(input: ControlInput): void {
		for (const key of CONTROL_KEYS) {
			this.set(key, input.keys?.[key] ?? false);
		}
	}

	/** 撤销本根按住的全部键（只清自己的，不全局清空）。 */
	releaseAll(): void {
		for (const k of this.#keys) this.bot.setControlState(k, false);
		this.#keys.clear();
	}

	get holdsAny(): boolean {
		return this.#keys.size > 0;
	}
}
