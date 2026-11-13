import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSelfProfileDisplaySettings,
  setSelfProfileDisplaySetting,
  LegacyOidbRejectedError,
  type ProfileDisplayField,
} from '@weq/protocol';
import { SelfProfileDisplayService } from '../src/account/profile_display';

vi.mock('@weq/protocol', async (original) => ({
  ...(await original<typeof import('@weq/protocol')>()),
  getSelfProfileDisplaySettings: vi.fn(),
  setSelfProfileDisplaySetting: vi.fn(),
}));
const read = vi.mocked(getSelfProfileDisplaySettings);
const write = vi.mocked(setSelfProfileDisplaySetting);
function value(field: ProfileDisplayField = 'gender', value = 0) {
  return { targetUin: '10002', settings: [{ field, raw: value, value, status: 'known' as const }] };
}
function fixture() {
  let pid = 7;
  return {
    service: new SelfProfileDisplayService({ sendPacket: vi.fn() }, '10002', () => pid),
    change: () => {
      pid = 8;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('自己的资料展示写入编排', () => {
  it('单项写入并独立读回一致后才确认', async () => {
    read.mockResolvedValueOnce(value()).mockResolvedValueOnce(value('gender', 2));
    const result = await fixture().service.set('gender', 2);
    expect(result.state).toBe('confirmed');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.anything(), 7, '10002', 'gender', 2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(expect.anything(), 7, '10002', ['gender']);
  });
  it('相同值不写入，未知及未返回不擅自覆盖', async () => {
    read.mockResolvedValueOnce(value());
    expect((await fixture().service.set('gender', 0)).state).toBe('unchanged');
    read.mockResolvedValueOnce({
      targetUin: '10002',
      settings: [{ field: 'gender', raw: null, value: null, status: 'missing' }],
    });
    expect((await fixture().service.set('gender', 2)).state).toBe('failed');
    expect(write).not.toHaveBeenCalled();
  });
  it('服务器拒绝和无法确认区分，不重发写请求', async () => {
    read.mockResolvedValue(value());
    write.mockRejectedValueOnce(new LegacyOidbRejectedError(151));
    expect((await fixture().service.set('gender', 1)).state).toBe('failed');
    expect(read).toHaveBeenCalledTimes(1);
    write.mockRejectedValueOnce(new Error('timeout'));
    const pending = fixture().service.set('gender', 1);
    await vi.runAllTimersAsync();
    expect((await pending).state).toBe('unconfirmed');
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('回包成功但读回不同，返回实际状态而不是选择值', async () => {
    read.mockResolvedValue(value());
    const pending = fixture().service.set('gender', 2);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ state: 'mismatch', setting: { value: 0 } });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('提交后传输错误仍可由真实读回确认', async () => {
    read.mockResolvedValueOnce(value()).mockResolvedValueOnce(value('gender', 1));
    write.mockRejectedValueOnce(new Error('timeout'));
    expect((await fixture().service.set('gender', 1)).state).toBe('confirmed');
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('同字段在途拒绝重复保存，其他字段可继续', async () => {
    let release!: () => void;
    read.mockImplementation(async (_nt, _pid, _uin, selected) => {
      const field = selected?.[0] ?? 'gender';
      return value(field, write.mock.calls.some((call) => call[3] === field) ? 1 : 0);
    });
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { service } = fixture();
    const first = service.set('gender', 1);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await expect(service.set('gender', 2)).rejects.toThrow('正在保存');
    expect((await service.set('age', 1)).state).toBe('confirmed');
    release();
    expect((await first).state).toBe('confirmed');
  });
  it('连接变更在写入之前终止，非法参数不触网', async () => {
    const f = fixture();
    read.mockImplementationOnce(async () => {
      f.change();
      return value();
    });
    await expect(f.service.set('gender', 1)).rejects.toThrow('连接已变化');
    await expect(f.service.set('gender', 9)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
