import { brotliDecompressSync, inflateSync } from "node:zlib";

export const HEADER_SIZE = 16;
export const MAX_PACKET_LEN = 2 * 1024 * 1024; // 2MB 单包安全上限，防御内存炸弹

/**
 * 操作码 (Operation)
 */
export enum Operation {
  HANDSHAKE = 0,
  HANDSHAKE_REPLY = 1,
  HEARTBEAT = 2,
  HEARTBEAT_REPLY = 3,
  SEND_MSG = 4,
  SEND_MSG_REPLY = 5,
  DISCONNECT_REPLY = 6,
  AUTH = 7,
  AUTH_REPLY = 8,
  RAW = 9,
  PROTO_READY = 10,
  PROTO_FINISH = 11,
  CHANGE_ROOM = 12,
  CHANGE_ROOM_REPLY = 13,
  REGISTER = 14,
  REGISTER_REPLY = 15,
  UNREGISTER = 16,
  UNREGISTER_REPLY = 17,
}

/**
 * 协议版本 (ProtoVer)
 */
export enum ProtoVer {
  NORMAL = 0,    // 普通未压缩 JSON
  HEARTBEAT = 1, // 心跳包响应 (人气值)
  DEFLATE = 2,   // Zlib 压缩
  BROTLI = 3,    // Brotli 压缩
}

/**
 * 16 字节包头元数据
 */
export interface PacketHeader {
  packLen: number;        // 整个包长度 (含 16 字节头部)
  rawHeaderSize: number;  // 头部长度 (固定 16)
  ver: ProtoVer;          // 协议版本
  operation: Operation;   // 操作码
  seqId: number;          // 序列号
}

/**
 * 解包后的基础消息结构
 */
export interface RawPacket {
  header: PacketHeader;
  body: any;
}

/**
 * 编码 16 字节大端协议包
 */
export function encodePacket(
  operation: Operation,
  body: string | Buffer | Record<string, any> = ""
): Buffer {
  let bodyBuf: Buffer;
  if (Buffer.isBuffer(body)) {
    bodyBuf = body;
  } else if (typeof body === "string") {
    bodyBuf = Buffer.from(body, "utf-8");
  } else {
    bodyBuf = Buffer.from(JSON.stringify(body), "utf-8");
  }

  const packLen = HEADER_SIZE + bodyBuf.length;
  const header = Buffer.alloc(HEADER_SIZE);

  header.writeUInt32BE(packLen, 0);
  header.writeUInt16BE(HEADER_SIZE, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(1, 12);

  return Buffer.concat([header, bodyBuf]);
}

/**
 * 解码 16 字节包头（含防御性校验）
 */
export function decodePacketHeader(buf: Buffer): PacketHeader {
  if (buf.length < HEADER_SIZE) {
    throw new Error(`packet header too short: expected at least ${HEADER_SIZE} bytes, got ${buf.length}`);
  }

  const packLen = buf.readUInt32BE(0);
  const rawHeaderSize = buf.readUInt16BE(4);
  const ver = buf.readUInt16BE(6) as ProtoVer;
  const operation = buf.readUInt32BE(8) as Operation;
  const seqId = buf.readUInt32BE(12);

  return { packLen, rawHeaderSize, ver, operation, seqId };
}

function parseJsonOrRaw(slice: Buffer): unknown {
  if (slice.length === 0) return {};
  try {
    return JSON.parse(slice.toString("utf-8"));
  } catch {
    return slice;
  }
}

function decompressAndUnpack(
  slice: Buffer,
  decompressFn: (buf: Buffer) => Buffer,
  name: string
): RawPacket[] {
  try {
    return unpackPackets(decompressFn(slice));
  } catch (err) {
    console.error(`[blivedm-ts] ${name} decompress error:`, err);
    return [];
  }
}

/**
 * 解析单个数据包体（处理压缩与反序列化）
 */
export function parseSinglePacketBody(header: PacketHeader, bodySlice: Buffer): RawPacket[] {
  if (header.operation === Operation.HEARTBEAT_REPLY) {
    const popularity = bodySlice.length >= 4 ? bodySlice.readUInt32BE(0) : 0;
    return [{ header, body: { popularity } }];
  }

  const isMsgOrAuth =
    header.operation === Operation.SEND_MSG_REPLY ||
    header.operation === Operation.AUTH_REPLY;

  if (isMsgOrAuth) {
    if (header.ver === ProtoVer.BROTLI) {
      return decompressAndUnpack(bodySlice, brotliDecompressSync, "Brotli");
    }
    if (header.ver === ProtoVer.DEFLATE) {
      return decompressAndUnpack(bodySlice, inflateSync, "Deflate");
    }
  }

  const body =
    header.ver === ProtoVer.NORMAL || !isMsgOrAuth
      ? parseJsonOrRaw(bodySlice)
      : bodySlice;

  return [{ header, body }];
}

/**
 * 解包原始字节流，支持粘包循环切片、Brotli/Deflate 递归解压与畸变包防御
 */
export function unpackPackets(buf: Buffer): RawPacket[] {
  const results: RawPacket[] = [];
  let offset = 0;

  while (offset + HEADER_SIZE <= buf.length) {
    let header: PacketHeader;
    try {
      header = decodePacketHeader(buf.subarray(offset, offset + HEADER_SIZE));
    } catch {
      break;
    }

    // 防御性校验：包体长度合法性与超大内存炸弹拦截
    if (
      header.packLen < HEADER_SIZE ||
      header.packLen > MAX_PACKET_LEN ||
      header.rawHeaderSize < HEADER_SIZE ||
      header.rawHeaderSize > header.packLen ||
      offset + header.packLen > buf.length
    ) {
      break;
    }

    const bodySlice = buf.subarray(
      offset + header.rawHeaderSize,
      offset + header.packLen
    );

    const packets = parseSinglePacketBody(header, bodySlice);
    results.push(...packets);

    offset += header.packLen;
  }

  return results;
}
