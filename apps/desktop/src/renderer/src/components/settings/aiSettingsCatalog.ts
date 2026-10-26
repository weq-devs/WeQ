import {
  INTENT_TUNING,
  INTENT_TUNING_KEYS,
  type IntentTuningKey,
} from '@weq/service/intent-context';

type AiPage = 'intent-sense' | 'reply-suggestions' | 'interaction-profile';
interface AiSetting {
  id: string;
  section: AiPage;
  label: string;
  aliases?: readonly string[];
}

export function intentTuningSettingId(key: IntentTuningKey): string {
  return `intent-tuning-${key}`;
}

/** 名称、稳定定位与业务参数使用同一份公开目录，不包含配置值或账号数据。 */
export const AI_SETTING_ITEMS: readonly AiSetting[] = [
  { id: 'intent-enabled', section: 'intent-sense', label: '启用意图感知' },
  {
    id: 'intent-engine',
    section: 'intent-sense',
    label: '意图感知运行方式',
    aliases: ['本地意图模型', '运行方式'],
  },
  {
    id: 'intent-api-model',
    section: 'intent-sense',
    label: '意图感知 API 模型',
    aliases: ['服务商与模型', 'API 模型'],
  },
  { id: 'intent-after-self', section: 'intent-sense', label: '自己发送后分析' },
  { id: 'intent-cache', section: 'intent-sense', label: '分析缓存', aliases: ['清空并重算'] },
  { id: 'intent-advanced', section: 'intent-sense', label: '意图感知高级设置' },
  { id: 'suggestions-enabled', section: 'reply-suggestions', label: '启用推荐回复' },
  { id: 'suggestions-model', section: 'reply-suggestions', label: '推荐回复 API 模型' },
  { id: 'suggestions-after-self', section: 'reply-suggestions', label: '自己发送后推荐回复' },
  { id: 'suggestions-advanced', section: 'reply-suggestions', label: '推荐回复高级设置' },
  { id: 'profile-enabled', section: 'interaction-profile', label: '启用互动画像' },
  {
    id: 'profile-engine',
    section: 'interaction-profile',
    label: '互动画像运行方式',
    aliases: ['运行方式'],
  },
  {
    id: 'profile-api-model',
    section: 'interaction-profile',
    label: '互动画像 API 模型',
    aliases: ['API 模型'],
  },
  { id: 'profile-local-model', section: 'interaction-profile', label: '互动画像本地模型资源' },
  { id: 'profile-advanced', section: 'interaction-profile', label: '互动画像高级设置' },
  ...INTENT_TUNING_KEYS.map((key): AiSetting => {
    const rule = INTENT_TUNING[key];
    return {
      id: intentTuningSettingId(key),
      section:
        rule.group === 'profile'
          ? 'interaction-profile'
          : rule.group === 'suggestions'
            ? 'reply-suggestions'
            : 'intent-sense',
      label: rule.label,
      ...('ariaLabel' in rule ? { aliases: [rule.ariaLabel] } : {}),
    };
  }),
];
