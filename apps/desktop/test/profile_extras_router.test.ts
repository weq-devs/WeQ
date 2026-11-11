// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ProfileExtrasService } from '@weq/service';
import {
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
} from '@weq/protocol';
import { createProfileExtrasRouter } from '../src/main/ipc/routers/profile_extras';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source', uin: '10002' };
function fixture() {
  const energy = vi.fn(async () => ({
    targetUin: '10002',
    score: 0,
    level: null,
    display: null,
    trend: null,
  }));
  const service = new ProfileExtrasService({ sendPacket: vi.fn() }, '10001', () => 5, {
    getProfileEnergy: energy,
    getSignatureHistory,
    getPersonalityLabels,
    getPersonalityPhotos,
    getAnonymousQuestions,
    getEducationHistory: vi.fn(async (_nt, _pid, targetUin) => ({ targetUin, items: [] })),
  });
  let active = { profileExtras: service };
  const routes = createProfileExtrasRouter((input) => {
    if (
      input.expectedAccountUin !== binding.expectedAccountUin ||
      input.expectedAccountConfigId !== binding.expectedAccountConfigId
    )
      throw new Error('账号不匹配');
    return active;
  });
  return {
    caller: routes.createCaller({}),
    energy,
    switchSource: () => {
      active = { profileExtras: service };
    },
  };
}
it('只读路由保留零值并绑定目标', async () => {
  const { caller } = fixture();
  expect(await caller.energy(binding)).toMatchObject({ targetUin: '10002', score: 0 });
});
it('错误账号与数据源在发包前拒绝', async () => {
  const { caller, energy } = fixture();
  await expect(caller.energy({ ...binding, expectedAccountConfigId: 'other' })).rejects.toThrow(
    '账号',
  );
  expect(energy).not.toHaveBeenCalled();
});
it('返回目标不匹配拒绝', async () => {
  const { caller } = fixture();
  await expect(caller.energy({ ...binding, uin: '10003' })).rejects.toThrow('目标');
});
it('异步期间切换数据源拒绝迟到结果', async () => {
  const { caller, energy, switchSource } = fixture();
  energy.mockImplementationOnce(async () => {
    switchSource();
    return { targetUin: '10002', score: 0, level: null, display: null, trend: null };
  });
  await expect(caller.energy(binding)).rejects.toThrow('变化');
});
it('教育经历只读路由可查询当前目标，账号不匹配时拒绝', async () => {
  const { caller } = fixture();
  expect(await caller.educationHistory(binding)).toEqual({ targetUin: '10002', items: [] });
  await expect(
    caller.educationHistory({ ...binding, expectedAccountConfigId: 'other' }),
  ).rejects.toThrow('账号');
});
