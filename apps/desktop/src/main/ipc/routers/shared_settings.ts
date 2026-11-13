import { z } from 'zod';
import { procedure, router } from '../trpc';
import { getAppContext, requireBootstrap, emitDressChanged } from '../../context/app_context';
import { intentSenseFeatureProcedures } from './intent_sense';
import { antiRecallSettingsProcedures } from './anti_recall';
import {
  mergeAssistantConfig,
  DressConfigService,
  DEFAULT_ANNUAL_REPORT_PREFERENCES,
} from '@weq/service';
import { sharedPreferencePersistence } from '@weq/service/shared-preferences';
import { agentLabModelSelectionSchema } from '../../../shared/agentlab_model_selection';
import { validateMcpConfig } from '../../mcp/external';
import { listScreenWidgets } from './dressup';
import { refreshTransferPolicy } from '../../data_saver';
import { updateClientNetwork } from '@weq/service/transfer-policy';

export const assistantSettingsProcedures = {
  getConfig: procedure.query(
    () =>
      getAppContext().services?.assistant.getConfig() ??
      mergeAssistantConfig(requireBootstrap().userConfig.getSharedPreference('assistant'), {}),
  ),
  setConfig: procedure
    .input(
      z.object({
        model: agentLabModelSelectionSchema.optional(),
        customPrompt: z.string().optional(),
        reasoningEffort: z.string().min(1).max(64).optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        maxOutputTokens: z.number().int().positive().nullable().optional(),
        maxRounds: z.number().int().positive().nullable().optional(),
        toolTimeoutMs: z.number().int().positive().nullable().optional(),
        taskTimeoutMs: z.number().int().positive().nullable().optional(),
        historyMessages: z.number().int().min(0).optional(),
        contextTokens: z.number().int().positive().optional(),
        compressionTrigger: z.number().positive().lt(1).optional(),
        compressionTarget: z.number().positive().lt(1).optional(),
        summaryTokens: z.number().int().positive().optional(),
        sendMode: z.enum(['interrupt', 'boundary', 'queue']).optional(),
        mcpServers: z.string().optional(),
        permissionMode: z.enum(['sandbox', 'unrestricted']).optional(),
        confirmUnrestricted: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      if (input.mcpServers !== undefined) validateMcpConfig(input.mcpServers);
      const service = getAppContext().services?.assistant;
      if (service) return service.setConfig(input);
      const owner = requireBootstrap().userConfig;
      const next = mergeAssistantConfig(owner.getSharedPreference('assistant'), input);
      owner.patchSharedPreference('assistant', next);
      return next;
    }),
};
import {
  DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
  MAX_MAIL_POLL_INTERVAL_MINUTES,
  mailPollIntervalMinutes,
} from '@weq/service/mail-wire';

export function sharedMailPreferences() {
  const value = requireBootstrap().userConfig.getSharedPreference('mail');
  return {
    showUnread: value.mailShowUnread ?? true,
    notifications: value.mailNotifications ?? false,
    pollIntervalMinutes: mailPollIntervalMinutes(
      value.mailPollIntervalMinutes ?? DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
    ),
    lastSync: getAppContext().services?.mail.status().lastSync ?? null,
  };
}

export const sharedSettingsRouter = router({
  networkCost: procedure
    .input(
      z
        .object({
          clientId: z.string().regex(/^[\w-]{1,80}$/),
          cost: z.object({
            state: z.enum(['restricted', 'unrestricted', 'unknown']),
            constrained: z.boolean(),
            metered: z.boolean(),
            source: z.string().max(80),
          }),
        })
        .optional(),
    )
    .query(({ input }) => {
      if (input) updateClientNetwork(input.clientId, input.cost);
      return refreshTransferPolicy();
    }),
  dress: router({
    get: procedure.query(() => {
      const owner = requireBootstrap().userConfig;
      return new DressConfigService(
        owner.sharedAppearanceDir(),
        sharedPreferencePersistence(owner, 'dress'),
      ).read();
    }),
    patch: procedure
      .input(
        z.object({
          activeBubble: z.number().int().min(0).optional(),
          activeFont: z.number().int().min(0).optional(),
          activeWidget: z.number().int().min(0).optional(),
          scope: z.enum(['mine', 'all']).optional(),
          background: z.enum(['none', 'qq', 'custom']).optional(),
          backgroundOpacity: z.number().min(0).max(1).optional(),
          widgetId: z.string().optional(),
        }),
      )
      .mutation(({ input }) => {
        if (input.widgetId && !listScreenWidgets().includes(input.widgetId))
          throw new Error(`未知的挂件 id: ${input.widgetId}`);
        const owner = requireBootstrap().userConfig;
        const config = new DressConfigService(
          owner.sharedAppearanceDir(),
          sharedPreferencePersistence(owner, 'dress'),
        );
        config.write({ ...config.read(), ...input, localAppearanceVersion: 1 });
        emitDressChanged();
        return config.read();
      }),
  }),
  assistant: router(assistantSettingsProcedures),
  annualReport: router({
    get: procedure.query(() => ({
      ...structuredClone(DEFAULT_ANNUAL_REPORT_PREFERENCES),
      ...requireBootstrap().userConfig.getSharedPreference('annualReport'),
    })),
    patch: procedure
      .input(
        z.object({
          mode: z.enum(['default', 'custom']).optional(),
          enabledPageIds: z.array(z.string()).optional(),
          order: z.array(z.string()).optional(),
          exportPageIds: z.array(z.string()).optional(),
        }),
      )
      .mutation(({ input }) => {
        const owner = requireBootstrap().userConfig;
        owner.patchSharedPreference('annualReport', input);
        const next = {
          ...structuredClone(DEFAULT_ANNUAL_REPORT_PREFERENCES),
          ...owner.getSharedPreference('annualReport'),
        };
        getAppContext().services?.annualReport.setPreferences(next);
        return next;
      }),
  }),
  antiRecall: router(antiRecallSettingsProcedures),
  intent: router({
    getStatus: intentSenseFeatureProcedures.getStatus,
    setConfig: intentSenseFeatureProcedures.setConfig,
  }),
  mail: router({
    get: procedure.query(() => sharedMailPreferences()),
    patch: procedure
      .input(
        z.object({
          showUnread: z.boolean().optional(),
          notifications: z.boolean().optional(),
          pollIntervalMinutes: z
            .number()
            .int()
            .min(1)
            .max(MAX_MAIL_POLL_INTERVAL_MINUTES)
            .optional(),
        }),
      )
      .mutation(({ input }) => {
        const owner = requireBootstrap().userConfig;
        owner.patchSharedPreference('mail', {
          ...(input.showUnread === undefined ? {} : { mailShowUnread: input.showUnread }),
          ...(input.notifications === undefined ? {} : { mailNotifications: input.notifications }),
          ...(input.pollIntervalMinutes === undefined
            ? {}
            : { mailPollIntervalMinutes: input.pollIntervalMinutes }),
        });
        const mail = getAppContext().services?.mail;
        if (input.showUnread !== undefined) mail?.setShowUnread(input.showUnread);
        if (input.pollIntervalMinutes !== undefined)
          mail?.setPollIntervalMinutes(input.pollIntervalMinutes);
        // 设置已持久化；连接失败由邮箱运行状态和已有重试处理，不把离线误报成保存失败。
        if (input.notifications !== undefined)
          void mail?.setNotifications(input.notifications).catch(() => {});
        return sharedMailPreferences();
      }),
  }),
});
