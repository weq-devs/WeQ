import { Check, Plus, Tags, X } from 'lucide-react';
import { useState } from 'react';
import { GROUP_SELECTED_TAG_LIMIT } from '@weqbot/protocol/group-tags';
import { sameGroupTags } from '../../../../shared/group_tags';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { client, trpc } from '../../trpc/client';
import { NumericText } from '../NumericText';
import { Card, Row } from '../settings/controls';
import { ActionIcon } from './shared';
import type { useQQAction } from './shared.shared';

// QQ Android TroopClassifyDetailConfig 的内置目录，群资料中的名称优先。
const groupCategoryNames: Partial<Record<number, string>> = {
  23: '同事与朋友',
  24: '置业安家',
  25: '游戏',
  26: '品牌产品',
  27: '粉丝',
  28: '兴趣爱好',
  29: '生活休闲',
  30: '学习考试',
  31: '行业交流',
  32: '老师家长',
  36: '兴趣交流',
  37: '二次元',
  39: '其他',
  40: '同城',
  10009: '同事',
  10010: '亲友',
  10011: '师生同学',
  10012: '团队办公',
  10018: '影视综艺',
  10019: '音乐',
  30003: '交友扩列',
};

export function GroupCategorySettings({
  groupId,
  canManage,
  action,
}: {
  groupId: number;
  canManage: boolean;
  action: ReturnType<typeof useQQAction>;
}) {
  const [tag, setTag] = useState('');
  const [draft, setDraft] = useState<{ before: string[]; tags: string[] } | null>(null);
  const [created, setCreated] = useState<{ category: number; names: string[] } | null>(null);
  const groupRefresh = useQQAutoRefresh(action.available);
  const info = trpc.account.qqActions.groupJoinSettings.useQuery(
    { ...action.binding!, groupId },
    groupRefresh,
  );
  const category =
    action.available && !info.error && info.data?.groupId === groupId
      ? (info.data.categoryId ?? null)
      : null;
  const tagsRefresh = useQQAutoRefresh(category !== null);
  const tags = trpc.account.qqActions.tags.useQuery(
    { ...action.binding!, category: category ?? 0 },
    tagsRefresh,
  );
  const selectedTags = trpc.account.qqActions.groupSelectedTags.useQuery(
    { ...action.binding!, groupId },
    groupRefresh,
  );
  const baseline = selectedTags.error ? null : (selectedTags.data ?? null);
  const selected = draft?.tags ?? baseline ?? [];
  const changed = draft !== null && !sameGroupTags(draft.before, draft.tags);
  const full = selected.length >= GROUP_SELECTED_TAG_LIMIT;
  const tagCounts = new Map<string, number>();
  for (const item of tags.data ?? []) tagCounts.set(item.name, (tagCounts.get(item.name) ?? 0) + 1);
  if (created && created.category === category) {
    for (const name of created.names) if (!tagCounts.has(name)) tagCounts.set(name, 1);
  }
  const names = new Set([...(draft?.before ?? baseline ?? []), ...tagCounts.keys(), ...selected]);
  const categoryName =
    category === null
      ? info.isFetching
        ? '读取中…'
        : '未取得群分类'
      : info.data?.categoryName || groupCategoryNames[category];
  const disabled = action.disabled || !canManage || baseline === null;
  const directoryDisabled = action.disabled || !canManage || category === null;
  const canAdd = !disabled && !directoryDisabled && !full && !!tags.data && !tags.error;

  function select(name: string, checked: boolean) {
    if (baseline === null) return;
    setDraft((previous) => {
      const before = previous?.before ?? baseline;
      const current = previous?.tags ?? before;
      if (checked && current.length >= GROUP_SELECTED_TAG_LIMIT) return previous;
      const next = checked
        ? [...new Set([...current, name])]
        : current.filter((tag) => tag !== name);
      return sameGroupTags(before, next) ? null : { before, tags: next };
    });
  }

  async function update(kind: 'addTag' | 'deleteTag', name: string) {
    if (directoryDisabled || category === null) return;
    const updated = await action.perform(
      (binding) =>
        client.account.qqActions.groupSettings.mutate({
          ...binding,
          groupId,
          action: kind,
          category,
          tag: name,
        }),
      undefined,
      kind === 'deleteTag' ? `删除分类标签「${name}」？` : undefined,
      {
        danger: kind === 'deleteTag' ? 'outline' : undefined,
        refreshCaches: false,
      },
    );
    if (!updated) return;
    select(name, kind === 'addTag');
    setCreated((previous) => {
      const current = previous?.category === category ? previous.names : [];
      return {
        category,
        names: kind === 'addTag' ? [...current, name] : current.filter((tag) => tag !== name),
      };
    });
    if (kind === 'addTag') setTag('');
    const refreshed = await tags.refetch();
    if (!refreshed.error && refreshed.data) {
      const listed = new Set(refreshed.data.map((item) => item.name));
      setCreated((previous) =>
        previous?.category === category
          ? { category, names: previous.names.filter((name) => !listed.has(name)) }
          : previous,
      );
    }
  }

  function add() {
    const name = tag.trim();
    if (!canAdd || !name) return;
    if (names.has(name)) {
      select(name, true);
      setTag('');
      return;
    }
    void update('addTag', name);
  }

  async function save() {
    if (disabled || !changed || !draft) return;
    const saved = await action.perform(
      (binding) =>
        client.account.qqActions.setGroupSelectedTags.mutate({ ...binding, groupId, ...draft }),
      undefined,
      undefined,
      {
        requireReadback: true,
        readbackSuccessText: '群标签已更新',
        readback: async () => {
          const result = await selectedTags.refetch();
          return !result.error && !!result.data && sameGroupTags(result.data, draft.tags);
        },
      },
    );
    if (saved) setDraft(null);
  }

  return (
    <Card title="分类标签" icon={<Tags />}>
      <Row
        label="群分类"
        control={
          <span
            className="weq-qq-write-static"
            title={categoryName ? undefined : `QQ 分类编号 ${category}`}
          >
            {categoryName || (category === 34 ? '未设置' : '未命名分类')}
          </span>
        }
      />
      {canManage && (
        <Row
          label="新增标签"
          desc={full ? '群标签最多 20 个' : undefined}
          control={
            <div className="weq-group-management-tag-editor">
              <input
                className="weq-set-input"
                aria-label="分类标签名称"
                placeholder="标签名称"
                value={tag}
                maxLength={64}
                disabled={!canAdd}
                onChange={(event) => setTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) add();
                }}
              />
              <button
                type="button"
                className="weq-set-btn"
                aria-label="添加分类标签"
                disabled={!canAdd || !tag.trim()}
                onClick={add}
              >
                <Plus size={14} aria-hidden />
                添加
              </button>
            </div>
          }
        />
      )}
      {info.error && (
        <p className="weq-qq-write-result" role="alert">
          群分类读取失败：{info.error.message}
        </p>
      )}
      {canManage && baseline === null && (
        <Row
          label={selectedTags.isFetching ? '正在读取当前群标签…' : '未取得当前群标签'}
          desc={selectedTags.error?.message}
          control={
            selectedTags.isFetching || !action.available ? undefined : (
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => void selectedTags.refetch()}
              >
                重新读取
              </button>
            )
          }
        />
      )}
      {(category !== null || names.size > 0) && (
        <div className="weq-group-management-tag-directory">
          {tags.error && category !== null && (
            <p className="weq-qq-write-result" role="alert">
              分类标签读取失败：{tags.error.message}
            </p>
          )}
          {names.size === 0 && !tags.error ? (
            <p className="weq-set-row-status" role="status">
              {tags.isFetching ? '正在读取分类标签…' : '此分类暂无标签'}
            </p>
          ) : (
            <ul className="weq-group-management-tags" aria-label="群标签和分类候选">
              {[...names].map((name) => {
                const count = tagCounts.get(name) ?? 0;
                const checked = selected.includes(name);
                const label = (
                  <>
                    {checked && <Check size={14} aria-hidden />}
                    {name}
                    {count > 1 ? <NumericText>{` (${count} 条)`}</NumericText> : null}
                  </>
                );
                return (
                  <li key={name} className="weq-profile-tag" data-selected={checked || undefined}>
                    {canManage ? (
                      <button
                        type="button"
                        className="weq-group-management-tag-toggle"
                        aria-pressed={checked}
                        disabled={disabled || (!checked && full)}
                        onClick={() => select(name, !checked)}
                      >
                        {label}
                      </button>
                    ) : (
                      <span>{label}</span>
                    )}
                    {canManage && count > 0 && (
                      <ActionIcon
                        danger="outline"
                        label={`删除分类标签「${name}」`}
                        disabled={directoryDisabled}
                        onClick={() => void update('deleteTag', name)}
                      >
                        <X size={12} aria-hidden />
                      </ActionIcon>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {canManage && baseline !== null && (
        <Row
          label={
            <NumericText>{`已选 ${selected.length} / ${GROUP_SELECTED_TAG_LIMIT}`}</NumericText>
          }
          control={
            <div className="weq-group-management-tag-actions">
              {changed && (
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={action.pending}
                  onClick={() => setDraft(null)}
                >
                  取消更改
                </button>
              )}
              <button
                type="button"
                className="weq-set-btn weq-set-btn-primary"
                disabled={disabled || !changed || selected.length > GROUP_SELECTED_TAG_LIMIT}
                onClick={() => void save()}
              >
                完成
              </button>
            </div>
          }
        />
      )}
    </Card>
  );
}
