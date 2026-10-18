// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  OwnQQSessionCollector,
  readOwnSessionMaterial,
} from '../src/main/qq_runtime/session_material';
import type { NtHelperBinding } from '@weq/native';

describe('托管宿主自身票据读取', () => {
  it('采集按序执行，不同时扫描自身堆', async () => {
    const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };
    let finish: (value: typeof material) => void = () => {};
    const read = vi
      .fn(async () => material)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const publish = vi.fn();
    const collector = new OwnQQSessionCollector(
      () => ({ uin: '10001', uid: 'u_self', guid: 'ab'.repeat(16) }),
      read,
      publish,
    );
    const first = collector.collect('first'),
      second = collector.collect('second');
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    finish(material);
    await first;
    await second;
    expect(publish.mock.calls.map(([value]) => value.requestId)).toEqual(['first', 'second']);
  });

  it('身份切换后丢弃在途结果，未登录时不读内存', async () => {
    const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };
    let identity: { uin: string; uid: string; guid: string } | null = {
      uin: '10001',
      uid: 'u_self',
      guid: 'ab'.repeat(16),
    };
    const read = vi.fn(async () => {
        identity = null;
        return material;
      }),
      publish = vi.fn();
    const collector = new OwnQQSessionCollector(() => identity, read, publish);
    await collector.collect('first');
    await collector.collect('second');
    expect(read).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it('票据未就绪最多读三次，失败不泄露原生错误且不阻塞下一次采集', async () => {
    const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };
    const read = vi.fn(async () => material).mockRejectedValue(new Error('private-native-detail'));
    const wait = vi.fn(async () => {}),
      publish = vi.fn();
    const collector = new OwnQQSessionCollector(
      () => ({ uin: '10001', uid: 'u_self', guid: 'ab'.repeat(16) }),
      read,
      publish,
      wait,
    );
    await expect(collector.collect('first')).rejects.toThrow('当前登录票据尚未就绪');
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
    read.mockResolvedValue(material);
    await collector.collect('second');
    expect(publish).toHaveBeenCalledOnce();
  });
  it('只读当前真实 PID，输出仅包含三项白名单票据', async () => {
    const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };
    const nt = {
      getInitStatus: () => 0,
      scanSessionMaterial: vi.fn(async () => ({ ...material, nearbyMemory: 'not-forwarded' })),
    };
    expect(await readOwnSessionMaterial(nt)).toEqual(material);
    expect(nt.scanSessionMaterial).toHaveBeenCalledWith(process.pid);
  });
  it('缺失、超长和非十六进制票据都不交给主进程', async () => {
    const nt = {
      getInitStatus: () => 0,
      scanSessionMaterial: vi.fn<NtHelperBinding['scanSessionMaterial']>(),
    };
    for (const material of [
      {},
      { a2: 'aa', d2: 'bb', d2Key: 'x'.repeat(32) },
      { a2: 'aa'.repeat(9000), d2: 'bb', d2Key: 'cc'.repeat(16) },
    ]) {
      nt.scanSessionMaterial.mockResolvedValueOnce(material);
      await expect(readOwnSessionMaterial(nt)).rejects.toThrow(/尚未就绪/);
    }
  });
});
