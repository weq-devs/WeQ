import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { UserConfigService } from './user_config';
import { DEFAULT_INTENT_SENSE_CONFIG } from '../account/intent_sense';
import {
  readPreferenceObject,
  normalizedSharedPreferences,
  type SharedPreferences,
} from '../common/shared_preferences';
import { writeFileAtomicSync } from '../common/atomic_write';
import { validateSharedPreferences, validateWeqApiSettings } from './backup_settings';

const pick = (raw: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(raw).filter(([key]) => keys.includes(key)));
const intentKeys = Object.keys(DEFAULT_INTENT_SENSE_CONFIG).filter(
  (key) => key !== 'conversationOverrides',
);
const mailKeys = ['mailNotifications', 'mailShowUnread', 'mailPollIntervalMinutes'];
const dressKeys = [
  'localAppearanceVersion',
  'installedBubbles',
  'installedFonts',
  'installedWidgets',
  'bubbleMeta',
  'fontMeta',
  'widgetMeta',
  'activeBubble',
  'activeFont',
  'activeWidget',
  'scope',
  'background',
  'backgroundFile',
  'widgetId',
  'backgroundOpacity',
];

/** 仅保存偏好快照，不把账号文件中的密钥、票据或业务内容带进回执。 */
export function migrateSharedPreferences(
  owner: UserConfigService,
  root: string,
  cache: string,
  configId: string,
): void {
  if (owner.read().sharedPreferencesMigration?.version === 1) return;
  const legacyLocalModelId = owner.getLocalModelId('intent');
  const accountDir = join(root, 'config', 'accounts');
  const files = existsSync(accountDir)
    ? readdirSync(accountDir).filter((name) => name.endsWith('.json'))
    : [];
  const ids = [...new Set([configId, ...files.map((name) => name.slice(0, -5))])];
  const snapshots: Record<string, SharedPreferences> = {};
  for (const id of ids) {
    const account = readPreferenceObject(join(accountDir, `${id}.json`));
    const client = readPreferenceObject(join(accountDir, id, 'client-state.json'));
    const records =
      client.records && typeof client.records === 'object'
        ? (client.records as Record<string, unknown>)
        : {};
    snapshots[id] = {
      intent: pick(
        readPreferenceObject(join(cache, 'intent_sense', id, 'config.json')),
        intentKeys,
      ),
      antiRecall: pick(readPreferenceObject(join(cache, 'anti_recall', id, 'config.json')), [
        'enabled',
        'mode',
        'notifyEnabled',
      ]),
      assistant: pick(readPreferenceObject(join(cache, 'agentlab', id, 'assistant.json')), [
        'permissionMode',
        'model',
        'customPrompt',
        'reasoningEffort',
        'mcpServers',
      ]),
      dress: pick(readPreferenceObject(join(accountDir, id, 'dress.json')), dressKeys),
      mail: pick(account, mailKeys),
      annualReport:
        account.annualReport && typeof account.annualReport === 'object'
          ? account.annualReport
          : {},
      order:
        records.order && typeof records.order === 'object'
          ? (records.order as Record<string, unknown>)
          : {},
    };
  }
  const settings = owner.read().settings ?? {};
  const existing = settings.sharedPreferences ?? {};
  const selected = normalizedSharedPreferences(snapshots[configId] ?? {}, legacyLocalModelId);
  const merged: SharedPreferences = { ...existing };
  for (const key of Object.keys(selected) as Array<keyof SharedPreferences>)
    Object.assign(merged, { [key]: { ...selected[key], ...existing[key] } });
  const dress = merged.dress ?? {};
  for (const key of ['installedBubbles', 'installedFonts', 'installedWidgets'] as const)
    dress[key] = [
      ...new Set([
        ...(dress[key] ?? []),
        ...Object.values(snapshots).flatMap((snapshot) => snapshot.dress?.[key] ?? []),
      ]),
    ];
  for (const key of ['bubbleMeta', 'fontMeta', 'widgetMeta'] as const)
    dress[key] = Object.assign(
      {},
      ...Object.values(snapshots).map((snapshot) => snapshot.dress?.[key] ?? {}),
      dress[key],
    );
  const background = dress.backgroundFile;
  if (background && !existing.dress?.backgroundFile) {
    if (basename(background) !== background) throw new Error('旧装扮背景路径无效，已保留原件');
    const source = join(accountDir, configId, background);
    if (existsSync(source)) {
      const bytes = readFileSync(source);
      const name = `bg-${createHash('sha256').update(bytes).digest('hex')}${extname(background).toLowerCase()}`;
      const target = join(owner.sharedAppearanceDir(), name);
      if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
      if (!readFileSync(target).equals(bytes)) throw new Error('共享背景校验失败，已保留原件');
      dress.backgroundFile = name;
    } else
      dress.backgroundFile = `bg-${createHash('sha256').update(background).digest('hex')}${extname(background).toLowerCase()}`;
  }
  merged.dress = dress;
  const normalized = normalizedSharedPreferences(merged, legacyLocalModelId);
  // 全局显式参数固定；仅调整从旧账号继承的关联范围，保持最少样本 <= 采样 <= 消息范围。
  const profileKeys = ['profileMinSamples', 'profileSamples', 'profileMessages'] as const;
  const profileValues = profileKeys.map(
    (key) => normalized.intent[key] ?? DEFAULT_INTENT_SENSE_CONFIG[key],
  );
  const fixed = profileKeys.map((key) => Object.hasOwn(existing.intent ?? {}, key));
  for (let i = 0; i < profileKeys.length; i++) {
    if (fixed[i]) continue;
    const lower = Math.max(0, ...profileValues.filter((_, j) => j < i && fixed[j]));
    const upper = Math.min(Infinity, ...profileValues.filter((_, j) => j > i && fixed[j]));
    if (lower > upper) throw new Error('全局画像样本范围不一致，已保留旧设置');
    profileValues[i] = Math.max(lower, Math.min(upper, profileValues[i]!));
  }
  if (profileValues[0]! > profileValues[1]! || profileValues[1]! > profileValues[2]!)
    throw new Error('画像样本范围不一致，已保留旧设置');
  profileKeys.forEach((key, index) => {
    normalized.intent[key] = profileValues[index]!;
  });
  const { assistant, ...app } = normalized;
  validateSharedPreferences(app);
  validateWeqApiSettings({ sharedAssistant: assistant });
  const receiptData = JSON.stringify(
    { version: 1, configId, global: existing, snapshots },
    null,
    2,
  );
  const receipt = join(
    root,
    'config',
    'migrations',
    `shared-preferences-v1-${createHash('sha256').update(receiptData).digest('hex')}.json`,
  );
  if (existsSync(receipt)) {
    if (readFileSync(receipt, 'utf8') !== receiptData)
      throw new Error('迁移记录位置已有不同内容，已保留原件');
  } else writeFileAtomicSync(receipt, receiptData);
  owner.write({
    settings: { ...settings, sharedPreferences: normalized },
    sharedPreferencesMigration: { version: 1, configId, receipt },
  });
}
