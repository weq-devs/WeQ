import { z } from 'zod';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_INTENT_SENSE_CONFIG,
  mergeAssistantConfig,
} from '@weq/service';
import {
  DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
  mailPollIntervalMinutes,
} from '@weq/service/mail-wire';
import {
  APP_SETTING_FIELDS,
  CLIENT_SETTING_FIELDS,
  INTENT_SETTING_FIELDS,
  SETTINGS_FIELDS,
  settingsDefaults,
} from '@weq/service/settings-catalog';
import { procedure, router, type RpcContext } from '../trpc';
import { getAppContext } from '../../context/app_context';
import { bootstrapRouter } from './bootstrap';
import { remoteRouter } from './remote';
import { updateRouter } from './update';
import { sharedSettingsRouter, sharedMailPreferences } from './shared_settings';
import { sharedIntentStatus } from './intent_sense';
import { sharedAntiRecallStatus } from './anti_recall';
import { clientStateRouter } from './client_state';
import { dataSaverBehaviorDefaults } from '@weq/service/data-saver';
import { dataSaverSession } from '@weq/service/transfer-policy';
import { preferenceDefaults } from '@weq/service/client-preferences';
import { DEFAULT_MONITOR_SETTINGS, getPerformanceMonitor } from '@weq/service/performance';
import { TOAST_TIMED_KINDS } from '@weq/service/toast-settings';
import {
  remoteResetCardAvailable,
  remoteSettingAvailable,
} from '../../../shared/remote_capabilities';
import {
  SETTINGS_RESET_CARDS,
  resetCards,
  planSettingsReset,
  type SettingsResetCardId,
  type SettingsResetTarget,
  type SettingsResetItem,
  type SettingsResetResult,
} from '../../../shared/settings_reset';

const target = z
  .object({
    page: z.custom<SettingsResetTarget['page']>((v) => SETTINGS_RESET_CARDS.some(([p]) => p === v)),
    card: z
      .custom<SettingsResetCardId>((v) => SETTINGS_RESET_CARDS.some(([, c]) => c === v))
      .optional(),
  })
  .strict();
