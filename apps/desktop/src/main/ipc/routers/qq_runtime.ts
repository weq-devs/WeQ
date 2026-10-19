import { z } from 'zod';
import {
  getAppContext,
  requireAttachEnabled,
  requireBootstrap,
  requirePlatform,
} from '../../context/app_context';
import { procedure, router } from '../trpc';
import { getHost } from '@weq/service';
import { dirname } from 'node:path';

const instance = z.object({ expectedInstanceId: z.string().min(1).nullable() });
function runtimeFor(expectedInstanceId?: string | null) {
  const runtime = getAppContext().qqRuntime;
  if (!runtime) throw new Error('QQ 运行时尚未就绪');
  if (expectedInstanceId !== undefined && runtime.snapshot().instanceId !== expectedInstanceId)
    throw new Error('QQ 运行时已切换，请刷新后重试');
  return runtime;
}
export const qqRuntimeRouter = router({
  status: procedure.query(async () => {
    const ctx = getAppContext(),
      runtime = runtimeFor();
    if (runtime.snapshot().mode === 'external') await runtime.refreshExternal();
    const settings = requireBootstrap().userConfig.getSettings();
    return {
      supported: process.platform === 'darwin' && getHost().canReveal,
      enabled: settings.autoAttachQq,
      closeBehavior: settings.windowCloseBehavior,
      state: runtime.snapshot(),
      openedUin: ctx.account?.context.uin ?? null,
      openedInstanceId: ctx.managedQQ?.instanceId ?? null,
      openedConfigId: ctx.managedQQ
        ? (ctx.services?.accountConfig.getRecord()?.configId ?? null)
        : null,
    };
  }),
  start: procedure
    .input(
      instance.extend({
        uin: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireAttachEnabled();
      if (process.platform !== 'darwin' || !getHost().canReveal)
        throw new Error('托管 QQ 目前只支持 macOS 桌面版');
      const ctx = getAppContext(),
        runtime = runtimeFor(input.expectedInstanceId);
      if (ctx.account) throw new Error('请先关闭当前账号，再启动托管 QQ');
      if (['starting', 'stopping'].includes(runtime.snapshot().phase))
        throw new Error('QQ 运行时正在切换，请稍后重试');
      const saved = input.expectedAccountConfigId
        ? requireBootstrap()
            .userConfig.listAccountConfigs()
            .find((record) => record.configId === input.expectedAccountConfigId)
        : null;
      if (
        input.expectedAccountConfigId &&
        (!saved?.managed || !saved.dataDir || (input.uin && saved.uin !== input.uin))
      )
        throw new Error('托管账号配置已变化，请重新选择');
      ctx.managedStartConfigId = saved?.configId ?? null;
      return runtime.startManaged(saved?.uin ?? input.uin);
    }),
  setAutoEnter: procedure.input(instance.extend({ enabled: z.boolean() })).mutation(({ input }) => {
    const ctx = getAppContext(),
      runtime = runtimeFor(input.expectedInstanceId),
      state = runtime.snapshot();
    const record = ctx.services?.accountConfig.getRecord();
    if (
      state.mode !== 'managed' ||
      !state.owned ||
      !state.capabilities.database ||
      ctx.managedQQ?.instanceId !== state.instanceId ||
      !record?.managed ||
      ctx.account?.context.uin !== state.account?.uin ||
      record.uin !== state.account?.uin
    )
      throw new Error('托管账号尚未就绪或已切换');
    const config = requireBootstrap().userConfig;
    if (input.enabled)
      config.setAutoEnter({
        configId: record.configId,
        uin: record.uin,
        ...(record.dataDir ? { dataDir: record.dataDir } : {}),
      });
    else if (config.getAutoEnter()?.configId === record.configId) config.clearAutoEnter();
    return true;
  }),
  refreshQr: procedure.input(instance).mutation(async ({ input }) => {
    requireAttachEnabled();
    await runtimeFor(input.expectedInstanceId).refreshQr();
  }),
  stop: procedure
    .input(instance.extend({ closeAccount: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const ctx = getAppContext(),
        runtime = runtimeFor(input.expectedInstanceId);
      await runtime.stop();
      if (input.closeAccount && ctx.managedQQ?.instanceId === input.expectedInstanceId)
        ctx.clearAccount();
      return runtime.snapshot();
    }),
  openOfficial: procedure.input(instance).mutation(async ({ input }) => {
    runtimeFor(input.expectedInstanceId);
    const exe = requirePlatform().qqExePath();
    if (!exe) throw new Error('未找到 QQ 安装');
    await getHost().revealPath(
      process.platform === 'darwin' ? dirname(dirname(dirname(exe))) : exe,
    );
  }),
});
