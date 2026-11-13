import { expect, it, vi } from 'vitest';
import { createContactMetricsRouter } from '../src/main/ipc/routers/contact_metrics';
import type { ContactDirectoryRuntime } from '../src/main/context/contact_metrics';

it('项目历史接口保留账号和数据源绑定，转交项目、成员及游标', async () => {
  const fieldSummary = vi.fn(async () => ({ fields: ['card'], pending: false }));
  const fieldVersions = vi.fn(async () => ({ rows: [], nextBefore: null }));
  const resolve = vi.fn(
    (input: { expectedAccountUin: string; expectedAccountConfigId: string }) => {
      if (input.expectedAccountConfigId !== 'source') throw new Error('账号数据源已切换');
      return { history: { fieldSummary, fieldVersions } } as unknown as ContactDirectoryRuntime;
    },
  );
  const api = createContactMetricsRouter(resolve).createCaller({});
  const input = {
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source',
    entity: 'group:10003',
    memberUid: 'u_peer',
  };
  await expect(api.history.fieldSummary(input)).resolves.toEqual({
    fields: ['card'],
    pending: false,
  });
  expect(fieldSummary).toHaveBeenLastCalledWith('group:10003', 'u_peer');
  await api.history.fieldVersions({ ...input, field: 'card', before: 9, limit: 10 });
  expect(fieldVersions).toHaveBeenLastCalledWith('group:10003', 'card', 'u_peer', 9, 10);
  await expect(
    api.history.fieldSummary({ ...input, expectedAccountConfigId: 'old' }),
  ).rejects.toThrow('数据源已切换');
  expect(fieldSummary).toHaveBeenCalledTimes(1);
});
it('拒绝无绑定、非法身份和不合法的项目名', async () => {
  const resolve = vi.fn(() => ({}) as ContactDirectoryRuntime);
  const api = createContactMetricsRouter(resolve).createCaller({});
  await expect(api.history.fieldSummary({ entity: 'friend:u_peer' } as never)).rejects.toThrow();
  await expect(
    api.history.fieldVersions({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source',
      entity: 'group:123',
      field: 'card;DROP TABLE versions',
    }),
  ).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});
