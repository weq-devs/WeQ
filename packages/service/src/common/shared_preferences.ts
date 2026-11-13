import type { IntentSenseConfig } from '../account/intent_sense';
import type { AntiRecallConfig } from '../account/anti_recall';
import type { AssistantConfig } from '../account/assistant';
import type { DressConfig } from '../account/dress_config';
import type { AnnualReportPreferences } from '../account/annual_report/types';
import type { PreferencePatch } from './client_preferences';
import { preferenceDefaults, displayPreferenceKeys } from './client_preferences';
import { normalizeContactOrder } from './contact_directory_preferences';
import { normalizeIntentSenseConfig, DEFAULT_INTENT_SENSE_CONFIG } from '../account/intent_sense';
import { normalizeDressConfig } from '../account/dress_config';
import { mergeAssistantConfig } from '../account/assistant';
import { mailPollIntervalMinutes } from '../account/mail/wire';
import { DEFAULT_ANTI_RECALL_CONFIG } from '../account/anti_recall';
import { DEFAULT_ANNUAL_REPORT_PREFERENCES } from '../account/annual_report/types';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic_write';

export interface SharedPreferenceGroups {
  client: PreferencePatch;
  intent: Partial<Omit<IntentSenseConfig, 'conversationOverrides'>>;
  antiRecall: Partial<Pick<AntiRecallConfig, 'enabled' | 'mode' | 'notifyEnabled'>>;
  assistant: AssistantConfig;
  dress: Partial<DressConfig>;
  mail: { mailNotifications?: boolean; mailShowUnread?: boolean; mailPollIntervalMinutes?: number };
  annualReport: Partial<AnnualReportPreferences>;
  order: Record<string, unknown>;
}
export type SharedPreferences = Partial<SharedPreferenceGroups>;

export const SHARED_PREFERENCE_DEFINITIONS = {
  client: { backup: 'settings', ruleKeys: [] },
  intent: { backup: 'settings', ruleKeys: ['conversationOverrides'] },
  antiRecall: { backup: 'settings', ruleKeys: ['targets', 'notifyTargets'] },
  assistant: { backup: 'api', ruleKeys: [] },
  dress: { backup: 'settings', ruleKeys: [] },
  mail: { backup: 'settings', ruleKeys: [] },
  annualReport: { backup: 'settings', ruleKeys: [] },
  order: { backup: 'settings', ruleKeys: [] },
} as const;

export function normalizeSharedIntentPreferences(
  value: SharedPreferenceGroups['intent'] = {},
  legacyLocalModelId?: string,
): IntentSenseConfig {
  const modern = Object.keys(value).length === 0 || value.featureSettingsVersion === 2;
  return normalizeIntentSenseConfig(
    modern ? { ...DEFAULT_INTENT_SENSE_CONFIG, ...value } : value,
    legacyLocalModelId,
  );
}

/** 完整快照用于备份与恢复默认；普通读取不回填原始字段，迁移仍能判断显式取值。 */
export function normalizedSharedPreferences(
  raw: SharedPreferences,
  legacyLocalModelId?: string,
): SharedPreferenceGroups {
  const { conversationOverrides: _rules, ...intent } = normalizeSharedIntentPreferences(
    raw.intent,
    legacyLocalModelId,
  );
  const {
    targets: _targets,
    notifyTargets: _notifyTargets,
    ...recallDefaults
  } = DEFAULT_ANTI_RECALL_CONFIG;
  const clientDefaults = Object.fromEntries(
    Object.entries(preferenceDefaults).filter(
      ([key]) =>
        key !== 'contactOrder' &&
        !displayPreferenceKeys.includes(key as keyof typeof preferenceDefaults),
    ),
  );
  return {
    client: {
      ...clientDefaults,
      ...Object.fromEntries(
        Object.entries(raw.client ?? {}).filter(([key]) => Object.hasOwn(clientDefaults, key)),
      ),
    },
    intent,
    antiRecall: { ...recallDefaults, ...raw.antiRecall },
    assistant: mergeAssistantConfig(raw.assistant ?? {}, {}),
    dress: normalizeDressConfig(raw.dress ?? {}),
    mail: {
      mailNotifications: raw.mail?.mailNotifications === true,
      mailShowUnread: raw.mail?.mailShowUnread !== false,
      mailPollIntervalMinutes: mailPollIntervalMinutes(raw.mail?.mailPollIntervalMinutes),
    },
    annualReport: { ...structuredClone(DEFAULT_ANNUAL_REPORT_PREFERENCES), ...raw.annualReport },
    order: normalizeContactOrder(raw.order),
  };
}
export interface PreferencePersistence<T> {
  read(): unknown;
  write(value: T): void;
  revision?(): number;
}
export interface SharedPreferenceOwner {
  sharedPreferenceRevision?(): number;
  getSharedPreference<K extends keyof SharedPreferenceGroups>(key: K): SharedPreferenceGroups[K];
  patchSharedPreference<K extends keyof SharedPreferenceGroups>(
    key: K,
    patch: SharedPreferenceGroups[K],
  ): void;
  replaceSharedPreference<K extends keyof SharedPreferenceGroups>(
    key: K,
    value: SharedPreferenceGroups[K],
  ): void;
}

/** 缺失与损坏必须分开：损坏原件不能被迁移或默认值静默覆盖。 */
export function readPreferenceObject(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须是对象');
    return raw as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`读取设置失败，原件已保留：${path}`, { cause: error });
  }
}

/** 旧服务只保留对象规则；通用字段永远从宿主的全局设置读取。 */
export function sharedPreferencePersistence<
  T extends object,
  K extends keyof SharedPreferenceGroups,
>(
  owner: SharedPreferenceOwner,
  key: K,
  rulesPath?: string,
  ruleKeys: readonly string[] = SHARED_PREFERENCE_DEFINITIONS[key].ruleKeys,
): PreferencePersistence<T> {
  const rules = () =>
    rulesPath
      ? Object.fromEntries(
          Object.entries(readPreferenceObject(rulesPath)).filter(([name]) =>
            ruleKeys.includes(name),
          ),
        )
      : {};
  return {
    revision: () => owner.sharedPreferenceRevision?.() ?? 0,
    read: () => ({ ...owner.getSharedPreference(key), ...rules() }),
    write: (value) => {
      const entries = Object.entries(value);
      const previousRules = rules();
      const previous = owner.getSharedPreference(key);
      owner.patchSharedPreference(
        key,
        Object.fromEntries(
          entries.filter(([name]) => !ruleKeys.includes(name)),
        ) as SharedPreferenceGroups[K],
      );
      if (rulesPath) {
        const next = Object.fromEntries(entries.filter(([name]) => ruleKeys.includes(name)));
        if (JSON.stringify(previousRules) !== JSON.stringify(next)) {
          try {
            writeFileAtomicSync(rulesPath, JSON.stringify(next, null, 2));
          } catch (error) {
            try {
              owner.replaceSharedPreference(key, previous);
            } catch (rollback) {
              throw new Error('会话规则保存失败，通用设置回滚也失败，请重试。', {
                cause: new AggregateError([error, rollback]),
              });
            }
            throw error;
          }
        }
      }
    },
  };
}
