import { useState } from 'react';
import { Save } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import {
  FULL_FORMATS,
  CHATLAB_FORMATS,
  isBackendFormat,
  type BackendFormat,
  type ScheduledTask,
} from '../../views/export/types';

export function ScheduleSettings({ schedule }: { schedule: ScheduledTask }) {
  const allowedFormats = (schedule.chatlab ? CHATLAB_FORMATS : FULL_FORMATS)
    .map((item) => item.value)
    .filter(
      (format): format is BackendFormat | 'html' => isBackendFormat(format) || format === 'html',
    );
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const [name, setName] = useState(schedule.name);
  const [cadence, setCadence] = useState(schedule.schedule);
  const [formats, setFormats] = useState(
    (schedule.formats?.length ? schedule.formats : [schedule.format]).filter(
      (format): format is BackendFormat | 'html' =>
        allowedFormats.some((allowed) => allowed === format),
    ),
  );
  const update = trpc.account.updateSchedule.useMutation({
    onSuccess: (result) => {
      if (!result) {
        dialog.error('保存定时任务失败', '该计划已不存在，请刷新任务列表。');
        return;
      }
      void utils.account.listSchedules.invalidate();
      dialog.success('已保存', '定时任务设置已更新');
    },
    onError: (error) => dialog.error('保存定时任务失败', error.message),
  });
  return (
    <form
      className="weq-schedule-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !name.trim() ||
          !formats.length ||
          (cadence.mode === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cadence.time)) ||
          (cadence.mode === 'interval' &&
            (!Number.isInteger(cadence.intervalHours) ||
              cadence.intervalHours < 1 ||
              cadence.intervalHours > 168))
        )
          return;
        update.mutate({
          id: schedule.id,
          patch: {
            name: name.trim(),
            format: formats[0],
            formats,
            ...(cadence.mode !== schedule.schedule.mode ||
            cadence.time !== schedule.schedule.time ||
            cadence.intervalHours !== schedule.schedule.intervalHours
              ? { schedule: cadence }
              : {}),
          },
        });
      }}
    >
      <label>
        任务名称
        <input value={name} required onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        执行方式
        <select
          value={cadence.mode}
          onChange={(event) =>
            setCadence({ ...cadence, mode: event.target.value === 'daily' ? 'daily' : 'interval' })
          }
        >
          <option value="daily">每天定时</option>
          <option value="interval">间隔执行</option>
        </select>
      </label>
      {cadence.mode === 'daily' ? (
        <label>
          执行时间（运行设备时区）
          <input
            type="time"
            value={cadence.time}
            required
            onChange={(event) => setCadence({ ...cadence, time: event.target.value })}
          />
        </label>
      ) : (
        <label>
          间隔小时
          <input
            type="number"
            min={1}
            max={168}
            step={1}
            required
            value={cadence.intervalHours}
            onChange={(event) =>
              setCadence({ ...cadence, intervalHours: Number(event.target.value) })
            }
          />
        </label>
      )}
      <fieldset>
        <legend>导出格式</legend>
        {allowedFormats.map((format) => (
          <label key={format}>
            <input
              type="checkbox"
              checked={formats.includes(format)}
              onChange={(event) =>
                setFormats(
                  event.target.checked
                    ? [...formats, format]
                    : formats.filter((item) => item !== format),
                )
              }
            />
            {format.toUpperCase()}
          </label>
        ))}
      </fieldset>
      <section aria-label="定时导出范围">
        <strong>导出会话</strong>
        {schedule.conversations.map((conversation) => (
          <div key={`${conversation.kind}:${conversation.id}`}>{conversation.name}</div>
        ))}
      </section>
      <button
        type="submit"
        className="weq-set-btn"
        disabled={update.isLoading || !formats.length || !name.trim()}
      >
        <Save size={15} />
        {update.isLoading ? '保存中…' : '保存设置'}
      </button>
    </form>
  );
}
