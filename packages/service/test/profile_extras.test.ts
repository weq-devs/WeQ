import { expect, it, vi } from 'vitest';
import {
  getProfileEnergy,
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
} from '@weq/protocol';
import { ProfileExtrasService } from '../src/account/profile_extras';

const readers = {
  getProfileEnergy,
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
};
const nt = { sendPacket: vi.fn() };
it('同一目标和游标共享在途查询，不对不同目标复用结果', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async (_nt, _pid, uin: string) => {
    await wait;
    return { targetUin: uin, score: 0, level: null, display: null, trend: null };
  });
  const service = new ProfileExtrasService(nt, '10001', () => 5, {
    ...readers,
    getProfileEnergy: read,
  });
  const a = service.energy('10002');
  const b = service.energy('10002');
  const c = service.energy('10003');
  expect(read).toHaveBeenCalledTimes(2);
  release();
  expect((await a).targetUin).toBe('10002');
  expect(await b).toEqual(await a);
  expect((await c).targetUin).toBe('10003');
});
it('进程变更后丢弃迟到结果', async () => {
  let pid = 5;
  const service = new ProfileExtrasService(nt, '10001', () => pid, {
    ...readers,
    getProfileEnergy: async () => {
      pid = 6;
      return { targetUin: '10002', score: 1, level: null, display: null, trend: null };
    },
  });
  await expect(service.energy('10002')).rejects.toThrow('切换');
});
it('切账号抛错不会返回旧账号数据', async () => {
  let current = true;
  const service = new ProfileExtrasService(
    nt,
    '10001',
    () => {
      if (!current) throw new Error('账号已切换');
      return 5;
    },
    {
      ...readers,
      getProfileEnergy: async () => {
        current = false;
        return { targetUin: '10002', score: 1, level: null, display: null, trend: null };
      },
    },
  );
  await expect(service.energy('10002')).rejects.toThrow('切换');
});
it('他人强制已回答，自己的筛选保持不变', async () => {
  const read = vi.fn(async (_nt, _pid, uin: string) => ({
    targetUin: uin,
    items: [],
    nextCursor: null,
    hasMore: false,
    paginationError: null,
  }));
  const service = new ProfileExtrasService(nt, '10001', () => 5, {
    ...readers,
    getAnonymousQuestions: read,
  });
  await service.anonymousQuestions('10002', 'all', 'cursor');
  expect(read).toHaveBeenLastCalledWith(nt, 5, '10002', 'answered', 'cursor');
  await service.anonymousQuestions('10001', 'all');
  expect(read).toHaveBeenLastCalledWith(nt, 5, '10001', 'all', undefined);
});
it('一项读取失败不影响另一项；失败可以重试', async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('离线'))
    .mockResolvedValue({ targetUin: '10002', score: 2, level: null, display: null, trend: null });
  const labels = vi.fn(async () => ({
    targetUin: '10002',
    labels: [],
    totalPhotos: 0,
    closed: false,
  }));
  const service = new ProfileExtrasService(nt, '10001', () => 5, {
    ...readers,
    getProfileEnergy: read,
    getPersonalityLabels: labels,
  });
  await expect(service.energy('10002')).rejects.toThrow('离线');
  expect(await service.personalityLabels('10002')).toMatchObject({ labels: [] });
  expect((await service.energy('10002')).score).toBe(2);
});
