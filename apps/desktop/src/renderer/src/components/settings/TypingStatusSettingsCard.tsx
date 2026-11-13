/**
 * 设置 → 互动与防撤回 →「隐藏正在输入状态」。
 *
 * 语义是「默认向对方展示输入状态，按需隐藏」：
 *   • 启用范围：关闭 / 按会话勾选 / 永久全选；
 *   • 按会话勾选时显示数量摘要，点击「编辑会话」打开私聊选择工具。
 *
 * 私聊输入框不再有单会话开关按钮，添加 / 移除隐藏会话都在这里完成。
 */

import { useEffect, useMemo, useState } from 'react';
import { Keyboard, Pencil, Save } from 'lucide-react';
import { classifyChatType } from '@weq/codec';
import { useTypingStatusSettings } from '../../hooks/useTypingStatusSettings';
import { useTabActive } from '../RetainedTabs';
import { ToolSurface } from '../ToolSurface';
import { LoadingIndicator } from '../LoadingIndicator';
import { PageShell } from '../PageShell';
import { useAppLock } from '../../state/lock';
import { trpc } from '../../trpc/client';
import { Card, Row, QueryError } from './controls';
import { ConversationPicker } from '../../views/export/ConversationPicker';
import { convAvatarUrl, fmtCount, type PickItem } from '../../views/export/types';
import { cn } from '../../im-template/template/classNames';
import '../../styles/typing-status-settings.css';

type TypingMode = 'off' | 'selected' | 'all';

const MODE_OPTIONS: { value: TypingMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'selected', label: '按会话勾选' },
  { value: 'all', label: '永久全选' },
];

/** 最近会话 wire —— 这里只读用到的字段（与 listConversationsWithCount 对齐）。 */
interface ConvWire {
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  targetDisplayName: string;
  messageCount?: number;
}

/**
 * 输入状态只对私聊广播有意义，选择器里不列群聊。群号是纯数字，好友 / 设备的
 * uid 一定不是；只看 chatType 在部分临时会话上不可靠，所以两种形态都兜一下。
 */
