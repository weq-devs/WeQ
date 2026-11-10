import { describe, expect, it } from 'vitest';
import {
  authorizedSignProbeBackend,
  decodeSignProbeBatch,
  parseProbeMaterial,
} from '../../../scripts/sign-probe-authorization';
import type { AuthorizationRequest } from '../../../apps/desktop/src/main/authorization/protocol';
import type { CaptureBatchWire } from '../../../apps/desktop/src/main/capture_protocol';

const batch: CaptureBatchWire = {
  nextCursor: 2,
  dropped: 0,
  frames: [
    {
      cursor: 1,
      ts: 100,
      direction: 'c2s',
      proto: 13,
      encryptType: 1,
      seq: 7,
      cmd: 'test.Command',
      rawHex: 'aabb',
      plainHex: '000102',
      bodyHex: 'ff',
    },
  ],
};

describe('签名探测长期授权适配', () => {
  it('还原助手的 hex 帧，而不是把 JSON 字符串交给签名分析', () => {
    const restored = decodeSignProbeBatch(batch);
    expect(restored.frames[0]?.plain).toEqual(Buffer.from([0, 1, 2]));
    expect(restored.frames[0]?.cmd).toBe('test.Command');
    expect(restored.nextCursor).toBe(2);
  });

  it.each(['0', 'zz', '0x00'])('拒绝损坏的帧 hex：%s', (plainHex) => {
    expect(() =>
      decodeSignProbeBatch({ ...batch, frames: [{ ...batch.frames[0]!, plainHex }] }),
    ).toThrow('无效的抓包 hex');
  });

  it('保留取帧游标并将 d2Key 映射成助手协议的 d2key', async () => {
    const requests: Omit<AuthorizationRequest, 'id'>[] = [];
    const connection = {
      async request<T>(request: Omit<AuthorizationRequest, 'id'>): Promise<T> {
        requests.push(request);
        if (request.op === 'take') return batch as T;
        return {} as T;
      },
    };
    const backend = authorizedSignProbeBackend(connection);
    await backend.startCapture(123, { d2Key: '11'.repeat(16), ringFrames: 16 });
    const frames = await backend.takeFrames(123, { cursor: 9, waitMs: 10, maxFrames: 5 });
    await backend.stopCapture(123);
    expect(requests[0]).toMatchObject({
      op: 'start',
      pid: 123,
      d2key: '11'.repeat(16),
      ringFrames: 16,
    });
    expect(requests[0]).not.toHaveProperty('d2Key');
    expect(requests[1]).toEqual({ op: 'take', pid: 123, cursor: 9, waitMs: 10, maxFrames: 5 });
    expect(requests[2]).toEqual({ op: 'stop', pid: 123 });
    expect(frames.frames[0]?.body).toEqual(Buffer.from([255]));
  });

  it('物料仅用于同一个 PID，且必须为完整的 16 字节 hex key', () => {
    expect(parseProbeMaterial({ pid: 123, d2Key: '11'.repeat(16) }, 123)).toEqual({
      d2Key: '11'.repeat(16),
    });
    for (const value of [null, [], { pid: 124, d2Key: '11'.repeat(16) }, { pid: 123, d2Key: '11' }])
      expect(() => parseProbeMaterial(value, 123)).toThrow();
  });
});
