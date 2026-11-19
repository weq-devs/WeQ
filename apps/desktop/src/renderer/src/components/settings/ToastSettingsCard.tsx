import { useEffect } from 'react';
import { useNumericSettingDraft } from './useNumericSettingDraft';
import { Bell } from 'lucide-react';
import { AutoSave } from './AutoSave';
import {
  DEFAULT_TOAST_DURATIONS,
  isToastDuration,
  MAX_TOAST_DURATION_SECONDS,
  TOAST_TIMED_KINDS,
  type ToastTimedKind,
} from '@weq/service/toast-settings';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast.shared';
import { Card, Row } from './controls';
import { useTabActive } from '../RetainedTabs.shared';
import '../../styles/notification-settings.css';

const durationLabels: Record<ToastTimedKind, string> = {
  success: '成功通知停留时长',
  failure: '失败通知停留时长',
  message: '消息通知停留时长',
};

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
      {TOAST_TIMED_KINDS.map((kind) => (
        <DurationRow
          key={kind}
          kind={kind}
          initial={saved[`${kind}Seconds`]}
          disabled={settings.isLoading || settings.isError}
          save={async (seconds) => {
            const durations = await mutation.mutateAsync({ kind, seconds });
            useToast.getState().setDurations(durations);
            await utils.bootstrap.getSettings.invalidate();
          }}
        />
      ))}
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
  kind: ToastTimedKind;
  initial: number;
  disabled: boolean;
  save: (seconds: number) => Promise<void>;
}) {
  const label = durationLabels[kind];
  const [value, setValue] = useNumericSettingDraft(
    `toast:${label}`,
    disabled ? undefined : initial,
    initial,
  );
  const seconds = value.trim() === '' ? NaN : Number(value);
  return (
    <AutoSave
      resetKeys={[`${kind}Seconds`]}
      value={value.trim() ? Number(value) : ''}
      saved={initial}
      ready={!disabled}
      valid={isToastDuration(seconds)}
      save={(text) => save(Number(text))}
      reset={() => setValue(String(initial))}
    >
      <Row
        settingId={`toast-${kind}`}
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
