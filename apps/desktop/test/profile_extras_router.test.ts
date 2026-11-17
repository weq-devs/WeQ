// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ProfileExtrasService } from '@weq/service';
import {
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
} from '@weqbot/protocol';
import { createProfileExtrasRouter } from '../src/main/ipc/routers/profile_extras';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source', uin: '10002' };
function fixture() {
  const details = vi.fn(async (_nt, _pid, targetUin: string) => ({
    targetUin,
    company: '',
    personalDescription: null,
    email: null,
    errors: {},
  }));
  const energy = vi.fn(async () => ({
    targetUin: '10002',
    score: 0,
    level: null,
    display: null,
    trend: null,
  }));
  const service = new ProfileExtrasService(
    { sendPacket: vi.fn(), sendOidbPacket: vi.fn() },
    '10001',
    () => 5,
    {
      getProfileEnergy: energy,
      getSignatureHistory,
      getPersonalityLabels,
      getPersonalityPhotos,
      getAnonymousQuestions,
      getEducationHistory: vi.fn(async (_nt, _pid, targetUin) => ({ targetUin, items: [] })),
      getProfileDetails: details,
      getProfileRegion: async (_nt, _pid, targetUin) => ({
        targetUin,
        region: ['1', '51', '1'],
        regionText: '中国 · 四川 · 成都',
      }),
      getProfileSimilarity: async (_nt, _pid, _self, targetUin) => ({ targetUin, items: [] }),
    },
  );
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
    procedures: routes._def.procedures,
    energy,
    details,
    switchSource: () => {
      active = { profileExtras: service };
    },
  };
}
it('已撤下的勋章墙不保留可调用路由', () => {
  expect(fixture().procedures).not.toHaveProperty('medalWall');
});
it('只读路由保留零值并绑定目标', async () => {
  const { caller } = fixture();
  expect(await caller.energy(binding)).toMatchObject({ targetUin: '10002', score: 0 });
});
it('所在地补全也绑定账号与数据源，不把家乡作为所在地返回', async () => {
  const { caller } = fixture();
  expect(await caller.region(binding)).toMatchObject({
    targetUin: binding.uin,
    regionText: '中国 · 四川 · 成都',
  });
  await expect(caller.region({ ...binding, expectedAccountConfigId: 'other' })).rejects.toThrow(
    '账号',
  );
});
it('共同点入口沿用账号来源绑定，空共同点有效', async () => {
  const { caller } = fixture();
  expect(await caller.similarity(binding)).toEqual({ targetUin: binding.uin, items: [] });
  await expect(caller.similarity({ ...binding, expectedAccountConfigId: 'other' })).rejects.toThrow(
    '账号',
  );
  await expect(caller.similarity({ ...binding, expectedAccountUin: '10009' })).rejects.toThrow(
    '账号',
  );
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
it('详细资料绑定账号与目标，保留明确空字符串', async () => {
  const { caller, details } = fixture();
  expect(await caller.details(binding)).toEqual({
    targetUin: '10002',
    company: '',
    personalDescription: null,
    email: null,
    errors: {},
  });
  await expect(caller.details({ ...binding, expectedAccountConfigId: 'other' })).rejects.toThrow(
    '账号',
  );
  details.mockImplementationOnce(async () => ({
    targetUin: '10003',
    company: '',
    personalDescription: null,
    email: null,
    errors: {},
  }));
  await expect(caller.details(binding)).rejects.toThrow('目标');
});
it('详细资料读取过程中更换数据源，迟到数据不进入新页面', async () => {
  const { caller, details, switchSource } = fixture();
  details.mockImplementationOnce(async () => {
    switchSource();
    return { targetUin: '10002', company: '', personalDescription: null, email: null, errors: {} };
  });
  await expect(caller.details(binding)).rejects.toThrow('变化');
});
