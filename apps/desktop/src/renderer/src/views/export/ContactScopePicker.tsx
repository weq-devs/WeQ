import { useMemo } from 'react';
import { RotateCw, X } from 'lucide-react';
import { ConversationPicker } from './ConversationPicker';
import { convAvatarUrl } from './types';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useExactSelectionMode } from './useExactSelectionMode';

export interface ContactChoice {
  uid: string;
  uin: string;
  name: string;
  categoryId: number;
}

export function ContactScopePicker({
  items,
  selected,
  onChange,
  loading,
  error,
  onRetry,
  conditionLabel,
  scopeKey = 'contacts',
}: {
  items: readonly ContactChoice[];
  selected: readonly string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  conditionLabel: string;
  scopeKey?: string;
}) {
  const choices = useMemo(
    () =>
      items.map((item) => ({
        id: item.uid,
        uin: item.uin,
        name: item.name || item.uin || item.uid,
        avatarUrl: convAvatarUrl('c2c', item.uid, item.uin),
        meta: item.uin && item.uin !== '0' ? item.uin : item.uid,
      })),
    [items],
  );
  const visible = new Set(items.map((item) => item.uid));
  const changeMode = useExactSelectionMode(scopeKey, selected, onChange);
  const outside = selected?.filter((id) => !visible.has(id)) ?? [];
  return (
    <div className="weq-export-contact-scope">
      <div className="weq-export-contact-mode">
        <SegmentedControl
          label="联系人导出范围"
          value={selected === undefined ? 'condition' : 'exact'}
          onChange={changeMode}
          options={[
            { value: 'condition', label: '按条件' },
            { value: 'exact', label: '精确选择' },
          ]}
        />
        <small>
          {selected === undefined ? conditionLabel : `已选 ${selected.length} 位联系人`}
        </small>
      </div>
      {error ? (
        <div className="weq-search-failure" role="status">
          <span>联系人读取失败</span>
          <button
            type="button"
            title="重试读取联系人"
            aria-label="重试读取联系人"
            onClick={onRetry}
          >
            <RotateCw size={14} />
          </button>
        </div>
      ) : null}
      {!loading && outside.length > 0 ? (
        <div className="weq-export-contact-outside" role="status">
          <span>当前列表之外仍选中 {outside.length} 位联系人</span>
          <button
            type="button"
            title="清除列表外的选择"
            aria-label="清除列表外的选择"
            onClick={() => onChange(selected?.filter((id) => visible.has(id)) ?? [])}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {selected !== undefined ? (
        <ConversationPicker
          items={choices}
          loading={loading}
          selected={new Set(selected ?? items.map((item) => item.uid))}
          onChange={(next) => onChange([...next])}
          emptyText={error ? '联系人未能读取' : '暂无联系人'}
          searchPlaceholder="搜索昵称或 QQ 号"
        />
      ) : null}
    </div>
  );
}
