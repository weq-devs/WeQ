// Minimal protobuf decoder for the OidbSvcTrpcTcp.0xcde_2 response.
//
// Schema (taken from NapCat's napcat-core/packet/transformer/proto/oidb):
//
//   message OidbSvcTrpcTcpBase {           // outer envelope
//       uint32 command   = 1;
//       uint32 subCommand = 2;
//       uint32 errorCode = 3;
//       bytes  body      = 4;              // <-- field of interest
//       ...
//   }
//   message OidbSvcTrpcTcp0XCDE_2RespBody {
//       OidbSvcTrpcTcp0XCDE_2RespBodyInner inner = 2;
//   }
//   message OidbSvcTrpcTcp0XCDE_2RespBodyInner {
//       string value = 1;                  // <-- THE PASSPHRASE
//   }
//
// We avoid pulling in a full protobuf library: parse three fixed
// wire-types (LEN for the embedded messages, LEN for the string) and
// skip everything else.

const WIRE_VARINT = 0;
const WIRE_I64    = 1;
const WIRE_LEN    = 2;
const WIRE_I32    = 5;

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
    let value = 0;
    let shift = 0;
    let i = offset;
    while (i < buf.length) {
        const b = buf[i++]!;
        value |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) {
            return { value, next: i };
        }
        shift += 7;
        if (shift > 35) {
            throw new Error('varint too long');
        }
    }
    throw new Error('truncated varint');
}

function skipField(buf: Buffer, wire: number, offset: number): number {
    switch (wire) {
        case WIRE_VARINT: {
            return readVarint(buf, offset).next;
        }
        case WIRE_I64:
            return offset + 8;
        case WIRE_LEN: {
            const len = readVarint(buf, offset);
            return len.next + len.value;
        }
        case WIRE_I32:
            return offset + 4;
        default:
            throw new Error(`unsupported wire type ${wire}`);
    }
}

/** Read field `wantTag` as a length-delimited slice; returns null if not found. */
function findLenField(buf: Buffer, wantTag: number): Buffer | null {
    let i = 0;
    while (i < buf.length) {
        const tagInfo = readVarint(buf, i);
        const tag = tagInfo.value >>> 3;
        const wire = tagInfo.value & 0x07;
        i = tagInfo.next;
        if (wire === WIRE_LEN) {
            const len = readVarint(buf, i);
            const start = len.next;
            const end = start + len.value;
            if (tag === wantTag) {
                return buf.subarray(start, end);
            }
            i = end;
        } else {
            i = skipField(buf, wire, i);
        }
    }
    return null;
}

/**
 * Decode the passphrase out of an OidbSvcTrpcTcp.0xcde_2 response body.
 * Returns the UTF-8 passphrase string on success, or null if the packet
 * shape does not match (which happens on every NON-0xcde_2 packet, since
 * we run this on every recv to filter).
 */
export function extractCde2Passphrase(packetHex: string): string | null {
    let raw: Buffer;
    try {
        raw = Buffer.from(packetHex, 'hex');
    } catch {
        return null;
    }
    // base.body = field 4 (length-delimited bytes)
    const body = findLenField(raw, 4);
    if (body === null) return null;

    // RespBody.inner = field 2 (length-delimited embedded message)
    const inner = findLenField(body, 2);
    if (inner === null) return null;

    // Inner.value = field 1 (length-delimited string)
    const value = findLenField(inner, 1);
    if (value === null) return null;

    return value.toString('utf8');
}
