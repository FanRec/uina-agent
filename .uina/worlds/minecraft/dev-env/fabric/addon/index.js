const register = "minecraft:register";
const sync = "fabric:registry/sync";
const complete = "fabric:registry/sync/complete";
const manifestChannel = "uina_fixture:manifest";

function packetReader(data) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let offset = 0;
	const byte = () => {
		if (offset >= data.length) throw new Error("truncated Fabric payload");
		return data[offset++];
	};
	const integer = () => {
		let value = 0;
		for (let shift = 0; shift <= 28; shift += 7) {
			const next = byte();
			value |= (next & 127) << shift;
			if ((next & 128) === 0) return value;
		}
		throw new Error("invalid Fabric VarInt");
	};
	return {
		byte,
		integer,
		string() {
			const length = integer();
			if (length < 0 || offset + length > data.length) throw new Error("invalid Fabric string length");
			const value = decoder.decode(data.subarray(offset, offset + length));
			offset += length;
			return value;
		},
		finish() {
			if (offset !== data.length) throw new Error("unexpected Fabric payload tail");
		},
	};
}

function readSync(data) {
	const r = packetReader(data);
	const registries = Object.create(null);
	const groups = r.integer();
	for (let group = 0; group < groups; group++) {
		const namespace = r.string() || "minecraft";
		const count = r.integer();
		for (let i = 0; i < count; i++) {
			const registry = namespace + ":" + r.string();
			r.byte(); // Fabric registry attributes
			const entries = (registries[registry] = Object.create(null));
			const entryGroups = r.integer();
			let lastId = 0;
			for (let j = 0; j < entryGroups; j++) {
				const entryNamespace = r.string() || "minecraft";
				const ranges = r.integer();
				for (let k = 0; k < ranges; k++) {
					const first = lastId + r.integer();
					const size = r.integer();
					for (let n = 0; n < size; n++) entries[entryNamespace + ":" + r.string()] = first + n;
					lastId = first + size - 1;
				}
			}
		}
	}
	r.finish();
	return registries;
}

export default {
	api: 1,
	id: "fabric-fixture",
	create() {
		return {
			client: {
				install(boot) {
					let manifest;
					boot.claim("configuration", "connection-registry");
					boot.onPayload("configuration", register, (data, ctx) => {
						const channels = Buffer.from(data).toString("ascii").split("\0");
						if (channels.includes(complete))
							ctx.replyPayload(register, Buffer.from([sync, manifestChannel].join("\0")));
					});
					boot.onPayload("configuration", manifestChannel, (data) => {
						const r = packetReader(data);
						manifest = JSON.parse(r.string());
						r.finish();
					});
					boot.onPayload("configuration", sync, (data, ctx) => {
						if (!manifest) throw new Error("fixture manifest did not precede Fabric registry sync");
						const { world, tileItem, tokenItem, tileBlock, tileState } = manifest;
						ctx.installRegistry({
							world,
							items: [{ name: "uina_fixture:tile", id: tileItem }, { name: "uina_fixture:token", id: tokenItem }],
							solidBlocks: [{ name: "uina_fixture:tile", id: tileBlock, stateId: tileState, hardness: 1.5 }],
							synchronizedIds: readSync(data),
						});
						ctx.replyPayload(complete, new Uint8Array());
					});
				},
			},
		};
	},
};
