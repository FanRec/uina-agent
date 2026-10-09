interface ProtoField {
  readonly number: number;
  readonly value: bigint | Buffer;
}

interface SendGiftV2Gift {
  readonly giftId: number;
  readonly giftName: string;
  readonly count: number;
  readonly price: number;
  readonly coinType: "gold" | "silver";
  readonly id?: string;
  readonly timestamp?: number;
  readonly action?: string;
}

interface SendGiftV2Broadcast {
  readonly uid: number;
  readonly uname: string;
  readonly guardLevel?: number;
  readonly medalName?: string;
  readonly medalLevel?: number;
  readonly gifts: readonly SendGiftV2Gift[];
}

// Field numbers follow SendGiftBroadcast / SendGiftV2GiftItem. Unknown scalar and
// length-delimited fields are skipped so additive protocol fields do not break gifts.

function readVarint(bytes: Buffer, cursor: { value: number }): bigint {
  let result = 0n;
  for (let index = 0; index < 10; index++) {
    if (cursor.value >= bytes.length) throw new Error("truncated protobuf varint");
    const byte = bytes[cursor.value++];
    if (index === 9 && byte > 1) throw new Error("protobuf varint exceeds 64 bits");
    result |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return result;
  }
  throw new Error("protobuf varint exceeds 10 bytes");
}

function readFields(bytes: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  const cursor = { value: 0 };
  while (cursor.value < bytes.length) {
    const tag = readVarint(bytes, cursor);
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 0) throw new Error("invalid protobuf field number 0");

    if (wireType === 0) {
      fields.push({ number: fieldNumber, value: readVarint(bytes, cursor) });
      continue;
    }
    if (wireType === 1) {
      if (cursor.value + 8 > bytes.length) throw new Error("truncated protobuf fixed64 field");
      cursor.value += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (length > BigInt(bytes.length - cursor.value)) throw new Error("truncated protobuf bytes field");
      const end = cursor.value + Number(length);
      fields.push({ number: fieldNumber, value: bytes.subarray(cursor.value, end) });
      cursor.value = end;
      continue;
    }
    if (wireType === 5) {
      if (cursor.value + 4 > bytes.length) throw new Error("truncated protobuf fixed32 field");
      cursor.value += 4;
      continue;
    }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

function firstVarint(fields: readonly ProtoField[], number: number): bigint | undefined {
  const field = fields.find((candidate) => candidate.number === number);
  if (!field) return undefined;
  if (typeof field.value !== "bigint") throw new Error(`protobuf field ${number} has the wrong wire type`);
  return field.value;
}

function firstBytes(fields: readonly ProtoField[], number: number): Buffer | undefined {
  const field = fields.find((candidate) => candidate.number === number);
  if (!field) return undefined;
  if (!Buffer.isBuffer(field.value)) throw new Error(`protobuf field ${number} has the wrong wire type`);
  return field.value;
}

function textField(fields: readonly ProtoField[], number: number): string | undefined {
  const value = firstBytes(fields, number);
  if (!value) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`protobuf field ${number} is not valid UTF-8`);
  }
}

function safeInteger(value: bigint | undefined, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`protobuf ${fieldName} is outside the safe integer range`);
  return number;
}

function decodeGift(bytes: Buffer): SendGiftV2Gift {
  const fields = readFields(bytes);
  const giftId = safeInteger(firstVarint(fields, 1), "gift_id");
  const giftName = textField(fields, 2);
  const count = safeInteger(firstVarint(fields, 3), "num");
  let price = safeInteger(firstVarint(fields, 5), "price");
  const totalCoin = safeInteger(firstVarint(fields, 7), "total_coin");
  const coinType = textField(fields, 8);
  const id = textField(fields, 9) ?? textField(fields, 12);
  const timestamp = safeInteger(firstVarint(fields, 10), "timestamp");
  const action = textField(fields, 18);

  if (!giftId) throw new Error("SEND_GIFT_V2 gift is missing a valid gift_id");
  if (!giftName?.trim()) throw new Error("SEND_GIFT_V2 gift is missing gift_name");
  if (!count) throw new Error("SEND_GIFT_V2 gift is missing a valid num");
  if (price === undefined) {
    if (totalCoin === undefined) throw new Error("SEND_GIFT_V2 gift is missing price and total_coin");
    price = Math.round(totalCoin / count);
  }
  if (coinType !== "gold" && coinType !== "silver") throw new Error("SEND_GIFT_V2 gift has an unknown coin_type");

  return { giftId, giftName, count, price, coinType, id, timestamp, action };
}

/** Decode the base64 `data.pb` SendGiftBroadcast used by SEND_GIFT_V2. */
export function decodeSendGiftV2(data: unknown): SendGiftV2Broadcast {
  if (!data || typeof data !== "object" || !("pb" in data) || typeof data.pb !== "string") {
    throw new Error("SEND_GIFT_V2 is missing data.pb");
  }
  const encoded = data.pb;
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("SEND_GIFT_V2 data.pb is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new Error("SEND_GIFT_V2 data.pb is not valid base64");
  }

  const fields = readFields(bytes);
  const uid = safeInteger(firstVarint(fields, 1), "uid");
  const uname = textField(fields, 2);
  const guardLevel = safeInteger(firstVarint(fields, 5), "guard_level");
  const medalBytes = firstBytes(fields, 8);
  const giftFields = fields.filter((field) => field.number === 10);
  const gifts = giftFields.map((field) => {
    if (!Buffer.isBuffer(field.value)) throw new Error("SEND_GIFT_V2 gift_list has the wrong wire type");
    return decodeGift(field.value);
  });

  if (!uid) throw new Error("SEND_GIFT_V2 is missing a valid sender uid");
  if (!uname?.trim()) throw new Error("SEND_GIFT_V2 is missing sender uname");
  if (gifts.length === 0) throw new Error("SEND_GIFT_V2 contains no gift_list items");

  let medalName: string | undefined;
  let medalLevel: number | undefined;
  if (medalBytes) {
    const medalFields = readFields(medalBytes);
    medalLevel = safeInteger(firstVarint(medalFields, 5), "medal_level");
    medalName = textField(medalFields, 6);
  }

  return { uid, uname, guardLevel, medalName, medalLevel, gifts };
}
