import { useRef, useState } from 'react';
import { ArrowUpRight, Database, FolderOpen, ScrollText, Trash2 } from 'lucide-react';
import {
  HISTORY_CAPACITY_OPTIONS,
  historyCapacityLabel,
  type HistoryCapacityMiB,
} from '@weq/service/settings-catalog';
import { client, trpc } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useLogPerformanceWindow } from '../../state/logPerformanceWindow';
import { DesktopOnly } from '../../lib/target';
import { shellBridge } from '../../lib/target.shared';
import { historySize } from '../../lib/performanceRetention';
import { useRemoteClient } from '../../lib/remoteClient';
import { useDialog } from '../Dialog.shared';
import { Card, Row, QueryError } from './controls';
import { NativeDebugLogSetting } from './NativeDebugLogSetting';
import { RetentionDaysPicker } from './RetentionDaysPicker';
import { IconPicker } from '../ui/iconPicker';
import { AutoSave } from './AutoSave';
import '../../styles/log-performance.css';

type LogPolicy = { days: number; capacityMiB: HistoryCapacityMiB };

export function LogFileSettings() {
  const { enabled } = useQQReadActivity(true, { onlineOnly: false });
  const remote = useRemoteClient();
  const dialog = useDialog();
  const utils = trpc.useUtils();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
  });
  const storage = trpc.help.logStorage.useQuery(undefined, {
    enabled: enabled && !remote,
    refetchInterval: enabled && !remote ? 30_000 : false,
    refetchOnWindowFocus: false,
  });
  const mutation = trpc.bootstrap.setLogRetentionDays.useMutation();
  const clear = trpc.help.clearLogHistory.useMutation();
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<LogPolicy | null>(null);
  const [checking, setChecking] = useState(false);
  const confirmedPolicy = useRef<LogPolicy | null>(null);
  const saved: LogPolicy = {
    days: settings.data?.logRetentionDays ?? 7,
    capacityMiB: settings.data?.logCapacityMiB ?? 0,
  };
  const value = draft ?? saved;
  const busy = checking || mutation.isLoading || clear.isLoading;

  async function edit(patch: Partial<LogPolicy>) {
    if (!settings.data || busy) return;
    const next = { ...value, ...patch };
    if (next.days === value.days && next.capacityMiB === value.capacityMiB) return;
    setChecking(true);
    setMessage('');
    try {
      const preview = await client.bootstrap.previewLogRetention.query(next);
      if (preview.expiredFiles || preview.capacityFiles) {
        const lines = [`当前应用日志占用 ${historySize(preview.bytes)}。`];
        if (preview.expiredFiles)
          lines.push(`保存时长改为 ${next.days} 天，将删除 ${preview.expiredFiles} 份过期日志。`);
        if (preview.capacityFiles)
          lines.push(
            `容量上限设为 ${historyCapacityLabel(next.capacityMiB)}，预计从最旧的日志开始清理 ${preview.capacityFiles} 份。`,
          );
        if (
          !(await dialog.confirm('调整应用日志保存策略？', lines.join('\n\n'), {
            danger: 'outline',
            okLabel: '保存并删除',
            tone: 'warning',
          }))
        )
          return;
        confirmedPolicy.current = next;
      }
      setDraft(next);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  }

  async function save(next: LogPolicy) {
    const result = await mutation.mutateAsync({
      ...next,
      confirmPrune: next === confirmedPolicy.current,
    });
    if (next === confirmedPolicy.current) confirmedPolicy.current = null;
    await Promise.all([settings.refetch(), utils.help.logStorage.invalidate()]);
    setDraft((current) => (current === next ? null : current));
    if (result.failed) setMessage(`已保存设置，${result.failed} 份日志未能删除。`);
  }

  async function clearHistory() {
    setChecking(true);
    setMessage('');
    try {
      if (
        !(await dialog.confirm(
          '清空应用日志历史？',
          '会删除已结束写入的应用日志，保留正在写入的日志和原生调试日志。清空后无法恢复。',
          { danger: 'outline', okLabel: '清空历史', tone: 'error' },
        ))
      )
        return;
      const result = await clear.mutateAsync(true);
      await Promise.all([utils.help.logStorage.invalidate(), utils.help.listLogFiles.invalidate()]);
      setMessage(
        result.failed
          ? `已清理 ${result.removed} 份日志，${result.failed} 份未能删除。`
          : '应用日志历史已清空',
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card
      title="应用日志"
      icon={<ScrollText size={15} />}
      resetId="logs"
      action={
        <button
          type="button"
          className="weq-set-btn weq-set-btn-soft"
          onClick={() => useLogPerformanceWindow.getState().open('logs')}
        >
          打开日志查看
          <ArrowUpRight size={14} />
        </button>
      }
    >
      {settings.error && (
        <QueryError
          message={settings.error.message}
          retryLabel="重新读取日志设置"
          onRetry={() => void settings.refetch()}
        />
      )}
      <NativeDebugLogSetting />
      {!remote && (
        <AutoSave
          value={value}
          saved={saved}
          ready={!!settings.data}
          save={save}
          reset={() => setDraft(null)}
          resetKeys={['logRetentionDays', 'logCapacityMiB']}
        >
          <Row
            settingId="log-retention"
            label="保存时长"
            desc="超出保存时长的日志会自动清理。"
            control={
              <RetentionDaysPicker
                label="应用日志保存时长"
                days={settings.data ? value.days : undefined}
                disabled={!settings.data || busy}
                onChange={(days) => void edit({ days })}
              />
            }
          />
          <Row
            settingId="log-capacity"
            label="容量上限"
            desc="超出容量上限时，从最旧的应用日志开始清理。"
            control={
              <IconPicker
                ariaLabel="应用日志容量上限"
                triggerIcon={<Database size={14} />}
                placeholder="正在读取…"
                value={settings.data ? String(value.capacityMiB) : ''}
                disabled={!settings.data || busy}
                onChange={(capacityMiB) =>
                  void edit({ capacityMiB: Number(capacityMiB) as LogPolicy['capacityMiB'] })
                }
                options={HISTORY_CAPACITY_OPTIONS}
              />
            }
          />
        </AutoSave>
      )}
      <Row
        settingId="log-storage"
        label="存储占用"
        remoteUnsupported
        desc={
          storage.data
            ? `${historySize(storage.data.bytes)} · ${storage.data.files} 份日志`
            : storage.error
              ? '读取占用失败'
              : '正在读取…'
        }
        control={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-del"
            disabled={busy || !storage.data?.historyFiles}
            onClick={() => void clearHistory()}
          >
            <Trash2 size={14} />
            清空应用日志历史
          </button>
        }
      />
      <DesktopOnly>
        <Row
          settingId="log-folder"
          label="文件夹"
          control={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              onClick={async () => {
                setMessage('');
                try {
                  if (!(await shellBridge()?.openLogDir()))
                    throw new Error('应用日志文件夹暂不可用');
                } catch (reason) {
                  setMessage(reason instanceof Error ? reason.message : String(reason));
                }
              }}
            >
              <FolderOpen size={14} />
              打开应用日志文件夹
            </button>
          }
        />
      </DesktopOnly>
      {message && (
        <p role="status" className="weq-diagnostic-feedback">
          {message}
        </p>
      )}
    </Card>
  );
}
