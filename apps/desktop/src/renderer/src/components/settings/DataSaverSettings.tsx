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
import { useDataSaver, dataSaverModeOptions } from '../../lib/dataSaver';
import { SegmentedControl } from '../SegmentedControl';
import { IS_WEB } from '../../lib/target.shared';
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
  const enabled = preferenceValue('dataSaverPauseLarge');
  const [draft, setDraft] = useState(String(saved));
  useEffect(() => setDraft(String(saved)), [saved]);
  if (!enabled) return null;
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
  useClientPreferences((state) => state.tick);
  const { host, local, enabled } = useDataSaver();
  return (
    <Card
      title="省流量模式"
      icon={<CloudDownload size={15} />}
      settingId="data-saver"
      action={
        reset ? undefined : (
          <button
            data-danger="outline"
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title="恢复省流量默认设置"
            aria-label="恢复省流量默认设置"
            onClick={() => {
              void changePreference('dataSaverMode', 'auto');
              void changePreference('autoDownloadPreviewOriginal', false);
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
        label="启用方式"
        desc={`${enabled ? '正在节省流量' : '正常加载'} · 本端：${describe(local)}${IS_WEB ? ` · 宿主：${describe(host)}` : ''}`}
        control={
          <SegmentedControl<DataSaverMode>
            label="省流量模式"
            value={preferenceValue('dataSaverMode')}
            options={dataSaverModeOptions}
            onChange={(mode) => void changePreference('dataSaverMode', mode)}
          />
        }
      />
      {preferenceValue('dataSaverMode') === 'auto' ? (
        <BooleanRow name="dataSaverOnMetered" label="使用流量时自动启用" />
      ) : null}
      <Row
        label="预览时自动获取原图"
        desc="省流量模式关闭时，打开聊天图片会自动下载缺失的原图。"
        control={
          <Toggle
            label="预览时自动获取原图"
            checked={preferenceValue('autoDownloadPreviewOriginal')}
            onChange={(value) => void changePreference('autoDownloadPreviewOriginal', value)}
          />
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
          <SegmentedControl<DataSaverBehavior['dataSaverImageLoading']>
            label="聊天图片自动加载"
            value={preferenceValue('dataSaverImageLoading')}
            options={[
              { value: 'none', label: '不自动加载' },
              { value: 'thumbnail', label: '仅小图' },
              { value: 'original', label: '原图' },
            ]}
            onChange={(value) => void changePreference('dataSaverImageLoading', value)}
          />
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
    </Card>
  );
}
