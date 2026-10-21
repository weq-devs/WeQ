import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import {
  INTENT_TUNING,
  INTENT_TUNING_HELP,
  INTENT_TUNING_KEYS,
  isIntentTuningValue,
  type IntentTuningKey,
} from '@weq/service/intent-context';
import { trpc } from '../../trpc/client';
import { Card, Row } from './controls';
import { useDialog } from '../Dialog';

const TITLES = {
  analysis: '分析范围与时效',
  suggestions: '生成与缓存',
  profile: '统计与采样',
  advanced: '请求与缓存',
};

export function IntentTuningPanel({ group }: { group: keyof typeof TITLES }) {
  const keys = useMemo(
    () => INTENT_TUNING_KEYS.filter((key) => INTENT_TUNING[key].group === group),
    [group],
  );
  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const save = trpc.account.intentSense.setConfig.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  const baseline = useRef<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
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
  }, [keys, status.data]);
  const ready = keys.every((key) => isIntentTuningValue(key, status.data?.[key]));
  const valid = keys.every(
    (key) => draft[key]?.trim() && isIntentTuningValue(key, Number(draft[key])),
  );
  const dirty = keys.some((key) => Number(draft[key]) !== status.data?.[key]);

  async function submit() {
    if (!ready || !valid || !dirty || save.isLoading) return;
    try {
      const patch: Partial<Record<IntentTuningKey, number>> = {};
      for (const key of keys)
        if (Number(draft[key]) !== status.data?.[key]) patch[key] = Number(draft[key]);
      const next = await save.mutateAsync(patch);
      utils.account.intentSense.getStatus.setData(undefined, next);
      void utils.account.intentSense.listMessageAnalyses.invalidate();
      void utils.account.intentSense.getSuggestions.invalidate();
      void utils.account.intentSense.getProfile.invalidate();
    } catch (error) {
      showError('参数保存失败', String(error));
    }
  }

  return (
    <Card title={TITLES[group]}>
      <form
        // 小数步长只用于增减；输入精度与其它规则统一交给共享校验器。
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {keys.map((key) => {
          const rule = INTENT_TUNING[key];
          return (
            <Row
              key={key}
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
                  disabled={!ready || save.isLoading}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [key]: event.target.value }))
                  }
                  style={{ width: 110 }}
                />
              }
            />
          );
        })}
        <Row
          label={ready ? undefined : status.isLoading ? '读取中…' : '当前主进程尚未提供参数'}
          control={
            <>
              <button
                type="button"
                className="weq-set-iconbtn"
                title="恢复默认值"
                aria-label={`恢复${TITLES[group]}默认值`}
                disabled={!ready || save.isLoading}
                onClick={() =>
                  setDraft(
                    Object.fromEntries(
                      keys.map((key) => [key, String(INTENT_TUNING[key].default)]),
                    ),
                  )
                }
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="submit"
                className="weq-set-btn"
                disabled={!ready || !valid || !dirty || save.isLoading}
              >
                <Save size={14} />
                保存
              </button>
            </>
          }
        />
      </form>
    </Card>
  );
}
