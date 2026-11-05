import { useId, useState } from 'react';
import {
  ListChecks,
  MessageSquare,
  Mic,
  Image,
  Film,
  FileText,
  MessageCircle,
  Type,
  UserRound,
  Sparkles,
  Smile,
  ChevronRight,
  ContactRound,
  Check,
} from 'lucide-react';
import {
  EXPORT_CONTENT_KEYS,
  EXPORT_CONTENT_DETAILS,
  exportContentAllTier,
  normalizeExportContent,
  selectAllExportContent,
  selectExportContentGroup,
  type ExportContentDetailKey,
  type ExportContentKey,
  type ExportContentPolicy,
} from '@weq/service/export-content';
import { SegmentedControl } from '../../components/SegmentedControl';
import '../../styles/export-content-selector.css';

const items = {
  messages: { label: '消息', icon: MessageSquare },
  voice: { label: '语音', icon: Mic },
  images: { label: '图片', icon: Image },
  videos: { label: '视频', icon: Film },
  files: { label: '文件', icon: FileText },
  bubble: { label: '装扮气泡', icon: MessageCircle },
  font: { label: '装扮字体', icon: Type },
  avatar: { label: '头像', icon: UserRound },
  widget: { label: '头像挂件', icon: Sparkles },
  qqFaces: { label: 'QQ表情', icon: Smile },
  profiles: { label: '联系人或群资料', icon: ContactRound },
};
export function ExportContentSelector({
  value,
  onChange,
  guild = false,
  disabled = false,
}: {
  value: ExportContentPolicy;
  onChange: (value: ExportContentPolicy) => void;
  guild?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<Partial<Record<ExportContentKey, boolean>>>({});
  const policy = normalizeExportContent(value, {}, guild);
  const detailButtons = (details: readonly (typeof EXPORT_CONTENT_DETAILS)[number][]) => {
    const groups = new Map<string, ExportContentDetailKey[]>();
    for (const detail of details) {
      const keys = groups.get(detail.label) ?? [];
      keys.push(detail.key);
      groups.set(detail.label, keys);
    }
    return (
      <div className="weq-export-content-detail-buttons" role="group" aria-label="附加数据">
        {[...groups].map(([label, keys]) => {
          const on = keys.every((key) => policy.details?.[key] === 'local');
          const mixed = !on && keys.some((key) => policy.details?.[key] === 'local');
          return (
            <button
              key={label}
              type="button"
              className={`weq-exp-format${on ? ' is-on' : ''}`}
              aria-pressed={mixed ? 'mixed' : on}
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...policy,
                  details: {
                    ...policy.details,
                    ...Object.fromEntries(keys.map((key) => [key, on ? 'none' : 'local'])),
                  },
                })
              }
            >
              {on ? <Check size={13} aria-hidden /> : null}
              {label}
            </button>
          );
        })}
      </div>
    );
  };
  const row = (key: ExportContentKey | 'all') => {
    const item = key === 'all' ? { label: '全部', icon: ListChecks } : items[key];
    const Icon = item.icon;
    const noCloud = key === 'qqFaces' || key === 'profiles' || (guild && key === 'messages');
    const children =
      key === 'all' ? [] : EXPORT_CONTENT_DETAILS.filter((detail) => detail.parent === key);
    return (
      <div key={key} className="weq-export-content-group">
        <div className={`weq-export-content-row${key === 'all' ? ' is-all' : ''}`}>
          <span className="weq-export-content-label">
            {key === 'all' || !children.length ? (
              <span className="weq-export-content-expander-space" />
            ) : (
              <button
                type="button"
                className={`weq-export-content-expander${expanded[key] ? ' is-open' : ''}`}
                aria-label={`${expanded[key] ? '收起' : '展开'}${item.label}明细`}
                aria-expanded={Boolean(expanded[key])}
                aria-controls={`${id}-${key}`}
                disabled={disabled}
                onClick={() => setExpanded((current) => ({ ...current, [key]: !current[key] }))}
              >
                <ChevronRight size={14} />
              </button>
            )}
            <Icon size={16} aria-hidden />
            {item.label}
          </span>
          <SegmentedControl
            label={`${item.label}导出方式`}
            value={key === 'all' ? exportContentAllTier(policy, guild) : (policy[key] ?? 'none')}
            disabled={disabled}
            onChange={(tier) =>
              onChange(
                key === 'all'
                  ? selectAllExportContent(tier, guild)
                  : selectExportContentGroup(policy, key, tier, guild),
              )
            }
            options={[
              { value: 'none', label: '不导出' },
              { value: 'local', label: '仅本地' },
              { value: 'cloud', label: '云端补全', hidden: noCloud },
            ]}
          />
        </div>
        {key === 'all' ? (
          <div className="weq-export-content-details">
            <div className="weq-export-content-row is-detail is-additional">
              <span className="weq-export-content-label">附加数据</span>
              {detailButtons(EXPORT_CONTENT_DETAILS)}
            </div>
          </div>
        ) : null}
        {key !== 'all' && expanded[key] ? (
          <div id={`${id}-${key}`} className="weq-export-content-details">
            <div className="weq-export-content-row is-detail is-additional">
              <span className="weq-export-content-label">附加数据</span>
              {detailButtons(children)}
            </div>
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="weq-export-content-selector" aria-label="导出内容">
      {row('all')}
      {EXPORT_CONTENT_KEYS.map(row)}
    </div>
  );
}
