import zlib from 'zlib';

/**
 * Decoder for the AWS binary event-stream framing (application/vnd.amazon.eventstream),
 * used by Bedrock's ConverseStream (VA·E5 · TK-4494).
 *
 * Each message: total length (4B) | headers length (4B) | prelude CRC32 (4B) | headers |
 * payload | message CRC32 (4B). Headers are name-length(1B) name type(1B) value; only the
 * string type (7) is read — the ones Bedrock sends (:event-type, :message-type, ...).
 */

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

const crc32 = (buf: Buffer): number => (zlib as unknown as { crc32(b: Buffer): number }).crc32(buf) >>> 0;

function parseHeaders(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (o < buf.length) {
    const nameLen = buf.readUInt8(o); o += 1;
    const name = buf.subarray(o, o + nameLen).toString('utf8'); o += nameLen;
    const type = buf.readUInt8(o); o += 1;
    switch (type) {
      case 0: case 1: out[name] = String(type === 0); break; // bool true / false
      case 2: o += 1; break;
      case 3: o += 2; break;
      case 4: o += 4; break;
      case 5: case 8: o += 8; break;
      case 6: case 7: {
        const len = buf.readUInt16BE(o); o += 2;
        if (type === 7) out[name] = buf.subarray(o, o + len).toString('utf8');
        o += len;
        break;
      }
      case 9: o += 16; break;
      default: throw new Error(`event-stream: unknown header type ${type}`);
    }
  }
  return out;
}

/** Yields decoded messages from a streamed response body; verifies both CRCs. */
export async function* eventStreamMessages(res: Response): AsyncIterable<EventStreamMessage> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let buffer = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer = Buffer.concat([buffer, Buffer.from(value)]);
    while (buffer.length >= 12) {
      const total = buffer.readUInt32BE(0);
      if (buffer.length < total) break;
      const headersLen = buffer.readUInt32BE(4);
      if (crc32(buffer.subarray(0, 8)) !== buffer.readUInt32BE(8)) throw new Error('event-stream: prelude CRC mismatch');
      if (crc32(buffer.subarray(0, total - 4)) !== buffer.readUInt32BE(total - 4)) throw new Error('event-stream: message CRC mismatch');
      const headers = parseHeaders(buffer.subarray(12, 12 + headersLen));
      const payload = buffer.subarray(12 + headersLen, total - 4);
      yield { headers, payload: Buffer.from(payload) };
      buffer = buffer.subarray(total);
    }
    if (done) break;
  }
}

/** Encodes one message (string headers only) — the inverse, used by tests and stubs. */
export function encodeEventStreamMessage(headers: Record<string, string>, payload: Buffer): Buffer {
  const hParts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    h.writeUInt8(n.length, o); o += 1;
    n.copy(h, o); o += n.length;
    h.writeUInt8(7, o); o += 1;
    h.writeUInt16BE(v.length, o); o += 2;
    v.copy(h, o);
    hParts.push(h);
  }
  const hBuf = Buffer.concat(hParts);
  const total = 12 + hBuf.length + payload.length + 4;
  const msg = Buffer.alloc(total);
  msg.writeUInt32BE(total, 0);
  msg.writeUInt32BE(hBuf.length, 4);
  msg.writeUInt32BE(crc32(msg.subarray(0, 8)), 8);
  hBuf.copy(msg, 12);
  payload.copy(msg, 12 + hBuf.length);
  msg.writeUInt32BE(crc32(msg.subarray(0, total - 4)), total - 4);
  return msg;
}
