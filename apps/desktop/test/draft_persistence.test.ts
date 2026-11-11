import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  saveCopy: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  accountBinding: () => rpc.binding,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { clientState: { saveDraft: { mutate: rpc.saveCopy } } },
}));
import {
  openDraftCopies,
  resolveDraftSave,
  useDraftCopies,
} from '../src/renderer/src/lib/draftPersistence';

beforeEach(() => {
  vi.resetAllMocks();
  rpc.binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
  useDraftCopies.setState({ copiesCount: 0, copiesOpen: 0 });
  rpc.saveCopy.mockResolvedValue({ ok: true });
});

describe('草稿自动保存与副本', () => {
  it('副本状态仅记录数量与主动打开次数，不再维护选稿请求', () => {
    expect(useDraftCopies.getState()).toEqual({ copiesCount: 0, copiesOpen: 0 });
    openDraftCopies();
    expect(useDraftCopies.getState()).toEqual({ copiesCount: 0, copiesOpen: 1 });
  });
  it.each(['chat:c2c:fixture', 'assistant:fixture', 'composition:fixture'])(
    '不同共享稿先存副本再继续保存，不弹选择框：%s',
    async (key) => {
      const remote = { version: 'remote', value: ['另一端正文'] };
      const save = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, current: remote })
        .mockImplementationOnce(async () => {
          expect(rpc.saveCopy).toHaveBeenCalledWith(
            expect.objectContaining({
              ...rpc.binding,
              key: expect.stringMatching(/^copy:/),
              expectedVersion: null,
              value: expect.objectContaining({ source: key, content: remote.value }),
            }),
          );
          return { ok: true, current: { version: 'saved', value: ['本机正文'] } };
        });
      const pending = resolveDraftSave(key, ['本机正文'], 'old', save);
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      await expect(pending).resolves.toMatchObject({ local: true, current: { version: 'saved' } });
      expect(save.mock.calls).toEqual([['old'], ['remote']]);
      expect(useDraftCopies.getState()).toEqual({ copiesCount: 0, copiesOpen: 0 });
    },
  );

  it('共享稿已是本机内容时直接确认成功，不额外写副本', async () => {
    const current = { version: 'new', value: ['相同正文'] };
    const pending = resolveDraftSave('chat:group:fixture', current.value, 'old', async () => ({
      ok: false,
      current,
    }));
    await expect(pending).resolves.toEqual({ current, local: true });
    expect(rpc.saveCopy).not.toHaveBeenCalled();
  });

  it('空元素与已清空的共享稿等价，不误报冲突', async () => {
    const current = { version: 'cleared', value: null };
    await expect(
      resolveDraftSave('chat:group:fixture', [], 'old', async () => ({ ok: false, current })),
    ).resolves.toEqual({ current, local: true });
    expect(rpc.saveCopy).not.toHaveBeenCalled();
  });

  it('同一共享版本重复返回时只保留一份副本', async () => {
    const current = { version: 'remote', value: '共享稿' };
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, current })
      .mockResolvedValueOnce({ ok: false, current })
      .mockResolvedValueOnce({ ok: true, current: { version: 'saved', value: '本机稿' } });
    await resolveDraftSave('chat:c2c:fixture', '本机稿', 'old', save);
    expect(rpc.saveCopy).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('同端并发保存接续已确认版本，不把自己的编辑当冲突', async () => {
    let finish!: (result: { ok: boolean; current: { version: string; value: string } }) => void;
    const firstSave = vi.fn(
      () =>
        new Promise<{ ok: boolean; current: { version: string; value: string } }>((resolve) => {
          finish = resolve;
        }),
    );
    const secondSave = vi.fn(async () => ({
      ok: true,
      current: { version: 'v2', value: '第二稿' },
    }));
    const first = resolveDraftSave('chat:c2c:fixture', '第一稿', 'v0', firstSave);
    const second = resolveDraftSave('chat:c2c:fixture', '第二稿', 'v0', secondSave);
    await vi.waitFor(() => expect(firstSave).toHaveBeenCalledOnce());
    expect(secondSave).not.toHaveBeenCalled();
    finish({ ok: true, current: { version: 'v1', value: '第一稿' } });
    await Promise.all([first, second]);
    expect(secondSave).toHaveBeenCalledWith('v1');
    expect(rpc.saveCopy).not.toHaveBeenCalled();
  });

  it('连续版本变化超过三次也自动继续，不要求用户重试', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, current: { version: 'v1', value: '一' } })
      .mockResolvedValueOnce({ ok: false, current: { version: 'v2', value: '二' } })
      .mockResolvedValueOnce({ ok: false, current: { version: 'v3', value: '三' } })
      .mockResolvedValueOnce({ ok: false, current: { version: 'v4', value: '四' } })
      .mockResolvedValueOnce({ ok: true, current: { version: 'v5', value: '本机稿' } });
    await expect(resolveDraftSave('chat:c2c:fixture', '本机稿', 'v0', save)).resolves.toMatchObject(
      { local: true },
    );
    expect(save).toHaveBeenCalledTimes(5);
    expect(rpc.saveCopy).toHaveBeenCalledTimes(4);
    expect(useDraftCopies.getState()).toEqual({ copiesCount: 0, copiesOpen: 0 });
  });

  it('副本保存失败不覆盖共享稿，原样向上报告保存错误', async () => {
    rpc.saveCopy.mockRejectedValueOnce(new Error('disk full'));
    const save = vi
      .fn()
      .mockResolvedValue({ ok: false, current: { version: 'new', value: ['共享稿'] } });
    const pending = resolveDraftSave('chat:c2c:fixture', ['本机稿'], 'old', save);
    const assertion = expect(pending).rejects.toThrow('disk full');
    await vi.waitFor(() => expect(rpc.saveCopy).toHaveBeenCalledOnce());
    await assertion;
    expect(save).toHaveBeenCalledOnce();
  });

  it('复制期间切换账号不继续覆盖原账号草稿', async () => {
    rpc.saveCopy.mockImplementationOnce(async () => {
      rpc.binding = { expectedAccountUin: '10002', expectedAccountConfigId: 'other' };
      return { ok: true };
    });
    const save = vi
      .fn()
      .mockResolvedValue({ ok: false, current: { version: 'new', value: ['共享稿'] } });
    const pending = resolveDraftSave('chat:c2c:fixture', ['本机稿'], 'old', save);
    const assertion = expect(pending).rejects.toThrow('账号已切换');
    await vi.waitFor(() => expect(rpc.saveCopy).toHaveBeenCalledOnce());
    await assertion;
    expect(save).toHaveBeenCalledOnce();
  });
});
