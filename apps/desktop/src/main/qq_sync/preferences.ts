import type { AppContext } from '../context/app_context';

export function readAccountQqSync(ctx: AppContext) {
  const config = ctx.bootstrap?.userConfig;
  const fallback = {
    enabled: config?.getSetting('qqClientSyncEnabled') ?? false,
    liveMessages: config?.getSetting('qqLiveMessagesEnabled') ?? false,
  };
  return ctx.services?.accountConfig.getQqSyncPreferences(fallback) ?? fallback;
}
