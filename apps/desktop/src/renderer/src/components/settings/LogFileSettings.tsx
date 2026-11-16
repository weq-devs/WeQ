import { useState } from 'react';
import { ArrowUpRight, Clock3, FolderOpen, ScrollText } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useLogPerformanceWindow } from '../../state/logPerformanceWindow';
import { DesktopOnly, shellBridge } from '../../lib/target';
import { Card, Row, QueryError } from './controls';
import { NativeDebugLogSetting } from './NativeDebugLogSetting';
import { IconPicker } from '../ui/iconPicker';
import { AutoSave } from './AutoSave';

const retentionOptions = [1, 3, 7, 14, 30, 90, 0];
export function LogFileSettings() {
  const { enabled } = useQQReadActivity(true, { onlineOnly: false });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
  });
  const mutation = trpc.bootstrap.setLogRetentionDays.useMutation();
  const [error, setError] = useState('');
  const [draftDays, setDraftDays] = useState<number | null>(null);
  const days = settings.data?.logRetentionDays;
  const save = async (value: number) => {
    await mutation.mutateAsync({ days: value });
    await settings.refetch();
    setDraftDays((current) => (current === value ? null : current));
  };
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
      <AutoSave
        value={draftDays ?? days ?? 7}
        saved={days ?? 7}
        ready={days !== undefined}
        save={save}
        reset={() => setDraftDays(null)}
        resetKeys={['logRetentionDays']}
      >
        <Row
          settingId="log-retention"
          remoteUnsupported
          label="日志保留时长"
          desc={days === 0 ? '永久保留全部日志。' : '按天自动清理，正在写入的当天日志始终保留。'}
          control={
            <IconPicker
              ariaLabel="日志保留时长"
              triggerIcon={<Clock3 size={14} />}
              placeholder="正在读取…"
              value={days === undefined ? '' : String(draftDays ?? days)}
              disabled={days === undefined || mutation.isLoading}
              onChange={(value) => setDraftDays(Number(value))}
              options={[
                ...(days !== undefined && !retentionOptions.includes(days)
                  ? [{ value: String(days), label: `${days} 天` }]
                  : []),
                ...retentionOptions.map((value) => ({
                  value: String(value),
                  label: value === 0 ? '永久保留' : `${value} 天`,
                })),
              ]}
            />
          }
        />
      </AutoSave>
      <NativeDebugLogSetting />
      <DesktopOnly>
        <Row
          settingId="log-folder"
          label="日志文件夹"
          control={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              onClick={async () => {
                try {
                  await shellBridge()?.openLogDir();
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
                }
              }}
            >
              <FolderOpen size={14} />
              打开日志文件夹
            </button>
          }
        />
      </DesktopOnly>
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