function isPrivateConversation(c: ConvWire): boolean {
  if (!c.targetUid) return false;
  if (classifyChatType(c.chatType) === 'group') return false;
  if (!c.targetUid.startsWith('u_') && /^\d+$/.test(c.targetUid)) return false;
  return true;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

export function TypingStatusSettingsCard() {
  const preferences = useTypingStatusSettings();
  const { query, disabled } = preferences;
  const active = useTabActive();
  const locked = useAppLock((state) => state.locked);
  const account = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const mode: TypingMode = query.data?.mode ?? 'off';

  const accountUin = account.data?.uin;
  const accountConfigId = account.data?.configId;
  const sourceKey = JSON.stringify([accountUin, accountConfigId]);
  const [editorSource, setEditorSource] = useState<string | null>(null);
  const editing = editorSource === sourceKey && active && !locked && mode === 'selected';
  const unavailable =
    disabled ||
    query.isLoading ||
    !accountUin ||
    !accountConfigId ||
    account.isError ||
    !active ||
    locked;

  useEffect(() => {
    if (!active || locked || mode !== 'selected' || editorSource !== sourceKey)
      setEditorSource(null);
  }, [active, locked, mode, editorSource, sourceKey]);

  const conversations = trpc.account.listConversationsWithCount.useQuery(undefined, {
    enabled: editing,
    refetchOnWindowFocus: false,
  });

  const items = useMemo<PickItem[]>(() => {
    return ((conversations.data ?? []) as ConvWire[]).filter(isPrivateConversation).map((c) => {
      const count = Number(c.messageCount ?? 0);
      return {
        id: c.targetUid,
        name: c.targetDisplayName || c.targetUid,
        avatarUrl: convAvatarUrl('c2c', c.targetUid, c.targetUin),
        kind: 'c2c' as const,
        uin: c.targetUin,
        total: count,
        meta: `${fmtCount(count)} 条 · 私聊`,
      };
    });
  }, [conversations.data]);

  const savedIds = useMemo(() => {
    if (!accountUin || !accountConfigId) return new Set<string>();
    return new Set(
      (query.data?.hidden ?? [])
        .filter(
          (item) => item.accountUin === accountUin && item.accountConfigId === accountConfigId,
        )
        .map((item) => item.uid),
    );
  }, [query.data?.hidden, accountUin, accountConfigId]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!editing)
      setSelected((current) => (sameIds(current, savedIds) ? current : new Set(savedIds)));
  }, [savedIds, editing]);

  const dirty = useMemo(() => !sameIds(selected, savedIds), [selected, savedIds]);

  async function onSave(): Promise<void> {
    if (unavailable || !editing || conversations.isLoading || conversations.error) return;
    if (!accountUin || !accountConfigId) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    const add = [...selected].sort().map((uid) => ({
      accountUin,
      accountConfigId,
      uid,
      name:
        byId.get(uid)?.name ??
        query.data?.hidden.find(
          (item) =>
            item.accountUin === accountUin &&
            item.accountConfigId === accountConfigId &&
            item.uid === uid,
        )?.name ??
        uid,
    }));
    await preferences.setHidden(add, {
      expectedAccountUin: accountUin,
      expectedAccountConfigId: accountConfigId,
    });
  }

  return (
    <div className="weq-typing-settings">
      <Card title="隐藏正在输入状态" settingId="typing-status" icon={<Keyboard size={15} />}>
        {query.error ? (
          <QueryError
            message={query.error.message}
            retryLabel="重试读取输入状态设置"
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <Row
          label="启用范围"
          desc={
            mode === 'all'
              ? '所有私聊都不再向对方展示正在输入状态。'
              : mode === 'selected'
                ? '只隐藏已选择的会话，其他会话仍展示正在输入状态。'
                : '默认向对方展示正在输入状态。'
          }
          control={
            <div className="weq-set-seg" role="radiogroup" aria-label="隐藏正在输入状态启用范围">
              {MODE_OPTIONS.map((option) => (
                <button
                  type="button"
                  role="radio"
                  key={option.value}
                  aria-checked={mode === option.value}
                  className={cn('weq-set-seg-item', mode === option.value && 'is-on')}
                  disabled={disabled || query.isLoading}
                  onClick={() => void preferences.setMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        />
        {mode === 'selected' ? (
          <div data-setting-id="typing-status-hidden">
            <Row
              label="隐藏正在输入状态的会话"
              desc={
                !accountUin || !accountConfigId
                  ? '当前没有打开的账号，暂时无法编辑隐藏会话。'
                  : `已选择 ${savedIds.size} 个会话。`
              }
              control={
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={unavailable}
                  aria-label="编辑隐藏正在输入状态的会话"
                  onClick={() => {
                    setSelected(new Set(savedIds));
                    setEditorSource(sourceKey);
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  编辑会话
                </button>
              }
            />
          </div>
        ) : null}
        {query.isLoading ? (
          <div className="weq-set-empty" role="status">
            <LoadingIndicator />
          </div>
        ) : null}
      </Card>
      {editing ? (
        <ToolSurface
          title="隐藏正在输入状态的会话"
          presentation="modal"
          draft={dirty ? [...selected].sort() : null}
          busy={preferences.busy}
          onClose={() => setEditorSource(null)}
        >
          {(requestClose) => (
            <div className="weq-typing-settings-tool">
              <PageShell
                title="隐藏正在输入状态的会话"
                onClose={requestClose}
                actions={
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={unavailable || conversations.isLoading || !!conversations.error}
                    onClick={() => void onSave()}
                  >
                    <Save size={14} aria-hidden="true" />
                    保存选择
                  </button>
                }
              >
                <div className="weq-typing-settings-tool-body">
                  {conversations.error ? (
                    <QueryError
                      message={conversations.error.message}
                      retryLabel="重试读取会话"
                      retrying={conversations.isFetching}
                      onRetry={() => void conversations.refetch()}
                    />
                  ) : null}
                  <fieldset disabled={unavailable} className="weq-typing-settings-picker">
                    <ConversationPicker
                      items={items}
                      loading={conversations.isLoading}
                      selected={selected}
                      onChange={setSelected}
                      emptyText="暂无可隐藏的私聊会话"
                    />
                  </fieldset>
                </div>
              </PageShell>
            </div>
          )}
        </ToolSurface>
      ) : null}
    </div>
  );
}
