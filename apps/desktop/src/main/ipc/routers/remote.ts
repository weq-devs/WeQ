import { TRPCError } from '@trpc/server';
import { z } from 'zod/v3';
import { getHost } from '@weq/service';
import { remoteRuntime } from '../../remote/runtime';
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import {
  remoteInviteInput,
  remoteConnectionMode,
  remotePairingDecisionInput,
} from '../../../shared/remote_bootstrap';
import {
  desktopServiceCommand,
  desktopWebStatus,
  desktopWebToken,
  setDesktopWebAutoStart,
  setDesktopWebEnabled,
} from '../../desktop_services/host';

// Web 服务的 ctx.authorize 不能变成本机管理权限；网络端只挂专用最小 HTTP API。
const local = procedure.use(({ ctx, next }) => {
  if (ctx.authorize)
    throw new TRPCError({ code: 'FORBIDDEN', message: '仅允许桌面端管理远程连接。' });
  return next();
});

function savedRemoteAccounts() {
  return desktopServiceCommand<
    { configId: string; uin: string; displayName: string; static: boolean }[]
  >('remote.accounts', undefined, () => []);
}

export const remoteRouter = router({
  webStatus: local.query(() => desktopWebStatus()),
  setWebEnabled: local
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => setDesktopWebEnabled(input.enabled)),
  setWebAutoStart: local
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => setDesktopWebAutoStart(input.enabled)),
  webToken: local.mutation(() => desktopWebToken()),
  status: local.query(() =>
    desktopServiceCommand('remote.status', undefined, () => remoteRuntime.status()),
  ),
  setEnabled: local.input(z.object({ enabled: z.boolean() })).mutation(({ input }) =>
    desktopServiceCommand(
      'remote.enabled',
      {
        enabled: input.enabled,
        configId: getAppContext().services?.accountConfig.getConfigId() ?? null,
      },
      async () => {
        if (input.enabled) await remoteRuntime.start();
        else remoteRuntime.stop(true);
        return remoteRuntime.status();
      },
    ),
  ),
  setMode: local
    .input(z.object({ mode: remoteConnectionMode }))
    .mutation(({ input }) =>
      desktopServiceCommand('remote.mode', input.mode, () => remoteRuntime.setMode(input.mode)),
    ),
  setTailscaleEnabled: local.input(z.object({ enabled: z.boolean() })).mutation(({ input }) =>
    desktopServiceCommand('remote.tailscale', input.enabled, async () => {
      await remoteRuntime.setTailscaleEnabled(input.enabled);
      return remoteRuntime.status();
    }),
  ),
  changeNetwork: local.mutation(() =>
    desktopServiceCommand('remote.changeNetwork', undefined, () => remoteRuntime.changeNetwork()),
  ),
  refreshNetwork: local.mutation(() =>
    desktopServiceCommand('remote.refreshNetwork', undefined, () => remoteRuntime.refreshNetwork()),
  ),
  openLogin: local.mutation(async () => {
    const status = await desktopServiceCommand('remote.status', undefined, () =>
      remoteRuntime.status(),
    );
    const url = status.network.authUrl;
    if (!url || new URL(url).protocol !== 'https:') throw new Error('当前没有可用的网络登录链接。');
    await getHost().openExternal(url);
  }),
  invite: local
    .input(remoteInviteInput)
    .mutation(({ input }) =>
      desktopServiceCommand('remote.invite', input, () => remoteRuntime.invite(input)),
    ),
  decide: local
    .input(remotePairingDecisionInput)
    .mutation(({ input }) =>
      desktopServiceCommand('remote.decide', input, () =>
        remoteRuntime.pairing.decide(input.id, input.approve, input.configIds),
      ),
    ),
  revoke: local
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) =>
      desktopServiceCommand('remote.revoke', input.id, () =>
        remoteRuntime.pairing.revoke(input.id),
      ),
    ),
  accounts: local.query(() => savedRemoteAccounts()),
  pairingAccounts: local.query(async () => {
    const accounts = await savedRemoteAccounts();
    const currentConfigId = getAppContext().services?.accountConfig.getConfigId() ?? null;
    return { accounts, currentConfigId };
  }),
  setAccountConfigIds: local
    .input(z.object({ id: z.string().uuid(), configIds: z.array(z.string()).max(256) }))
    .mutation(({ input }) =>
      desktopServiceCommand('remote.accountConfigIds', input, () =>
        remoteRuntime.pairing.setAccountConfigIds(input.id, input.configIds),
      ),
    ),
});
