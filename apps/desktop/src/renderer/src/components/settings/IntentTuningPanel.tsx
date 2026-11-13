import { Fragment, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { z } from 'zod';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots';
import { SlidersHorizontal } from 'lucide-react';
import { AutoSave } from './AutoSave';
import {
  INTENT_TUNING,
  INTENT_TUNING_HELP,
  INTENT_TUNING_KEYS,
  isIntentTuningValue,
  type IntentTuningKey,
} from '@weq/service/intent-context';
import { Card, Row } from './controls';
import { intentTuningSettingId } from './aiSettingsCatalog';
import { AiFeatureSettingsContext, useAiFeatureSettings } from './useAiFeatureSettings';
import { useTabActive } from '../RetainedTabs';

const TITLES = {
  analysis: '分析范围',
  suggestions: '回复内容',
  profile: '统计范围',
  advanced: '请求与缓存',
};

const SECTIONS: Record<keyof typeof TITLES, { title: string; keys: readonly IntentTuningKey[] }[]> =
  {
    analysis: [
      {
        title: '分析范围',
        keys: [
          'analysisContextMessages',
          'backfillMessages',
          'contextGapMinutes',
          'contextSpanMinutes',
        ],
      },
      { title: '模型参数', keys: ['analysisTemperature', 'apiBatchMessages'] },
    ],
    suggestions: [
      {
        title: '回复内容',
        keys: ['suggestionContextMessages', 'suggestionCount', 'suggestionTargetChars'],
      },
      { title: '生成参数', keys: ['suggestionTemperature'] },
      {
        title: '缓存与历史',
        keys: ['suggestionCacheSeconds', 'suggestionExpiryMinutes', 'suggestionHistoryLimit'],
      },
    ],
    profile: [
      { title: '统计范围', keys: ['profileMessages', 'profileDecayDays', 'profileGapMinutes'] },
      {
        title: '模型推断',
        keys: ['profileSamples', 'profileMinSamples', 'profileModelTopics', 'profileTemperature'],
      },
      { title: '结果展示', keys: ['profileTrendDays', 'profileTopicLimit'] },
      {
        title: '请求与缓存',
        keys: ['profileApiTimeoutSeconds', 'profileApiCooldownSeconds', 'profileCacheSeconds'],
      },
    ],
    advanced: [
      { title: '请求与缓存', keys: ['apiTimeoutSeconds', 'apiCooldownSeconds', 'cacheEntries'] },
    ],
  };

export function IntentTuningPanel({
  group,
  beforeCache,
}: {
  group: keyof typeof TITLES;
  beforeCache?: ReactNode;
}) {
  const settings = useContext(AiFeatureSettingsContext);
  return settings ? (
    <TuningFields group={group} settings={settings} beforeCache={beforeCache} />
  ) : (
    <StandaloneTuningPanel group={group} beforeCache={beforeCache} />
  );
}

function StandaloneTuningPanel({
  group,
  beforeCache,
}: {
  group: keyof typeof TITLES;
  beforeCache?: ReactNode;
}) {
  const settings = useAiFeatureSettings('参数');
  return <TuningFields group={group} settings={settings} beforeCache={beforeCache} />;
}

function TuningFields({
  group,
  settings,
  beforeCache,
}: {
  group: keyof typeof TITLES;
  settings: ReturnType<typeof useAiFeatureSettings>;
  beforeCache?: ReactNode;
}) {
  const active = useTabActive();
  const { status, patch } = settings;
  const disabled = !active || settings.disabled;
  const keys = useMemo(
    () => INTENT_TUNING_KEYS.filter((key) => INTENT_TUNING[key].group === group),
    [group],
  );
  const baseline = useRef<Record<string, string>>({});
  const [draft, setDraft] = usePageState<Record<string, string>>(
    `tuning:${group}`,
    {},
    z.record(z.string()),
    true,
  );
  useEffect(() => {
    if (!status.data) return;
    const before = baseline.current;
    const next = Object.fromEntries(keys.map((key) => [key, String(status.data![key])]));
    setDraft((current) => {
      const updated = Object.fromEntries(
        keys.map((key) => [
          key,
          current[key] === undefined || current[key] === before[key] ? next[key]! : current[key]!,
        ]),
      );
      return keys.every((key) => current[key] === updated[key]) ? current : updated;
    });
    baseline.current = next;
  }, [keys, status.data, setDraft]);
  usePageDraftConfirmation(
    `tuning:${group}`,
    status.data
      ? Object.fromEntries(
          keys.map((key) => [
            key,
            draft[key]?.trim() && Number(draft[key]) === status.data![key]
              ? draft[key]
              : String(status.data![key]),
          ]),
        )
      : undefined,
  );
  const ready = keys.every((key) => isIntentTuningValue(key, status.data?.[key]));
  const valid = (selected: readonly IntentTuningKey[]) =>
    selected.every((key) => draft[key]?.trim() && isIntentTuningValue(key, Number(draft[key])));

  const apiOnly: readonly IntentTuningKey[] = [
    'apiBatchMessages',
    'apiTimeoutSeconds',
    'apiCooldownSeconds',
    'profileApiTimeoutSeconds',
    'profileApiCooldownSeconds',
  ];
  const sections = SECTIONS[group]
    .map((section) => ({
      ...section,
      keys: section.keys.filter((key) => {
        if (group === 'profile') {
          if (section.title === '模型推断' && status.data?.profileEngine === 'heuristic')
            return false;
          if (apiOnly.includes(key) && status.data?.profileEngine !== 'api') return false;
        } else if (apiOnly.includes(key) && status.data?.engine !== 'api') return false;
        return true;
      }),
    }))
    .filter((section) => section.keys.length);
  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.title}>
          {section.title === '缓存与历史' ? beforeCache : null}
          <Card
            title={section.title}
            settingId={
              group === 'profile' && section.title === '统计范围' ? 'profile-advanced' : undefined
            }
            icon={<SlidersHorizontal size={15} strokeWidth={1.8} />}
          >
            <div className="weq-intent-tuning-form">
              {section.keys.map((key) => {
                const rule = INTENT_TUNING[key];
                return (
                  <AutoSave
                    resetKeys={[key]}
                    key={key}
                    value={draft[key]?.trim() ? Number(draft[key]) : ''}
                    saved={status.data?.[key] ?? ''}
                    ready={ready && !disabled}
                    valid={valid([key])}
                    reset={() =>
                      setDraft((current) => ({
                        ...current,
                        [key]: String(status.data?.[key] ?? ''),
                      }))
                    }
                    save={(text) => patch({ [key]: Number(text) }, true)}
                  >
                    <Row
                      settingId={intentTuningSettingId(key)}
                      label={rule.label}
                      desc={`${INTENT_TUNING_HELP[key] ? `${INTENT_TUNING_HELP[key]} ` : ''}默认 ${rule.default}；范围 ${rule.min}–${rule.max}。`}
                      control={
                        <input
                          className="weq-set-input"
                          type="number"
                          aria-label={'ariaLabel' in rule ? rule.ariaLabel : rule.label}
                          min={rule.min}
                          max={rule.max}
                          step={'step' in rule ? rule.step : 1}
                          required
                          value={draft[key] ?? ''}
                          disabled={disabled || !ready}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [key]: event.target.value }))
                          }
                          style={{ width: 110 }}
                        />
                      }
                    />
                  </AutoSave>
                );
              })}
              {!ready ? <p>{status.isLoading ? '读取中…' : '当前主进程尚未提供参数'}</p> : null}
            </div>
          </Card>
        </Fragment>
      ))}
    </>
  );
}