interface Entry extends SettingsResetItem {
  card: SettingsResetCardId;
  apply: () => Promise<unknown>;
  intentKey?: keyof typeof DEFAULT_INTENT_SENSE_CONFIG;
}
function identity() {
  const record = getAppContext().services?.accountConfig.getRecord();
  return record ? `${record.configId}:${record.dataDir}` : null;
}
async function entries(ctx: RpcContext, selected: Set<SettingsResetCardId>): Promise<Entry[]> {
  const context = getAppContext();
  const config = context.bootstrap?.userConfig;
  if (!config) throw new Error('配置尚未就绪');
  const current = config.getSettings();
  const defaults = settingsDefaults(DEFAULT_APP_SETTINGS);
  const b = bootstrapRouter.createCaller(ctx);
  const shared = sharedSettingsRouter.createCaller(ctx);
  const r = remoteRouter.createCaller(ctx);
  const appWriters = {
    notificationEvents: () => b.resetNotificationEvents(),
    home: () => b.setHomeSettings(defaults.home),
    contactCard: () => b.setContactCard(defaults.contactCard),
    startupPage: () => b.setStartupPage({ page: defaults.startupPage }),
    showWindowOnAutostart: () =>
      b.setShowWindowOnAutostart({ enabled: defaults.showWindowOnAutostart }),
    windowCloseBehavior: () => b.setWindowCloseBehavior({ behavior: defaults.windowCloseBehavior }),
    windowsStyleControls: () =>
      b.setWindowsStyleControls({ enabled: defaults.windowsStyleControls }),
    autoLockMinutes: () => b.setAutoLockMinutes({ minutes: defaults.autoLockMinutes }),
    showMessageUnreadBadge: () =>
      b.setShowMessageUnreadBadge({ enabled: defaults.showMessageUnreadBadge }),
    showContactUnreadCount: () =>
      b.setShowContactUnreadCount({ enabled: defaults.showContactUnreadCount }),
    showGroupAssistantMessageCount: () =>
      b.setShowGroupAssistantMessageCount({ enabled: defaults.showGroupAssistantMessageCount }),
    readFromFirstUnread: () => b.setReadFromFirstUnread({ enabled: defaults.readFromFirstUnread }),
    jumpToLatestAfterSend: () =>
      b.setJumpToLatestAfterSend({ enabled: defaults.jumpToLatestAfterSend }),
    autoFollowLatestMessages: () =>
      b.setAutoFollowLatestMessages({ enabled: defaults.autoFollowLatestMessages }),
    showScrollToBottomButton: () =>
      b.setShowScrollToBottomButton({ enabled: defaults.showScrollToBottomButton }),
    showMessageSeq: () => b.setShowMessageSeq({ enabled: defaults.showMessageSeq }),
    showMessageDate: () => b.setShowMessageDate({ enabled: defaults.showMessageDate }),
    showMessageTime: () => b.setShowMessageTime({ enabled: defaults.showMessageTime }),
    showAvatarPendant: () => b.setShowAvatarPendant({ enabled: defaults.showAvatarPendant }),
    showChatQqShow: () => b.setShowChatQqShow({ enabled: defaults.showChatQqShow }),
    qqShowCacheMinutes: () => b.setQqShowCacheMinutes({ minutes: defaults.qqShowCacheMinutes }),
    showMsgDecoration: () => b.setShowMsgDecoration({ enabled: defaults.showMsgDecoration }),
    showMessageBubble: () => b.setShowMessageBubble({ enabled: defaults.showMessageBubble }),
    showMessageFont: () => b.setShowMessageFont({ enabled: defaults.showMessageFont }),
    renderTextMarkdown: () => b.setRenderTextMarkdown({ enabled: defaults.renderTextMarkdown }),
    linkPreview: () => b.setLinkPreview(defaults.linkPreview),
    chatImageCacheMiB: () => b.setChatImageCacheMiB({ miB: defaults.chatImageCacheMiB }),
    sendWithQqFont: () => b.setSendWithQqFont({ enabled: defaults.sendWithQqFont }),
    callDisableP2P: () => b.setCallDisableP2P({ disabled: defaults.callDisableP2P }),
    qzonePersonClickAction: () =>
      b.setQzonePersonClickAction({ action: defaults.qzonePersonClickAction }),
    qzoneForwardQuotePrevious: () =>
      b.setQzoneForwardQuotePrevious({ enabled: defaults.qzoneForwardQuotePrevious }),
    qzonePagination: () => b.setQzonePagination(defaults.qzonePagination),
    qzonePublicRefreshCooldownMinutes: () =>
      b.setQzonePublicRefreshCooldown({ minutes: defaults.qzonePublicRefreshCooldownMinutes }),
    realtimeEnabled: () => b.setRealtimeEnabled({ enabled: defaults.realtimeEnabled }),
    autoAttachQq: () => b.setAutoAttachQq({ enabled: defaults.autoAttachQq }),
    restrictedModeIndicatorEnabled: () =>
      b.setRestrictedModeIndicatorEnabled({ enabled: defaults.restrictedModeIndicatorEnabled }),
    preferCdn: () => b.setPreferCdn({ enabled: defaults.preferCdn }),
    logRetentionDays: () => b.setLogRetentionDays({ days: defaults.logRetentionDays }),
    databaseReadConcurrency: () =>
      b.setDatabaseReadConcurrency({ concurrency: defaults.databaseReadConcurrency }),
    webServiceAutoStart: () => r.setWebAutoStart({ enabled: defaults.webServiceAutoStart }),
  } satisfies Record<(typeof APP_SETTING_FIELDS)[number]['key'], () => Promise<unknown>>;
  const out: Entry[] = [];
  const definitions = new Map(SETTINGS_FIELDS.map((spec) => [spec.id, spec]));
  function bind(
    id: string,
    current: unknown,
    defaultValue: unknown,
    apply: () => Promise<unknown>,
    instance?: { id: string; label: string },
  ) {
    const spec = definitions.get(id);
    if (!spec) throw new Error(`恢复适配器未登记：${id}`);
    if (
      !selected.has(spec.card) ||
      (ctx.authorize && spec.desktopOnly) ||
      (ctx.host?.remoteClient && spec.remoteUnsupported)
    )
      return;
    out.push({
      id: instance?.id ?? spec.id,
      label: instance?.label ?? spec.label,
      card: spec.card,
      scope: spec.scope,
      directory: spec.directory,
      stopsService: spec.stopsService,
      current,
      defaultValue,
      apply,
      ...(spec.source === 'intent'
        ? { intentKey: spec.key as keyof typeof DEFAULT_INTENT_SENSE_CONFIG }
        : {}),
    });
  }
  for (const spec of APP_SETTING_FIELDS)
    bind(spec.id, current[spec.key], defaults[spec.key], appWriters[spec.key]);

  for (const key of ['autoCheck', 'autoInstall'] as const) {
    bind(
      `${'enhancement-updates'}:${key}`,
      current.enhancementUpdates[key],
      defaults.enhancementUpdates[key],
      () => b.setEnhancementUpdates({ [key]: defaults.enhancementUpdates[key] }),
    );
  }

  if (!ctx.authorize)
    bind('startup-system:autostart', undefined, false, () => b.setAutostart({ enabled: false }));

  const readSync = (automatic: boolean, manual: boolean) =>
    automatic === manual ? automatic : automatic ? '仅自动阅读上报' : '仅手动标记上报';
  bind(
    'read-sync:enabled',
    readSync(current.reportReadEnabled, current.manualReadReportEnabled),
    readSync(defaults.reportReadEnabled, defaults.manualReadReportEnabled),
    () => b.setReadSyncEnabled({ enabled: defaults.reportReadEnabled }),
  );

  for (const kind of TOAST_TIMED_KINDS) {
    const key = `${kind}Seconds` as const;
    bind(`${'toast'}:${key}`, current.toastDurations[key], defaults.toastDurations[key], () =>
      b.setToastDuration({ kind, seconds: defaults.toastDurations[key] }),
    );
  }

  bind('app-lock:enabled', current.appLock.enabled, defaults.appLock.enabled, () =>
    b.setAppLockEnabled({ enabled: defaults.appLock.enabled }),
  );
  bind('app-lock:method', current.appLock.method, defaults.appLock.method, () =>
    b.setAppLockMethod({ method: defaults.appLock.method }),
  );

  const clientPreferences = config.getSharedPreference('client');
  for (const spec of CLIENT_SETTING_FIELDS)
    bind(
      spec.id,
      clientPreferences[spec.key] ?? preferenceDefaults[spec.key],
      preferenceDefaults[spec.key],
      () => clientStateRouter.createCaller(ctx).patch({ [spec.key]: preferenceDefaults[spec.key] }),
    );

  bind(
    'message-content:autoTranscribe',
    current.voiceTranscribe.autoTranscribe,
    defaults.voiceTranscribe.autoTranscribe,
    () => b.setAutoTranscribeVoice({ enabled: defaults.voiceTranscribe.autoTranscribe }),
  );

  bind('typing:mode', current.typingStatus.mode, defaults.typingStatus.mode, () =>
    b.setTypingStatusMode({ mode: defaults.typingStatus.mode }),
  );
  for (const key of ['mode', 'systemAudio', 'udpTrace'] as const) {
    const card = key === 'udpTrace' ? 'call-trace' : 'call-content';
    bind(`${card}:${key}`, current.callRecording[key], defaults.callRecording[key], () =>
      b.setCallRecording({ [key]: defaults.callRecording[key] }),
    );
  }
  bind('call-directory:dir', current.callRecording.dir, defaults.callRecording.dir, () =>
    b.setCallRecording({ dir: defaults.callRecording.dir }),
  );

  bind('api-default:model', current.agentLab.defaultModel, defaults.agentLab.defaultModel, () =>
    b.setAgentLabDefaultModel({ ref: defaults.agentLab.defaultModel }),
  );
  bind(
    'api-default:vision-model',
    current.agentLab.defaultVisionModel,
    defaults.agentLab.defaultVisionModel,
    () => b.setDefaultVisionModel({ ref: defaults.agentLab.defaultVisionModel }),
  );
  bind(
    'api-default:embedding-model',
    current.agentLab.defaultEmbeddingModel,
    defaults.agentLab.defaultEmbeddingModel,
    () => b.setDefaultEmbeddingModel({ ref: defaults.agentLab.defaultEmbeddingModel }),
  );
  bind(
    'api-default:context-window',
    current.agentLab.defaultContextWindowTokens,
    defaults.agentLab.defaultContextWindowTokens,
    () =>
      b.setAgentLabModelTokenDefaults({
        defaultContextWindowTokens: defaults.agentLab.defaultContextWindowTokens,
      }),
  );
  bind(
    'api-default:max-output',
    current.agentLab.defaultMaxOutputTokens,
    defaults.agentLab.defaultMaxOutputTokens,
    () =>
      b.setAgentLabModelTokenDefaults({
        defaultMaxOutputTokens: defaults.agentLab.defaultMaxOutputTokens,
      }),
  );
  if (selected.has('assistant-config')) {
    const assistant = shared.assistant;
    const defaultConfig = mergeAssistantConfig({}, {});
    const currentConfig = mergeAssistantConfig(await assistant.getConfig(), {});
    // 恢复预览只说明文本已配置，不回传可能含密钥的 MCP 配置。
    const previewConfig = ({
      customPrompt,
      mcpServers,
      modelSettingsVersion: _version,
      ...value
    }: typeof defaultConfig) => ({
      ...value,
      customPrompt: Boolean(customPrompt),
      mcpServers: Boolean(mcpServers),
    });
    bind(
      'assistant-config:config',
      previewConfig(currentConfig),
      previewConfig(defaultConfig),
      () => assistant.setConfig(defaultConfig),
    );
  }
  bind('assistant-images:mode', current.aiImages.assistant, defaults.aiImages.assistant, () =>
    b.setAiImagePreference({ feature: 'assistant', mode: defaults.aiImages.assistant }),
  );
  for (const [card, feature] of [
    ['intent-basic', 'intent'],
    ['suggestion-basic', 'suggestions'],
    ['profile-basic', 'profile'],
  ] as const)
    bind(`${card}:imageMode`, current.aiImages[feature], defaults.aiImages[feature], () =>
      b.setAiImagePreference({ feature, mode: defaults.aiImages[feature] }),
    );
  if (selected.has('performance-recording')) {
    const monitor = getPerformanceMonitor();
    await monitor.ready;
    bind('performance-recording:mode', monitor.settings.mode, DEFAULT_MONITOR_SETTINGS.mode, () =>
      monitor.resetRecordingMode(),
    );
  }
  for (const kind of ['voice', 'ocr'] as const) {
    const concurrency =
      kind === 'voice' ? current.voiceTranscribe.onlineConcurrency : current.ocr.onlineConcurrency;
    const value =
      kind === 'voice'
        ? defaults.voiceTranscribe.onlineConcurrency
        : defaults.ocr.onlineConcurrency;
    bind(`${`${kind}-online`}:${'concurrency'}`, concurrency, value, () =>
      b.setRecognitionConcurrency({ kind, concurrency: value }),
    );
  }

  bind('auto-enter:account', config.getAutoEnter(), null, () => b.clearAutoEnter());

  if (selected.has('data-saver')) {
    const temporary = dataSaverSession.status().temporary;
    bind(
      'data-saver:temporary',
      temporary ? (temporary.enabled ? '临时开启' : '临时关闭') : '无临时设置',
      '无临时设置',
      async () => dataSaverSession.clearTemporary('settings'),
    );
    const saverDefaults = {
      dataSaverMode: 'auto' as const,
      autoDownloadPreviewOriginal: false,
      ...dataSaverBehaviorDefaults,
    };
    const saverCurrent = config.getSharedPreference('client');
    bind(
      'data-saver:preferences',
      Object.fromEntries(
        Object.entries(saverDefaults).map(([key, value]) => [
          key,
          saverCurrent[key as keyof typeof saverDefaults] ?? value,
        ]),
      ),
      saverDefaults,
      () => clientStateRouter.createCaller(ctx).patch(saverDefaults),
    );
  }
  bind('rkey:enabled', current.externalRkey.enabledServerId, null, () =>
    b.setExternalRkeyEnabled({ serverId: null }),
  );
  bind('mcp:enabled', current.mcp.enabled, defaults.mcp.enabled, () =>
    b.setMcpEnabled({ enabled: defaults.mcp.enabled }),
  );
  // OneBot 配置现在是**按账号**的（`oneBotByUin`），全局「恢复默认」不该清掉
  // 某个账号的网络配置 —— 那是用户给那个号配的端口与令牌，跟着账号走才合理。
  // 只把「当前账号」的这一份重置成空网络列表。
  const currentUin = context.account?.context.uin;
  if (currentUin && current.oneBotByUin[currentUin]) {
    const empty = { networks: { wsServers: [], wsClients: [], httpServers: [], httpClients: [] } };
    bind(
      'onebot:config',
      JSON.stringify(current.oneBotByUin[currentUin]),
      JSON.stringify(empty),
      () => b.saveOneBotConfig({ config: empty }),
    );
  }
  bind('sse-targets:enabled', current.ssePush.enabledServerId, null, () =>
    b.setSsePushEnabled({ serverId: null }),
  );
  bind(
    'sse-tuning:tuning',
    { debounceMs: current.ssePush.debounceMs, massThreshold: current.ssePush.massThreshold },
    { debounceMs: defaults.ssePush.debounceMs, massThreshold: defaults.ssePush.massThreshold },
    () =>
      b.setSsePushTuning({
        debounceMs: defaults.ssePush.debounceMs,
        massThreshold: defaults.ssePush.massThreshold,
      }),
  );
  bind('assistant:enabled', current.weqAssistant.enabled, defaults.weqAssistant.enabled, () =>
    b.setWeqAssistantEnabled({ enabled: defaults.weqAssistant.enabled }),
  );

  if (!ctx.authorize) {
    const u = updateRouter.createCaller(ctx);
    bind('web:enabled', undefined, false, () => r.setWebEnabled({ enabled: false }));

    bind('remote:enabled', undefined, false, () => r.setEnabled({ enabled: false }));
    bind(
      'update:interval',
      current.updateCheckIntervalMinutes,
      defaults.updateCheckIntervalMinutes,
      () => u.setInterval({ minutes: defaults.updateCheckIntervalMinutes }),
    );
    bind('update:prerelease', current.updateCheckPrerelease, defaults.updateCheckPrerelease, () =>
      u.setPrerelease({ enabled: defaults.updateCheckPrerelease }),
    );
  }
  const services = context.services;
  {
    const intent = [...selected].some((card) => /^(intent|suggestion|profile)-/.test(card))
      ? sharedIntentStatus()
      : DEFAULT_INTENT_SENSE_CONFIG;

    for (const spec of INTENT_SETTING_FIELDS)
      bind(spec.id, intent[spec.key], DEFAULT_INTENT_SENSE_CONFIG[spec.key], () =>
        shared.intent.setConfig({
          [spec.key]: structuredClone(DEFAULT_INTENT_SENSE_CONFIG[spec.key]),
        }),
      );
    const record = services?.accountConfig.getRecord();
    if (record) {
      const selectedHidden = current.typingStatus.hidden.filter(
        (item) => item.accountUin === record.uin && item.accountConfigId === record.configId,
      );
      bind('typing:selection', selectedHidden, [], () =>
        b.setTypingStatusHidden({
          hidden: config
            .getSettings()
            .typingStatus.hidden.filter(
              (item) => item.accountUin !== record.uin || item.accountConfigId !== record.configId,
            ),
        }),
      );
    }
    const mail = sharedMailPreferences();
    bind('notification-badges:unread', mail.showUnread, true, async () => {
      await shared.mail.patch({ showUnread: true });
    });
    bind('mail:unread', mail.showUnread, true, async () => {
      await shared.mail.patch({ showUnread: true });
    });
    bind(
      'mail:poll-interval',
      mailPollIntervalMinutes(mail.pollIntervalMinutes),
      DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
      async () => {
        await shared.mail.patch({ pollIntervalMinutes: DEFAULT_MAIL_POLL_INTERVAL_MINUTES });
      },
    );
    if (selected.has('recall-scope') || selected.has('recall-notifications')) {
      const recall = await sharedAntiRecallStatus();
      bind('recall-scope:scope', recall.enabled ? recall.mode : 'off', 'off', async () =>
        shared.antiRecall.setScope({ scope: 'off' }),
      );
      if (services)
        bind('recall-scope:targets', recall.targets, [], async () =>
          services.antiRecall.setTargets([]),
        );
      if (services)
        bind('recall-notifications:notify-targets', recall.notifyTargets, [], async () =>
          services.antiRecall.setNotify({ targets: [] }),
        );
    }
  }
  bind(
    'external-chatpic:enabled',
    current.externalChatpic.enabled,
    defaults.externalChatpic.enabled,
    () =>
      b.setExternalChatpic({
        ...config.getSettings().externalChatpic,
        enabled: defaults.externalChatpic.enabled,
      }),
  );
  bind('external-chatpic:dir', current.externalChatpic.dir, defaults.externalChatpic.dir, () =>
    b.setExternalChatpic({
      ...config.getSettings().externalChatpic,
      dir: defaults.externalChatpic.dir,
    }),
  );
  bind('ocr-online:prefilter', current.ocr.prefilterEnabled, defaults.ocr.prefilterEnabled, () =>
    b.setOcrPrefilterEnabled({ enabled: defaults.ocr.prefilterEnabled }),
  );
  return out;
}

