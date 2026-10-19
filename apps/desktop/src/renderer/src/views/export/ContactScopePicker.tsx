import { useMemo } from 'react';
import { RotateCw, X } from 'lucide-react';
import { ConversationPicker } from './ConversationPicker';
import { convAvatarUrl } from './types';

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
}: {
  items: readonly ContactChoice[];
  selected: readonly string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  conditionLabel: string;
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
  const outside = selected?.filter((id) => !visible.has(id)) ?? [];
  return (
    <div className="weq-export-contact-scope">
      <label className="weq-export-contact-mode">
        <input
          type="checkbox"
          aria-label="精确选择联系人"
          checked={selected !== undefined}
          onChange={(event) => onChange(event.target.checked ? [] : undefined)}
        />
        <span>精确选择</span>
        <small>
          {selected === undefined ? conditionLabel : `已选 ${selected.length} 位联系人`}
        </small>
      </label>
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
      <ConversationPicker
        items={choices}
        loading={loading}
        selected={new Set(selected ?? items.map((item) => item.uid))}
        onChange={(next) => onChange([...next])}
        emptyText={error ? '联系人未能读取' : '暂无联系人'}
        searchPlaceholder="搜索昵称或 QQ 号"
      />
    </div>
  );
}
