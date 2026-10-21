import { useEffect, useRef, useState } from 'react';
import { Bell, Loader2, Save } from 'lucide-react';
import {
  DEFAULT_TOAST_DURATIONS,
  isToastDuration,
  MAX_TOAST_DURATION_SECONDS,
} from '@weq/service/toast-settings';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast';
import { Card, Row } from './controls';
import '../../styles/notification-settings.css';

export function ToastSettingsCard() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.bootstrap.setToastDuration.useMutation();
  const utils = trpc.useUtils();
  const saved = settings.data?.toastDurations ?? DEFAULT_TOAST_DURATIONS;
  return (
    <Card title="通知" icon={<Bell size={15} />}>
      <DurationRow
        key="success"
        kind="success"
        initial={saved.successSeconds}
        disabled={settings.isLoading || settings.isError || mutation.isLoading}
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
        disabled={settings.isLoading || settings.isError || mutation.isLoading}
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
  const [value, setValue] = useState(String(initial));
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const previous = useRef(String(initial));
  useEffect(() => {
    setValue((draft) => (draft === previous.current ? String(initial) : draft));
    previous.current = String(initial);
  }, [initial]);
  const seconds = value.trim() === '' ? NaN : Number(value);
  const canSave = !disabled && !saving && isToastDuration(seconds) && seconds !== initial;
  async function submit() {
    if (!canSave || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await save(seconds);
      useToast.getState().push({ tone: 'success', title: `${label}已保存` });
    } catch (error) {
      useToast.getState().push({
        tone: 'error',
        title: '通知设置保存失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
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
            disabled={disabled || saving}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label={`保存${label}`}
            title={`保存${label}`}
            disabled={!canSave}
            onClick={() => void submit()}
          >
            {saving ? <Loader2 size={16} className="weq-spin" /> : <Save size={16} />}
          </button>
        </div>
      }
    />
  );
}
