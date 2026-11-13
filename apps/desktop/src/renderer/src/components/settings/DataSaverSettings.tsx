import { CloudDownload } from 'lucide-react';
import {
  dataSaverBehaviorDefaults,
  type DataSaverMode,
  type DataSaverBehavior,
  type NetworkCost,
} from '@weq/service/data-saver';
import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { useDataSaver } from '../../lib/dataSaver';
import { IS_WEB } from '../../lib/target';
import { Card, Row, Toggle } from './controls';
import { RotateCcw } from 'lucide-react';
import '../../styles/data-saver-settings.css';
import { useContext, useEffect, useState } from 'react';
import { SettingsResetContext } from './resetContext';

const mediaOptions = [
  ['dataSaverAvatars', '自动加载未缓存的头像'],
  ['dataSaverEmoji', '自动下载表情图片'],
  ['dataSaverDress', '自动下载个性装扮'],
  ['dataSaverVideoCovers', '自动加载视频封面'],
  ['dataSaverPrefetch', '预加载屏幕外媒体'],
  ['dataSaverLinkPreviews', '自动获取链接预览'],
] as const;
const taskOptions = [
  ['dataSaverPauseBatch', '暂停联网批量任务', '纯本地任务不受影响。'],
  ['dataSaverPauseLarge', '暂停大文件下载', '达到下方阈值时暂停，可在任务中选择本次继续。'],
] as const;
function BooleanRow({
  name,
  label,
  desc,
}: {
  name: Exclude<keyof DataSaverBehavior, 'dataSaverImageLoading' | 'dataSaverLargeMiB'>;
  label: string;
  desc?: string;
}) {
  return (
    <Row
      label={label}
      desc={desc}
      control={
        <Toggle
          label={label}
          checked={preferenceValue(name)}
          onChange={(value) => void changePreference(name, value)}
        />
      }
    />
  );
}
function TransferThreshold() {
  const saved = preferenceValue('dataSaverLargeMiB');
  const [draft, setDraft] = useState(String(saved));
  useEffect(() => setDraft(String(saved)), [saved]);
  return (
    <Row
      label="大文件暂停阈值"
      control={
        <label className="weq-data-saver-limit">
          <input
            className="weq-set-input"
            type="number"
            min={1}
            max={1048576}
            step={1}
            aria-label="大文件暂停阈值"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              const value = Number(draft);
              if (Number.isInteger(value) && value >= 1 && value <= 1048576) {
                if (value !== saved) void changePreference('dataSaverLargeMiB', value);
              } else setDraft(String(saved));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span>MiB</span>
        </label>
      }
    />
  );
}

function describe(cost: NetworkCost) {
  if (cost.state === 'unknown') return '无法检测';
  if (cost.state === 'unrestricted') return '不受限';
  return [cost.constrained && '低数据模式', cost.metered && '计费网络'].filter(Boolean).join('、');
}
export function DataSaverSettings() {
  const reset = useContext(SettingsResetContext);
  const { error } = useClientPreferences();
  const { host, local, enabled } = useDataSaver();
  return (
    <Card
      title="省流量模式"
      icon={<CloudDownload size={15} />}
      settingId="data-saver"
      action={
        reset ? undefined : (
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title="恢复省流量默认设置"
            aria-label="恢复省流量默认设置"
            onClick={() => {
              void changePreference('dataSaverMode', 'auto');
              for (const [key, value] of Object.entries(dataSaverBehaviorDefaults))
                void changePreference(key as keyof DataSaverBehavior, value);
            }}
          >
            <RotateCcw size={14} aria-hidden />
          </button>
        )
      }
    >
      <Row
        label="省流量模式"
        desc={`${enabled ? '正在节省流量' : '正常加载'} · 本端：${describe(local)}${IS_WEB ? ` · 宿主：${describe(host)}` : ''}`}
        control={
          <select
            className="weq-set-input"
            aria-label="省流量模式"
            value={preferenceValue('dataSaverMode')}
            onChange={(event) =>
              void changePreference('dataSaverMode', event.target.value as DataSaverMode)
            }
          >
            <option value="always">开启</option>
            <option value="never">关闭</option>
            <option value="auto">跟随系统</option>
          </select>
        }
      />
      <div className="weq-data-saver-behavior">
        <h4>省流量模式下的行为</h4>
        <p>仅在省流量模式生效时应用，已有缓存照常使用。</p>
      </div>
      <h5 className="weq-data-saver-group">图片与媒体</h5>
      <Row
        label="聊天图片自动加载"
        control={
          <select
            className="weq-set-input"
            aria-label="聊天图片自动加载"
            value={preferenceValue('dataSaverImageLoading')}
            onChange={(event) =>
              void changePreference(
                'dataSaverImageLoading',
                event.target.value as DataSaverBehavior['dataSaverImageLoading'],
              )
            }
          >
            <option value="none">不自动加载</option>
            <option value="thumbnail">仅小图</option>
            <option value="original">原图</option>
          </select>
        }
      />
      {mediaOptions.map(([name, label]) => (
        <BooleanRow key={name} name={name} label={label} />
      ))}
      <h5 className="weq-data-saver-group">下载与任务</h5>
      {taskOptions.map(([name, label, desc]) => (
        <BooleanRow key={name} name={name} label={label} desc={desc} />
      ))}
      <TransferThreshold />
      <BooleanRow
        name="dataSaverAutoResume"
        label="限制解除后自动继续任务"
        desc="仅恢复因省流量策略暂停的任务，手动暂停的任务保持暂停。"
      />
      {error ? (
        <p className="weq-set-note" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
