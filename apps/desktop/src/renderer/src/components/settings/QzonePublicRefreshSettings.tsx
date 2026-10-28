import { useEffect, useRef } from 'react';
import { Loader2, Save } from 'lucide-react';
import {
  DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
  MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
} from '@weq/service/qzone-public-settings';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast';
import { Card } from './controls';
import '../../styles/settings-qzone.css';

export function QzonePublicRefreshSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const save = trpc.bootstrap.setQzonePublicRefreshCooldown.useMutation();
  const saved = settings.data?.qzonePublicRefreshCooldownMinutes;
  const previous = useRef(saved);
  const [minutes, setMinutes] = usePageState(
    'qzone:public-refresh-minutes',
    () => String(saved ?? DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES),
    pageValue.string,
    true,
  );
  usePageDraftConfirmation(
    'qzone:public-refresh-minutes',
    saved === undefined ? undefined : String(saved),
  );
  useEffect(() => {
    if (saved === undefined) return;
    const before = previous.current ?? DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES;
    setMinutes((draft) => (draft === String(before) ? String(saved) : draft));
    previous.current = saved;
  }, [saved, setMinutes]);
  const value = Number(minutes);
  const valid =
    minutes.trim() !== '' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES;
  return (
    <Card title="空友爱看" settingId="qzone-public-refresh">
      <form
        className="weq-qzone-pagination-form weq-qzone-public-refresh-form"
        aria-label="空友爱看自动刷新"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || saved === undefined || save.isLoading) return;
          void save
            .mutateAsync({ minutes: value })
            .then(async () => {
              await settings.refetch();
              useToast.getState().push({ tone: 'success', title: '自动刷新冷却期已保存' });
            })
            .catch((error: unknown) => {
              useToast.getState().push({
                tone: 'error',
                title: '保存冷却期失败',
                detail: error instanceof Error ? error.message : String(error),
              });
            });
        }}
      >
        <label htmlFor="qzone-public-refresh-minutes">自动刷新冷却期</label>
        <input
          id="qzone-public-refresh-minutes"
          type="number"
          className="weq-set-input"
          min={0}
          max={MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES}
          step={1}
          required
          value={minutes}
          disabled={saved === undefined || save.isLoading}
          onChange={(event) => setMinutes(event.target.value)}
        />
        <span>分钟</span>
        <button
          type="submit"
          className="weq-set-btn"
          disabled={saved === undefined || !valid || save.isLoading}
        >
          {save.isLoading ? <Loader2 size={14} className="weq-spin" /> : <Save size={14} />}
          保存
        </button>
      </form>
    </Card>
  );
}