async function preview(ctx: RpcContext, input: SettingsResetTarget) {
  const accountCards = new Set(['recall-scope', 'recall-notifications', 'typing']);
  const selected = new Set(
    resetCards(input)
      .filter(
        ([page, card]) =>
          !ctx.host?.remoteClient ||
          (remoteSettingAvailable(page) && remoteResetCardAvailable(card)),
      )
      .map(([, card]) => card),
  );
  const source = [...selected].some((card) => accountCards.has(card)) ? identity() : null;
  const all = (await entries(ctx, selected)).filter(
    (entry) =>
      selected.has(entry.card) &&
      (!ctx.host?.remoteClient || entry.id !== 'call-content:systemAudio'),
  );
  // 运行开关以实际状态为准，不凭配置猜测。
  if (!ctx.authorize)
    for (const entry of all) {
      if (entry.id === 'startup-system:autostart')
        entry.current = (await bootstrapRouter.createCaller(ctx).getAutostartStatus()).enabled;
      if (entry.id === 'web:enabled')
        entry.current = (await remoteRouter.createCaller(ctx).webStatus()).enabled;
      if (entry.id === 'remote:enabled')
        entry.current = (await remoteRouter.createCaller(ctx).status()).enabled;
    }
  if (source !== null && source !== identity())
    throw new Error('账号或数据源已切换，请重新读取恢复范围');
  return { source, items: all };
}
export const settingsResetRouter = router({
  preview: procedure.input(target).query(async ({ ctx, input }) => {
    const result = await preview(ctx, input);
    return {
      source: result.source,
      items: result.items.map(
        ({ apply: _apply, card: _card, intentKey: _intentKey, ...item }) => item,
      ),
    };
  }),
  restore: procedure
    .input(
      target
        .extend({
          source: z.string().nullable(),
          directories: z.array(z.string()).default([]),
          retry: z.array(z.string()).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.source !== null && input.source !== identity())
        throw new Error('账号或数据源已切换，请重新确认恢复范围');
      const result = await preview(ctx, input);
      const results: SettingsResetResult[] = [];
      const candidates = planSettingsReset(result.items, input);
      const completed = new Set<string>();
      for (const entry of candidates) {
        if (completed.has(entry.id)) continue;
        const batch = entry.intentKey ? candidates.filter((item) => item.intentKey) : [entry];
        batch.forEach((item) => {
          completed.add(item.id);
        });
        if (input.source !== null && input.source !== identity()) {
          batch.forEach((item) => {
            results.push({ id: item.id, ok: false, error: '账号或数据源已切换，已停止后续恢复' });
          });
          continue;
        }
        try {
          if (entry.intentKey) {
            const service = getAppContext().services?.intentSense;
            const patch: Parameters<NonNullable<typeof service>['setConfig']>[0] = {};
            for (const item of batch)
              Object.assign(patch, { [item.intentKey!]: structuredClone(item.defaultValue) });
            if (service) await service.setConfig(patch, { preserveAnalysisResults: true });
            else await sharedSettingsRouter.createCaller(ctx).intent.setConfig(patch);
          } else await entry.apply();
          batch.forEach((item) => {
            results.push({ id: item.id, ok: true });
          });
        } catch (error) {
          batch.forEach((item) => {
            results.push({
              id: item.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
      return results;
    }),
});
