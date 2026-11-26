import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Clock3, FolderOpen, Trash2 } from 'lucide-react';
import type { MonitorMode, MonitorSettings } from '@weq/service/performance';
import { preciseTimeFormatter } from '@weq/time';
import { trpc, client } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useLogPerformanceWindow } from '../../state/logPerformanceWindow';
import { DesktopOnly } from '../../lib/target';
import { DEFAULT_HISTORY_CAPACITY_MIB } from '@weq/service/settings-catalog';
import { historySize, performancePruneMessage } from '../../lib/performanceRetention';
import { useDialog } from '../Dialog.shared';
import { SegmentedControl } from '../SegmentedControl';
import { IconPicker } from '../ui/iconPicker';
import { AutoSave } from './AutoSave';
import { LogFileSettings } from './LogFileSettings';
import { RetentionCapacityPicker, RetentionDaysPicker } from './HistoryRetentionPicker';
import { Card, QueryError, Row, SectionHeader } from './controls';
import '../../styles/log-performance.css';

const time = (at: number) => preciseTimeFormatter.format(new Date(at));
interface RecordingDraft {
  mode: MonitorMode;
  days: number;
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
  const openFolder = trpc.performanceMonitor.openFolder.useMutation();
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
    days: settings?.retentionDays ?? 7,
    capacity: settings?.capacityMiB ?? DEFAULT_HISTORY_CAPACITY_MIB,
    duration: savedDuration,
  };
  const value = draft ?? saved;
  const busy = configure.isLoading || clear.isLoading || checking;
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
        retentionDays: next.days,
        capacityMiB: next.capacity,
      });
      if (!mounted.current) return;
      if (
        preview.needsPrune &&
        !(await dialog.confirm('调整性能记录保存策略？', performancePruneMessage(preview), {
          danger: 'outline',
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
      retentionDays: next.days,
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
      <SectionHeader title="日志与性能" page="logs" />
      <LogFileSettings />
      <Card
        title="性能记录"
        icon={<Activity size={15} />}
        settingId="performance-monitor"
        resetId="performance-recording"
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
          save={save}
          resetKeys={['mode']}
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
              indent
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
            settingId="performance-retention"
            label="保存时长"
            desc="超出保存时长的性能记录会自动清理。"
            control={
              <RetentionDaysPicker
                label="性能记录保存时长"
                value={settings ? value.days : undefined}
                disabled={!settings || busy}
                onChange={(days) => void edit({ days })}
              />
            }
          />
          <Row
            settingId="performance-capacity"
            label="容量上限"
            desc="超出容量上限时，从最旧的性能记录开始清理。"
            control={
              <RetentionCapacityPicker
                label="性能记录容量上限"
                value={settings ? value.capacity : undefined}
                disabled={!settings || busy}
                onChange={(capacity) => void edit({ capacity })}
              />
            }
          />
        </AutoSave>
        <Row
          settingId="performance-storage"
          label="存储占用"
          desc={
            status.data
              ? `${historySize(status.data.bytes)} · ${status.data.records} 条记录`
              : status.error
                ? '读取占用失败'
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
                    '清空性能记录历史？',
                    '会删除全部性能历史。清空后无法恢复。',
                    { danger: 'outline', okLabel: '清空历史', tone: 'error' },
                  ))
                )
                  return;
                try {
                  await clear.mutateAsync(true);
                  await utils.performanceMonitor.invalidate();
                  setMessage('性能记录历史已清空');
                } catch (reason) {
                  setMessage(reason instanceof Error ? reason.message : String(reason));
                }
              }}
            >
              <Trash2 size={14} />
              清空性能记录历史
            </button>
          }
        />
        <DesktopOnly>
          <Row
            settingId="performance-folder"
            label="文件夹"
            control={
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={openFolder.isLoading}
                onClick={async () => {
                  setMessage('');
                  try {
                    await openFolder.mutateAsync();
                  } catch (reason) {
                    setMessage(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
              >
                <FolderOpen size={14} />
                打开性能记录文件夹
              </button>
            }
          />
        </DesktopOnly>
        {status.data?.error && <p role="alert">记录异常：{status.data.error}</p>}
      </Card>
      {message && (
        <p role="status" className="weq-diagnostic-feedback">
          {message}
        </p>
      )}
    </div>
  );
}
