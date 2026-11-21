import type { GroupCallCodec } from '@weq/service';
import { decode, encode } from 'silk-wasm';

const SAMPLE_RATE = 16_000;
const PCM_FRAME_BYTES = 640;
const SILK_HEADER = Buffer.from('\x02#!SILK_V3');
const MAX_SILK_FRAME_BYTES = 253;
const DECODE_HISTORY = 3;
const END_OF_STREAM = Buffer.alloc(2);

/** 将群通话的裸 SILK 帧接到已有的跨平台 SILK 编解码器。 */
export class GroupCallAudioCodec implements GroupCallCodec {
  private readonly history = new Map<number, Buffer[]>();

  async encode(pcm: Uint8Array): Promise<Uint8Array> {
    if (pcm.byteLength !== PCM_FRAME_BYTES) throw new Error('群通话 PCM 帧长度无效');
    const { data } = await encode(pcm, SAMPLE_RATE);
    const offset = SILK_HEADER.length;
    if (data.length <= offset + 2) throw new Error('SILK 编码未返回音频帧');
    const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(
      offset,
      true,
    );
    if (length > MAX_SILK_FRAME_BYTES || data.length !== offset + 2 + length) {
      throw new Error('SILK 编码返回了无效帧');
    }
    return data.subarray(offset + 2);
  }

  async decode(silk: Uint8Array, uin: number): Promise<Uint8Array> {
    if (silk.byteLength === 0 || silk.byteLength > MAX_SILK_FRAME_BYTES) {
      throw new Error('群通话 SILK 帧长度无效');
    }
    const block = Buffer.allocUnsafe(2 + silk.byteLength);
    block.writeUInt16LE(silk.byteLength);
    block.set(silk, 2);
    const recent = [...(this.history.get(uin) ?? []), block].slice(-DECODE_HISTORY);
    this.history.set(uin, recent);
    // 文件解码器预读两帧。首帧补一份用于预读，仅返回真实帧的 PCM。
    const blocks = recent.length === 1 ? [block, block] : recent;
    const input = Buffer.concat([SILK_HEADER, ...blocks, END_OF_STREAM]);
    const { data } = await decode(input, SAMPLE_RATE);
    if (data.byteLength !== blocks.length * PCM_FRAME_BYTES) {
      throw new Error('SILK 解码返回了无效帧');
    }
    const offset = (recent.length - 1) * PCM_FRAME_BYTES;
    return data.subarray(offset, offset + PCM_FRAME_BYTES);
  }

  resetMember(uin: number): void {
    this.history.delete(uin);
  }
}
