import { Plus, Tags, X } from 'lucide-react';
import { useState } from 'react';
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
  const tagCounts = new Map<string, number>();
  for (const item of tags.data ?? []) tagCounts.set(item.name, (tagCounts.get(item.name) ?? 0) + 1);
  const categoryName =
    category === null
      ? info.isFetching
        ? '读取中…'
        : '未取得群分类'
      : info.data?.categoryName || groupCategoryNames[category];
  const disabled = action.disabled || !canManage || category === null;

  async function update(kind: 'addTag' | 'deleteTag', name: string) {
    if (disabled || category === null) return;
    await action.perform(
      (binding) =>
        client.account.qqActions.groupSettings.mutate({
          ...binding,
          groupId,
          action: kind,
          category,
          tag: name,
        }),
      async () => {
        const result = await tags.refetch();
        if (result.error) throw result.error;
      },
      kind === 'deleteTag' ? `删除分类标签「${name}」？` : undefined,
      {
        danger: kind === 'deleteTag' ? 'outline' : undefined,
        readback: async () => {
          const result = await tags.refetch();
          if (result.error) throw result.error;
          if (!result.data) return false;
          return result.data.some((item) => item.name === name) === (kind === 'addTag');
        },
      },
    );
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
          desc="同名标签会累加"
          control={
            <div className="weq-group-management-tag-editor">
              <input
                className="weq-set-input"
                aria-label="分类标签名称"
                placeholder="标签名称"
                value={tag}
                maxLength={64}
                disabled={disabled}
                onChange={(event) => setTag(event.target.value)}
              />
              <button
                type="button"
                className="weq-set-btn"
                aria-label="添加分类标签"
                disabled={disabled || !tag.trim()}
                onClick={() => void update('addTag', tag)}
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
      {category !== null && (
        <div className="weq-group-management-tag-directory">
          {tags.error ? (
            <p className="weq-qq-write-result" role="alert">
              分类标签读取失败：{tags.error.message}
            </p>
          ) : tags.data === undefined || tagCounts.size === 0 ? (
            <p className="weq-set-row-status" role="status">
              {tags.isFetching ? '正在读取分类标签…' : '此分类暂无标签'}
            </p>
          ) : (
            <ul className="weq-group-management-tags" aria-label="分类标签目录">
              {[...tagCounts].map(([name, count]) => (
                <li key={name} className="weq-profile-tag">
                  <span>
                    {name}
                    {count > 1 ? <NumericText>{` (${count} 条)`}</NumericText> : null}
                  </span>
                  {canManage && (
                    <ActionIcon
                      danger="outline"
                      label={`删除分类标签「${name}」`}
                      disabled={disabled}
                      onClick={() => void update('deleteTag', name)}
                    >
                      <X size={12} aria-hidden />
                    </ActionIcon>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
