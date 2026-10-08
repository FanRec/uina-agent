/** A complete 10ms mono PCM16 WAV, constructed independently of the production decoder. */
export function pcmWav(): Buffer {
	const bytes = Buffer.alloc(204);
	bytes.write("RIFF");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24);
	bytes.writeUInt32LE(16000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(160, 40);
	return bytes;
}
