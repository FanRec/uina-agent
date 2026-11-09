/** G31 回归探针：单跑 spatial 的第一条下行阶梯 tunnel，setup 前后都做尸检（排障工具，随批39留下）。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plain, type Vec3 } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9500, y: 200, z: 9500 };

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-stair-"));
	const h = await openHarness("stairprobe", { dataRoot });
	const s = makeScenario(h, "stairprobe");
	const x0 = CENTER.x + 15;
	const z0 = CENTER.z;
	try {
		await s.command(`/gamemode creative ${USER}`);
		const fillReply = await s.serverReply(`/fill ${x0} 196 ${z0 - 2} ${x0 + 12} 204 ${z0 + 2} minecraft:stone`);
		console.log(`[stairprobe] fill -> ${fillReply}`);
		await s.command(`/setblock ${x0 + 2} 201 ${z0} minecraft:gravel`);
		await s.command(`/setblock ${x0 + 2} 202 ${z0} minecraft:gravel`);
		await s.command(`/fill ${x0} 200 ${z0} ${x0} 201 ${z0} minecraft:air`);
		await s.command("/give @s minecraft:iron_pickaxe 1");
		await s.command(`/tp ${USER} ${x0 + 0.5} 200.1 ${z0 + 0.5}`);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);

		// pre-flight：tunnel 之前客户端/服务端必须一致，否则后面全是噪声。
		const preflight: Vec3[] = [
			{ x: x0 + 1, y: 199, z: z0 },
			{ x: x0 + 1, y: 201, z: z0 },
			{ x: x0 + 2, y: 198, z: z0 },
			{ x: x0 + 2, y: 199, z: z0 },
			{ x: x0 + 2, y: 200, z: z0 },
			{ x: x0 + 2, y: 201, z: z0 },
			{ x: x0 + 2, y: 202, z: z0 },
		];
		console.log("[stairprobe] pre-flight:");
		for (const at of preflight) {
			const client = await h.world.read<{ block?: { name: string } | null }>({ ref: "block@1", input: plain({ at }) });
			const server = (
				await s.serverReply(
					`/execute if block ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)} minecraft:gravel`,
				)
			).includes("Test passed")
				? "gravel"
				: (
							await s.serverReply(
								`/execute if block ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)} minecraft:air`,
							)
						).includes("Test passed")
					? "air"
					: "stone";
			console.log(
				`[stairprobe]   ${at.x},${at.y},${at.z} client=${client.value?.block?.name ?? "null"} server=${server}`,
			);
		}

		const result = await s.call("tunnel@1", { to: { x: x0 + 8, y: 196, z: z0 }, maxTimeMs: 150000 }, 240000);
		if (result.ok) {
			const value = result.value as unknown as { dug: number; path: { at: Vec3; name: string }[] };
			console.log(`[stairprobe] PASS dug=${value.dug}`);
			for (const entry of value.path)
				console.log(`[stairprobe]   dug ${entry.at.x},${entry.at.y},${entry.at.z} = ${entry.name}`);
		} else {
			console.log(`[stairprobe] FAIL ${result.code}: ${(result.message ?? "").slice(0, 400)}`);
		}

		const cells: Vec3[] = [];
		for (let y = 197; y <= 203; y++) cells.push({ x: x0 + 2, y, z: z0 });
		for (let y = 198; y <= 201; y++) cells.push({ x: x0 + 1, y, z: z0 });
		console.log("[stairprobe] post-mortem:");
		for (const at of cells) {
			const client = await h.world.read<{ block?: { name: string } | null }>({ ref: "block@1", input: plain({ at }) });
			const server = (
				await s.serverReply(
					`/execute if block ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)} minecraft:gravel`,
				)
			).includes("Test passed")
				? "gravel"
				: (
							await s.serverReply(
								`/execute if block ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)} minecraft:air`,
							)
						).includes("Test passed")
					? "air"
					: "stone";
			console.log(
				`[stairprobe]   ${at.x},${at.y},${at.z} client=${client.value?.block?.name ?? "null"} server=${server}`,
			);
			await sleep(100);
		}
	} finally {
		await closeHarness(h);
	}
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
