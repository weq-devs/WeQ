import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Clock3, Database, Trash2 } from 'lucide-react';
import type { MonitorMode, MonitorSettings } from '@weq/service/performance';
import { preciseTimeFormatter } from '@weq/time';
import { trpc, client } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useLogPerformanceWindow } from '../../state/logPerformanceWindow';
import { performancePruneMessage } from '../../lib/performanceRetention';
import { useDialog } from '../Dialog';
import { SegmentedControl } from '../SegmentedControl';
import { IconPicker } from '../ui/iconPicker';
import { AutoSave } from './AutoSave';
import { LogFileSettings } from './LogFileSettings';
import { Card, QueryError, Row, SectionHeader } from './controls';
import '../../styles/log-performance.css';

const time = (at: number) => preciseTimeFormatter.format(new Date(at));
interface RecordingDraft {
  mode: MonitorMode;
  days: string;
  capacity: MonitorSettings['capacityMiB'];
  duration: string;
}

export default function LogPerformanceSettings() {
  const activity = useQQReadActivity(true, { onlineOnly: false });
  const status = trpc.performanceMonitor.status.useQuery(undefined, {
    enabled: activity.enabled,
    refetchInterval: activity.enabled ? 10_000 : false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const configure = trpc.performanceMonitor.configure.useMutation();
  const clear = trpc.performanceMonitor.clear.useMutation();
  const utils = trpc.useUtils();
  const dialog = useDialog();
  const [draft, setDraft] = useState<RecordingDraft | null>(null);
  const [savedDuration, setSavedDuration] = useState('keep');
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const confirmedPolicy = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settings = status.data?.settings;
  const saved: RecordingDraft = {
    mode: settings?.mode ?? 'light',
    days: String(settings?.retentionDays ?? 7),
    capacity: settings?.capacityMiB ?? 128,
    duration: savedDuration,
  };
  const value = draft ?? saved;
  const busy = configure.isLoading || clear.isLoading || checking;
  const valid =
    Number.isInteger(Number(value.days)) && Number(value.days) >= 1 && Number(value.days) <= 365;
  const edit = async (patch: Partial<RecordingDraft>) => {
    if (!settings || busy || checkingRef.current) return;
    const next = { ...value, ...patch };
    if (patch.days === undefined && patch.capacity === undefined) {
      setDraft(next);
      return;
    }
    if (next.days === value.days && next.capacity === value.capacity) return;
    checkingRef.current = true;
    setChecking(true);
    setMessage('');
    try {
      const preview = await client.performanceMonitor.previewPrune.query({
        retentionDays: Number(next.days),
        capacityMiB: next.capacity,
      });
      if (!mounted.current) return;
      if (
        preview.needsPrune &&
        !(await dialog.confirm('调整性能历史保存策略？', performancePruneMessage(preview), {
          okLabel: '保存并删除',
          tone: 'warning',
        }))
      )
        return;
      if (!mounted.current) return;
      confirmedPolicy.current = preview.needsPrune
        ? JSON.stringify([next.days, next.capacity])
        : null;
      setDraft(next);
    } catch (reason) {
      if (mounted.current) setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  };
  const save = async (next: RecordingDraft) => {
    if (!settings) return;
    await configure.mutateAsync({
      mode: next.mode,
      retentionDays: Number(next.days),
      capacityMiB: next.capacity,
      fullDurationMinutes:
        next.mode === 'full' &&
        next.duration !== 'keep' &&
        (next.duration !== savedDuration || settings.mode !== 'full')
          ? next.duration === 'continuous'
            ? null
            : (Number(next.duration) as 15 | 60 | 240)
          : undefined,
      confirmPrune: confirmedPolicy.current === JSON.stringify([next.days, next.capacity]),
    });
    if (confirmedPolicy.current === JSON.stringify([next.days, next.capacity]))
      confirmedPolicy.current = null;
    setSavedDuration(next.duration);
    await utils.performanceMonitor.invalidate();
    setDraft((current) => (JSON.stringify(current) === JSON.stringify(next) ? null : current));
  };
  return (
    <div className="weq-set weq-log-performance-settings" data-setting-id="logs">
      <SectionHeader title="日志与性能" icon={<Activity size={16} />} />
      <Card
        title="性能记录"
        icon={<Activity size={15} />}
        settingId="performance-monitor"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            onClick={() => useLogPerformanceWindow.getState().open('performance')}
          >
            打开性能监视
            <ArrowUpRight size={14} />
          </button>
        }
      >
        {status.error && (
          <QueryError
            message={status.error.message}
            retryLabel="重新读取性能设置"
            onRetry={() => void status.refetch()}
          />
        )}
        <AutoSave
          value={value}
          saved={saved}
          ready={!!settings}
          valid={valid}
          save={save}
          reset={() => setDraft(null)}
        >
          <Row
            label="记录档位"
            desc="轻量记录每 30 秒采样，完整记录每 10 秒采样。"
            control={
              <SegmentedControl<MonitorMode>
                label="记录档位"
                value={settings ? value.mode : null}
                disabled={!settings || busy}
                onChange={(mode) => void edit({ mode, duration: mode === 'full' ? '60' : 'keep' })}
                options={[
                  { value: 'off', label: '关闭' },
                  { value: 'light', label: '轻量记录' },
                  { value: 'full', label: '完整记录' },
                ]}
              />
            }
          />
          {value.mode === 'full' && (
            <Row
              label="完整记录时长"
              desc={
                settings?.mode === 'full'
                  ? settings.fullUntil
                    ? `记录至 ${time(settings.fullUntil)}`
                    : '持续记录'
                  : undefined
              }
              control={
                <IconPicker
                  ariaLabel="完整记录时长"
                  triggerIcon={<Clock3 size={14} />}
                  value={value.duration}
                  disabled={busy}
                  onChange={(duration) => void edit({ duration })}
                  options={[
                    ...(value.duration === 'keep' ? [{ value: 'keep', label: '当前计划' }] : []),
                    { value: '15', label: '15 分钟' },
                    { value: '60', label: '一小时' },
                    { value: '240', label: '四小时' },
                    { value: 'continuous', label: '持续' },
                  ]}
                />
              }
            />
          )}
          <Row
            label="保存时长"
            desc="超出期限或容量上限时，自动删除最旧历史。"
            control={
              <div className="weq-diagnostic-inline">
                <IconPicker
                  ariaLabel="保存时长"
                  triggerIcon={<Clock3 size={14} />}
                  value={['1', '3', '7', '14', '30'].includes(value.days) ? value.days : 'custom'}
                  disabled={!settings || busy}
                  onChange={(days) => void edit({ days: days === 'custom' ? '8' : days })}
                  options={[
                    ...[1, 3, 7, 14, 30].map((days) => ({
                      value: String(days),
                      label: `${days} 天`,
                    })),
                    { value: 'custom', label: '自定义' },
                  ]}
                />
                {!['1', '3', '7', '14', '30'].includes(value.days) && (
                  <span className="weq-set-unit-field">
                    <input
                      key={value.days}
                      className="weq-set-input weq-number"
                      aria-label="保存天数"
                      type="number"
                      min="1"
                      max="365"
                      defaultValue={value.days}
                      disabled={busy}
                      onBlur={(event) => {
                        const next = event.currentTarget.valueAsNumber;
                        if (Number.isInteger(next) && next >= 1 && next <= 365)
                          void edit({ days: String(next) });
                        else event.currentTarget.value = value.days;
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                    <span className="weq-set-unit">天</span>
                  </span>
                )}
              </div>
            }
          />
          <Row
            label="容量上限"
            control={
              <IconPicker
                ariaLabel="容量上限"
                triggerIcon={<Database size={14} />}
                value={String(value.capacity)}
                disabled={!settings || busy}
                onChange={(capacity) =>
                  void edit({ capacity: Number(capacity) as MonitorSettings['capacityMiB'] })
                }
                options={[64, 128, 256, 512].map((size) => ({
                  value: String(size),
                  label: `${size} MiB`,
                }))}
              />
            }
          />
        </AutoSave>
        <Row
          label="存储占用"
          desc={
            status.data
              ? `${(status.data.bytes / 1048576).toFixed(2)} MiB · ${status.data.records} 条记录`
              : '正在读取…'
          }
          control={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-del"
              disabled={busy || !status.data}
              onClick={async () => {
                if (
                  !(await dialog.confirm(
                    '清空性能历史？',
                    '会删除此宿主的全部性能采样记录，此操作不可撤销。',
                    { okLabel: '清空历史', tone: 'error' },
                  ))
                )
                  return;
                try {
                  await clear.mutateAsync(true);
                  await utils.performanceMonitor.invalidate();
                  setMessage('历史已清空');
                } catch (reason) {
                  setMessage(reason instanceof Error ? reason.message : String(reason));
                }
              }}
            >
              <Trash2 size={14} />
              清空性能历史
            </button>
          }
        />
        {status.data?.error && <p role="alert">记录异常：{status.data.error}</p>}
      </Card>
      <LogFileSettings />
      {message && (
        <p role="status" className="weq-diagnostic-feedback">
          {message}
        </p>
      )}
    </div>
  );
}
