import { useNumericSettingDraft } from './useNumericSettingDraft';
import { Heart } from 'lucide-react';
import { AutoSave } from './AutoSave';
import {
  DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
  MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
} from '@weq/service/qzone-public-settings';
import { trpc } from '../../trpc/client';
import { Card } from './controls';
import '../../styles/settings-qzone.css';

export function QzonePublicRefreshSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const save = trpc.bootstrap.setQzonePublicRefreshCooldown.useMutation();
  const saved = settings.data?.qzonePublicRefreshCooldownMinutes;
  const [minutes, setMinutes] = useNumericSettingDraft(
    'qzone:public-refresh-minutes',
    saved,
    DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
  );
  const value = Number(minutes);
  const valid =
    minutes.trim() !== '' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES;
  return (
    <Card
      title="空友爱看"
      icon={<Heart size={15} strokeWidth={1.8} />}
      settingId="qzone-public-refresh"
    >
      <AutoSave
        value={minutes.trim() ? Number(minutes) : ''}
        saved={saved ?? DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES}
        ready={saved !== undefined}
        valid={valid}
        reset={() => setMinutes(String(saved ?? DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES))}
        save={async (text) => {
          await save.mutateAsync({ minutes: Number(text) });
          await settings.refetch();
        }}
      >
        <div
          className="weq-qzone-pagination-form weq-qzone-public-refresh-form"
          aria-label="空友爱看自动刷新"
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
            disabled={saved === undefined}
            onChange={(event) => setMinutes(event.target.value)}
          />
          <span>分钟</span>
        </div>
      </AutoSave>
    </Card>
  );
}
