import { useEffect } from 'react';
import { useNumericSettingDraft } from './useNumericSettingDraft';
import { Bell } from 'lucide-react';
import { AutoSave } from './AutoSave';
import {
  DEFAULT_TOAST_DURATIONS,
  isToastDuration,
  MAX_TOAST_DURATION_SECONDS,
} from '@weq/service/toast-settings';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast';
import { Card, Row } from './controls';
import { useTabActive } from '../RetainedTabs';
import '../../styles/notification-settings.css';

export function ToastSettingsCard() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.bootstrap.setToastDuration.useMutation();
  const utils = trpc.useUtils();
  const saved = settings.data?.toastDurations ?? DEFAULT_TOAST_DURATIONS;
  useEffect(() => {
    if (settings.data?.toastDurations) useToast.getState().setDurations(saved);
  }, [saved, settings.data?.toastDurations]);
  return (
    <Card title="应用内横幅提醒" icon={<Bell size={15} />}>
      <DurationRow
        key="success"
        kind="success"
        initial={saved.successSeconds}
        disabled={settings.isLoading || settings.isError}
        save={async (seconds) => {
          const durations = await mutation.mutateAsync({ kind: 'success', seconds });
          useToast.getState().setDurations(durations);
          await utils.bootstrap.getSettings.invalidate();
        }}
      />
      <DurationRow
        key="failure"
        kind="failure"
        initial={saved.failureSeconds}
        disabled={settings.isLoading || settings.isError}
        save={async (seconds) => {
          const durations = await mutation.mutateAsync({ kind: 'failure', seconds });
          useToast.getState().setDurations(durations);
          await utils.bootstrap.getSettings.invalidate();
        }}
      />
      {settings.error && <p role="alert">{settings.error.message}</p>}
    </Card>
  );
}

function DurationRow({
  kind,
  initial,
  disabled,
  save,
}: {
  kind: 'success' | 'failure';
  initial: number;
  disabled: boolean;
  save: (seconds: number) => Promise<void>;
}) {
  const label = `${kind === 'success' ? '成功' : '失败'}通知停留时长`;
  const [value, setValue] = useNumericSettingDraft(
    `toast:${label}`,
    disabled ? undefined : initial,
    initial,
  );
  const seconds = value.trim() === '' ? NaN : Number(value);
  return (
    <AutoSave
      resetKeys={[kind === 'success' ? 'successSeconds' : 'failureSeconds']}
      value={value.trim() ? Number(value) : ''}
      saved={initial}
      ready={!disabled}
      valid={isToastDuration(seconds)}
      save={(text) => save(Number(text))}
      reset={() => setValue(String(initial))}
    >
      <Row
        label={label}
        desc="1 至 86400 秒；-1 表示不自动关闭"
        control={
          <div className="weq-toast-duration-control">
            <input
              type="number"
              className="weq-set-input"
              aria-label={label}
              min={-1}
              max={MAX_TOAST_DURATION_SECONDS}
              step={1}
              value={value}
              disabled={disabled}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
        }
      />
    </AutoSave>
  );
}
