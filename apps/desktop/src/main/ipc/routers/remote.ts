import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getHost } from '@weq/service';
import { remoteRuntime } from '../../remote/runtime';
import { procedure, router } from '../trpc';
import { remoteInviteInput, remoteConnectionMode } from '../../../shared/remote_bootstrap';
import { desktopWebRuntime } from '../../web/runtime';

// Web 服务的 ctx.authorize 不能变成本机管理权限；网络端只挂专用最小 HTTP API。
const local = procedure.use(({ ctx, next }) => {
  if (ctx.authorize)
    throw new TRPCError({ code: 'FORBIDDEN', message: '仅允许桌面端管理远程连接。' });
  return next();
});

export const remoteRouter = router({
  webStatus: local.query(() => desktopWebRuntime.status()),
  setWebEnabled: local.input(z.object({ enabled: z.boolean() })).mutation(async ({ input }) => {
    if (input.enabled) await desktopWebRuntime.start();
    else desktopWebRuntime.stop();
    return desktopWebRuntime.status();
  }),
  setWebAutoStart: local.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    desktopWebRuntime.setAutoStart(input.enabled);
    return desktopWebRuntime.status();
  }),
  webToken: local.mutation(() => desktopWebRuntime.accessToken()),
  status: local.query(() => remoteRuntime.status()),
  setEnabled: local.input(z.object({ enabled: z.boolean() })).mutation(async ({ input }) => {
    if (input.enabled) await remoteRuntime.start();
    else remoteRuntime.stop(true);
    return remoteRuntime.status();
  }),
  setMode: local
    .input(z.object({ mode: remoteConnectionMode }))
    .mutation(async ({ input }) => remoteRuntime.setMode(input.mode)),
  changeNetwork: local.mutation(() => remoteRuntime.changeNetwork()),
  refreshNetwork: local.mutation(() => remoteRuntime.refreshNetwork()),
  openLogin: local.mutation(async () => {
    const url = remoteRuntime.status().network.authUrl;
    if (!url || new URL(url).protocol !== 'https:') throw new Error('当前没有可用的网络登录链接。');
    await getHost().openExternal(url);
  }),
  invite: local.input(remoteInviteInput).mutation(({ input }) => remoteRuntime.invite(input)),
  decide: local
    .input(z.object({ id: z.string().uuid(), approve: z.boolean() }))
    .mutation(({ input }) => {
      remoteRuntime.pairing.decide(input.id, input.approve);
    }),
  revoke: local.input(z.object({ id: z.string().uuid() })).mutation(({ input }) => {
    remoteRuntime.pairing.revoke(input.id);
  }),
});
