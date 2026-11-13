import { z } from 'zod';
import { DEFAULT_APP_SETTINGS, DEFAULT_INTENT_SENSE_CONFIG } from '@weq/service';
import {
  DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
  mailPollIntervalMinutes,
} from '@weq/service/mail-wire';
import { INTENT_TUNING, type IntentTuningKey } from '@weq/service/intent-context';
import { procedure, router, type RpcContext } from '../trpc';
import { getAppContext, closeSalvageConnections } from '../../context/app_context';
import { bootstrapRouter } from './bootstrap';
import { remoteRouter } from './remote';
import { updateRouter } from './update';
import { sharedSettingsRouter, sharedMailPreferences } from './shared_settings';
import { sharedIntentStatus } from './intent_sense';
import { sharedAntiRecallStatus } from './anti_recall';
import { clientStateRouter } from './client_state';
import { dataSaverBehaviorDefaults } from '@weq/service/data-saver';
import { preferenceDefaults } from '@weq/service/client-preferences';
import {
  remoteResetCardAvailable,
  remoteSettingAvailable,
} from '../../../shared/remote_capabilities';
import {
  SETTINGS_RESET_CARDS,
  resetCards,
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
  const defaults = DEFAULT_APP_SETTINGS;
  const b = bootstrapRouter.createCaller(ctx);
  const shared = sharedSettingsRouter.createCaller(ctx);
  const out: Entry[] = [];
  function add(
    card: SettingsResetCardId,
    id: string,
    label: string,
    current: unknown,
    defaultValue: unknown,
    apply: () => Promise<unknown>,
    extra: Partial<Pick<Entry, 'scope' | 'directory' | 'stopsService' | 'intentKey'>> = {},
  ) {
    out.push({
      card,
      id: `${card}:${id}`,
      label,
      current,
      defaultValue,
      apply,
      scope: '全局',
      ...extra,
    });
  }
  function app<K extends keyof typeof defaults>(
    card: SettingsResetCardId,
    key: K,
    label: string,
    write: (value: (typeof defaults)[K]) => Promise<unknown>,
  ) {
    add(card, key, label, current[key], defaults[key], () => write(defaults[key]));
  }
  app('home', 'home', '主页显示与屏蔽词', (value) => b.setHomeSettings(value));
  app('contact-card', 'contactCard', '名片显示与顺序', (value) => b.setContactCard(value));
  app('startup-page', 'startupPage', '启动时进入', (page) => b.setStartupPage({ page }));
  app('startup-system', 'showWindowOnAutostart', '自启时显示窗口', (enabled) =>
    b.setShowWindowOnAutostart({ enabled }),
  );
  if (!ctx.authorize)
    add('startup-system', 'autostart', '开机自动启动', undefined, false, () =>
      b.setAutostart({ enabled: false }),
    );
  app('window', 'windowCloseBehavior', '关闭窗口时', (behavior) =>
    b.setWindowCloseBehavior({ behavior }),
  );
  app('window', 'windowsStyleControls', '仿 Windows 窗口按钮', (enabled) =>
    b.setWindowsStyleControls({ enabled }),
  );
  for (const kind of ['success', 'failure'] as const) {
    const key = kind === 'success' ? 'successSeconds' : 'failureSeconds';
    add(
      'toast',
      key,
      `${kind === 'success' ? '成功' : '失败'}通知停留时长`,
      current.toastDurations[key],
      defaults.toastDurations[key],
      () => b.setToastDuration({ kind, seconds: defaults.toastDurations[key] }),
    );
  }
  app('app-lock', 'autoLockMinutes', '自动锁定分钟', (minutes) =>
    b.setAutoLockMinutes({ minutes }),
  );
  add('app-lock', 'enabled', '启用应用锁', current.appLock.enabled, defaults.appLock.enabled, () =>
    b.setAppLockEnabled({ enabled: defaults.appLock.enabled }),
  );
  add('app-lock', 'method', '解锁方式', current.appLock.method, defaults.appLock.method, () =>
    b.setAppLockMethod({ method: defaults.appLock.method }),
  );
  app('unread', 'showMessageUnreadBadge', '消息红点', (enabled) =>
    b.setShowMessageUnreadBadge({ enabled }),
  );
  app('unread', 'showContactUnreadCount', '联系人未读数', (enabled) =>
    b.setShowContactUnreadCount({ enabled }),
  );
  app('unread', 'showGroupAssistantMessageCount', '群助手计数', (enabled) =>
    b.setShowGroupAssistantMessageCount({ enabled }),
  );
  app('reading', 'readFromFirstUnread', '从首条未读开始', (enabled) =>
    b.setReadFromFirstUnread({ enabled }),
  );
  app('reading', 'jumpToLatestAfterSend', '发送后跳到最新', (enabled) =>
    b.setJumpToLatestAfterSend({ enabled }),
  );
  app('reading', 'autoFollowLatestMessages', '自动跟随新消息', (enabled) =>
    b.setAutoFollowLatestMessages({ enabled }),
  );
  app('reading', 'showScrollToBottomButton', '回到底部按钮', (enabled) =>
    b.setShowScrollToBottomButton({ enabled }),
  );
  const clientPreferences = config.getSharedPreference('client');
  for (const [key, label] of [
    ['autoFetchMissingMessages', '查看时自动拉取缺失的消息'],
    ['autoFetchMissingContext', '定位到缺失消息时自动拉取上下文'],
    ['missingMessageContextCount', '自动拉取上下文条数'],
  ] as const) {
    add(
      'reading',
      key,
      label,
      clientPreferences[key] ?? preferenceDefaults[key],
      preferenceDefaults[key],
      () => clientStateRouter.createCaller(ctx).patch({ [key]: preferenceDefaults[key] }),
    );
  }
  app('unread', 'reportReadEnabled', '自动阅读上报已读位置', (enabled) =>
    b.setReportReadEnabled({ enabled }),
  );
  app('unread', 'manualReadReportEnabled', '手动标记上报已读位置', (enabled) =>
    b.setManualReadReportEnabled({ enabled }),
  );
  app('message-time', 'showMessageSeq', '消息序号', (enabled) => b.setShowMessageSeq({ enabled }));
  app('message-time', 'showMessageDate', '消息日期', (enabled) =>
    b.setShowMessageDate({ enabled }),
  );
  app('message-time', 'showMessageTime', '消息时间', (enabled) =>
    b.setShowMessageTime({ enabled }),
  );
  app('message-dress', 'showAvatarPendant', '头像挂件', (enabled) =>
    b.setShowAvatarPendant({ enabled }),
  );
  app('message-dress', 'showChatQqShow', 'QQ 秀头像', (enabled) =>
    b.setShowChatQqShow({ enabled }),
  );
  app('message-dress', 'qqShowCacheMinutes', 'QQ 秀缓存有效期', (minutes) =>
    b.setQqShowCacheMinutes({ minutes }),
  );
  app('message-dress', 'showMsgDecoration', '消息装饰', (enabled) =>
    b.setShowMsgDecoration({ enabled }),
  );
  app('message-dress', 'showMessageBubble', '消息气泡', (enabled) =>
    b.setShowMessageBubble({ enabled }),
  );
  app('message-dress', 'showMessageFont', '消息字体', (enabled) =>
    b.setShowMessageFont({ enabled }),
  );
  app('message-text', 'renderTextMarkdown', 'Markdown 文本', (enabled) =>
    b.setRenderTextMarkdown({ enabled }),
  );
  app('message-text', 'linkPreview', '链接预览', (value) => b.setLinkPreview(value));
  add(
    'message-voice',
    'autoTranscribe',
    '语音自动转文字',
    current.voiceTranscribe.autoTranscribe,
    defaults.voiceTranscribe.autoTranscribe,
    () => b.setAutoTranscribeVoice({ enabled: defaults.voiceTranscribe.autoTranscribe }),
  );
  app('image-cache', 'chatImageCacheMiB', '图片预览内存预算', (miB) =>
    b.setChatImageCacheMiB({ miB }),
  );
  app('sending', 'sendWithQqFont', 'QQ 个性字体发送', (enabled) =>
    b.setSendWithQqFont({ enabled }),
  );
  add(
    'typing',
    'mode',
    '隐藏正在输入状态',
    current.typingStatus.mode,
    defaults.typingStatus.mode,
    () => b.setTypingStatusMode({ mode: defaults.typingStatus.mode }),
  );
  for (const key of ['mode', 'systemAudio', 'udpTrace'] as const) {
    const card = key === 'udpTrace' ? 'call-trace' : 'call-content';
    add(
      card,
      key,
      key === 'mode' ? '录制内容' : key === 'systemAudio' ? '电脑声音' : '记录 UDP 流量',
      current.callRecording[key],
      defaults.callRecording[key],
      () => b.setCallRecording({ [key]: defaults.callRecording[key] }),
    );
  }
  add(
    'call-directory',
    'dir',
    '通话录音目录',
    current.callRecording.dir,
    defaults.callRecording.dir,
    () => b.setCallRecording({ dir: defaults.callRecording.dir }),
    { directory: true },
  );
  app('call-connection', 'callDisableP2P', '禁用 P2P', (disabled) =>
    b.setCallDisableP2P({ disabled }),
  );
  app('qzone-person', 'qzonePersonClickAction', '人物入口', (action) =>
    b.setQzonePersonClickAction({ action }),
  );
  app('qzone-forward', 'qzoneForwardQuotePrevious', '引用上一人文案', (enabled) =>
    b.setQzoneForwardQuotePrevious({ enabled }),
  );
  app('qzone-pagination', 'qzonePagination', '在线翻页限速', (value) =>
    b.setQzonePagination(value),
  );
  app('qzone-public-refresh', 'qzonePublicRefreshCooldownMinutes', '自动刷新冷却期', (minutes) =>
    b.setQzonePublicRefreshCooldown({ minutes }),
  );
  add(
    'api-default',
    'model',
    '默认文本模型',
    current.agentLab.defaultModel,
    defaults.agentLab.defaultModel,
    () => b.setAgentLabDefaultModel({ ref: defaults.agentLab.defaultModel }),
  );
  for (const kind of ['voice', 'ocr'] as const) {
    const concurrency =
      kind === 'voice' ? current.voiceTranscribe.onlineConcurrency : current.ocr.onlineConcurrency;
    const value =
      kind === 'voice'
        ? defaults.voiceTranscribe.onlineConcurrency
        : defaults.ocr.onlineConcurrency;
    add(
      `${kind}-online`,
      'concurrency',
      kind === 'voice' ? '转录并发' : '识别并发',
      concurrency,
      value,
      () => b.setRecognitionConcurrency({ kind, concurrency: value }),
    );
  }
  app('realtime', 'realtimeEnabled', '数据库监听', (enabled) => b.setRealtimeEnabled({ enabled }));
  app('attach', 'autoAttachQq', '自动启用完整功能', (enabled) => b.setAutoAttachQq({ enabled }));
  app('attach', 'restrictedModeBannerEnabled', '受限模式横幅提醒', (enabled) =>
    b.setRestrictedModeBannerEnabled({ enabled }),
  );
  add('auto-enter', 'account', '默认进入账号', config.getAutoEnter(), null, () =>
    b.clearAutoEnter(),
  );
  app('damage-reminder', 'suppressDbDamageReminder', '损坏提醒', (suppressed) =>
    b.setSuppressDbDamageReminder({ suppressed }),
  );
  app('cdn', 'preferCdn', '优先 CDN', (enabled) => b.setPreferCdn({ enabled }));
  if (selected.has('data-saver')) {
    const saverDefaults = { dataSaverMode: 'auto' as const, ...dataSaverBehaviorDefaults };
    const saverCurrent = config.getSharedPreference('client');
    add(
      'data-saver',
      'preferences',
      '省流量模式与行为',
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
  add('rkey', 'enabled', '外部 RKEY 启用目标', current.externalRkey.enabledServerId, null, () =>
    b.setExternalRkeyEnabled({ serverId: null }),
  );
  add(
    'mcp',
    'enabled',
    'MCP 服务',
    current.mcp.enabled,
    defaults.mcp.enabled,
    () => b.setMcpEnabled({ enabled: defaults.mcp.enabled }),
    { stopsService: true },
  );
  add(
    'onebot',
    'enabled',
    'OneBot 服务',
    current.oneBot.enabled,
    defaults.oneBot.enabled,
    () => b.setOneBotEnabled({ enabled: defaults.oneBot.enabled }),
    { stopsService: true },
  );
  for (const [type, servers] of [
    ['ws', current.oneBot.webSocketServers],
    ['http', current.oneBot.httpServers],
  ] as const) {
    for (const server of servers)
      add(
        'onebot-servers',
        `${type}:${server.id}`,
        `${server.name} 启用状态`,
        server.enabled,
        false,
        () => b.setOneBotServerEnabled({ type, id: server.id, enabled: false }),
        { stopsService: true },
      );
  }
  add(
    'sse-targets',
    'enabled',
    'SSE 推送',
    current.ssePush.enabledServerId,
    null,
    () => b.setSsePushEnabled({ serverId: null }),
    { stopsService: true },
  );
  add(
    'sse-tuning',
    'tuning',
    'SSE 推送调优',
    { debounceMs: current.ssePush.debounceMs, massThreshold: current.ssePush.massThreshold },
    { debounceMs: defaults.ssePush.debounceMs, massThreshold: defaults.ssePush.massThreshold },
    () =>
      b.setSsePushTuning({
        debounceMs: defaults.ssePush.debounceMs,
        massThreshold: defaults.ssePush.massThreshold,
      }),
  );
  add(
    'assistant',
    'enabled',
    'QQ 公众号推送',
    current.weqAssistant.enabled,
    defaults.weqAssistant.enabled,
    () => b.setWeqAssistantEnabled({ enabled: defaults.weqAssistant.enabled }),
    { stopsService: true },
  );
  app('logs', 'logRetentionDays', '日志保留天数', (days) => b.setLogRetentionDays({ days }));
  if (!ctx.authorize) {
    const r = remoteRouter.createCaller(ctx);
    const u = updateRouter.createCaller(ctx);
    add(
      'web',
      'enabled',
      '本机浏览器访问',
      undefined,
      false,
      () => r.setWebEnabled({ enabled: false }),
      { stopsService: true },
    );
    app('web', 'webServiceAutoStart', 'Web 服务自动启动', (enabled) =>
      r.setWebAutoStart({ enabled }),
    );
    add(
      'remote',
      'enabled',
      'WeQ Remote',
      undefined,
      false,
      () => r.setEnabled({ enabled: false }),
      { stopsService: true },
    );
    add(
      'update',
      'interval',
      '自动检查更新频率',
      current.updateCheckIntervalMinutes,
      defaults.updateCheckIntervalMinutes,
      () => u.setInterval({ minutes: defaults.updateCheckIntervalMinutes }),
    );
    add(
      'update',
      'prerelease',
      '检查测试版',
      current.updateCheckPrerelease,
      defaults.updateCheckPrerelease,
      () => u.setPrerelease({ enabled: defaults.updateCheckPrerelease }),
    );
  }
  const services = context.services;
  {
    const intent = [...selected].some((card) => /^(intent|suggestion|profile)-/.test(card))
      ? sharedIntentStatus()
      : DEFAULT_INTENT_SENSE_CONFIG;
    const groups: Partial<
      Record<SettingsResetCardId, readonly (keyof typeof DEFAULT_INTENT_SENSE_CONFIG)[]>
    > = {
      'intent-basic': ['enabled', 'analysisMode', 'engine', 'providerRef'],
      'intent-display': ['persistentDisplay', 'hoverDisplay', 'loadingAnimation'],
      'intent-trigger': ['analyzeAfterSelf'],
      'intent-analysis': [
        'analysisContextMessages',
        'backfillMessages',
        'contextGapMinutes',
        'contextSpanMinutes',
      ],
      'intent-model': ['analysisTemperature', 'apiBatchMessages'],
      'intent-cache': ['apiTimeoutSeconds', 'apiCooldownSeconds', 'cacheEntries'],
      'suggestion-basic': ['suggestionsEnabled', 'suggestionMode', 'suggestionProviderRef'],
      'suggestion-trigger': ['suggestAfterSelf'],
      'suggestion-content': [
        'suggestionContextMessages',
        'suggestionCount',
        'suggestionTargetChars',
      ],
      'suggestion-generation': ['suggestionTemperature'],
      'suggestion-cache': [
        'suggestionCacheSeconds',
        'suggestionExpiryMinutes',
        'suggestionHistoryLimit',
      ],
      'suggestion-fallback': ['suggestionFallbackEnabled', 'suggestionFallbackTexts'],
      'profile-basic': [
        'profileEnabled',
        'profileMode',
        'profileEngine',
        'profileProviderRef',
        'profileLocalModelId',
      ],
      'profile-range': ['profileMessages', 'profileDecayDays', 'profileGapMinutes'],
      'profile-model': [
        'profileSamples',
        'profileMinSamples',
        'profileModelTopics',
        'profileTemperature',
      ],
      'profile-display': ['profileTrendDays', 'profileTopicLimit'],
      'profile-cache': [
        'profileApiTimeoutSeconds',
        'profileApiCooldownSeconds',
        'profileCacheSeconds',
      ],
    };
    for (const [card, keys] of Object.entries(groups))
      for (const key of keys) {
        const featureLabels: Record<string, string> = {
          enabled: '启用意图感知',
          analysisMode: '分析模式',
          engine: '分析引擎',
          providerRef: '分析模型',
          persistentDisplay: '常驻显示',
          hoverDisplay: '悬停显示',
          loadingAnimation: '分析等待动画',
          analyzeAfterSelf: '自己发送后分析',
          suggestionsEnabled: '启用推荐回复',
          suggestionMode: '推荐模式',
          suggestionProviderRef: '推荐模型',
          suggestAfterSelf: '自己发送后推荐',
          suggestionFallbackEnabled: '启用回退内容',
          suggestionFallbackTexts: '回退内容列表',
          profileEnabled: '启用互动画像',
          profileMode: '画像模式',
          profileEngine: '画像引擎',
          profileProviderRef: '画像模型',
          profileLocalModelId: '画像本地模型',
        };
        const label =
          key in INTENT_TUNING
            ? INTENT_TUNING[key as IntentTuningKey].label
            : (featureLabels[key] ?? key);
        add(
          card as SettingsResetCardId,
          key,
          label,
          intent[key],
          DEFAULT_INTENT_SENSE_CONFIG[key],
          () =>
            shared.intent.setConfig({
              [key]: structuredClone(DEFAULT_INTENT_SENSE_CONFIG[key]),
            }),
          { intentKey: key },
        );
      }
    const record = services?.accountConfig.getRecord();
    if (record) {
      const selectedHidden = current.typingStatus.hidden.filter(
        (item) => item.accountUin === record.uin && item.accountConfigId === record.configId,
      );
      add(
        'typing',
        'selection',
        '隐藏正在输入状态的会话选择',
        selectedHidden,
        [],
        () =>
          b.setTypingStatusHidden({
            hidden: config
              .getSettings()
              .typingStatus.hidden.filter(
                (item) =>
                  item.accountUin !== record.uin || item.accountConfigId !== record.configId,
              ),
          }),
        { scope: '当前账号' },
      );
    }
    if (services)
      add(
        'native-media',
        'enabled',
        '本机 QQ 资源',
        record?.nativeMediaEnabled ?? true,
        true,
        async () => {
          services.accountConfig.setNativeMediaEnabled(true);
          return true;
        },
        { scope: '当前账号' },
      );
    const mail = sharedMailPreferences();
    add('mail', 'unread', '邮箱红点', mail.showUnread, true, async () => {
      await shared.mail.patch({ showUnread: true });
    });
    add('mail', 'notifications', '邮件横幅提醒', mail.notifications, false, async () => {
      await shared.mail.patch({ notifications: false });
    });
    add(
      'mail',
      'poll-interval',
      '邮箱查询间隔',
      mailPollIntervalMinutes(mail.pollIntervalMinutes),
      DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
      async () => {
        await shared.mail.patch({ pollIntervalMinutes: DEFAULT_MAIL_POLL_INTERVAL_MINUTES });
      },
    );
    if (selected.has('recall-scope')) {
      const recall = await sharedAntiRecallStatus();
      add(
        'recall-scope',
        'scope',
        '防撤回启用范围',
        recall.enabled ? recall.mode : 'off',
        'off',
        async () => shared.antiRecall.setScope({ scope: 'off' }),
      );
      add('recall-scope', 'notify', '撤回通知', recall.notifyEnabled, false, async () =>
        shared.antiRecall.setNotify({ enabled: false }),
      );
      if (services)
        add(
          'recall-scope',
          'targets',
          '防撤回会话选择',
          recall.targets,
          [],
          async () => services.antiRecall.setTargets([]),
          { scope: '当前账号' },
        );
      if (services)
        add(
          'recall-scope',
          'notify-targets',
          '撤回通知会话选择',
          recall.notifyTargets,
          [],
          async () => services.antiRecall.setNotify({ targets: [] }),
          { scope: '当前账号' },
        );
    }
    if (context.dbTolerance)
      add(
        'db-tolerance',
        'level',
        '宽容级别',
        context.dbTolerance.getConfig().level,
        0,
        async () => {
          const result = context.dbTolerance!.setLevel(0, 'settings');
          closeSalvageConnections(context);
          return result;
        },
        { scope: '当前账号' },
      );
  }
  add(
    'external-chatpic',
    'enabled',
    '外部安卓图片缓存',
    current.externalChatpic.enabled,
    defaults.externalChatpic.enabled,
    () =>
      b.setExternalChatpic({
        ...config.getSettings().externalChatpic,
        enabled: defaults.externalChatpic.enabled,
      }),
  );
  add(
    'external-chatpic',
    'dir',
    '外部安卓图片目录',
    current.externalChatpic.dir,
    defaults.externalChatpic.dir,
    () =>
      b.setExternalChatpic({
        ...config.getSettings().externalChatpic,
        dir: defaults.externalChatpic.dir,
      }),
    { directory: true },
  );
  return out;
}

async function preview(ctx: RpcContext, input: SettingsResetTarget) {
  const accountCards = new Set(['native-media', 'db-tolerance', 'recall-scope', 'typing']);
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
      const allowed = new Set(result.items.map((item) => item.id));
      if ([...input.directories, ...(input.retry ?? [])].some((id) => !allowed.has(id)))
        throw new Error('恢复项目不属于当前范围');
      const results: SettingsResetResult[] = [];
      const candidates = result.items.filter(
        (entry) =>
          (!input.retry || input.retry.includes(entry.id)) &&
          (!entry.directory || input.directories.includes(entry.id)) &&
          (input.retry || JSON.stringify(entry.current) !== JSON.stringify(entry.defaultValue)),
      );
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
