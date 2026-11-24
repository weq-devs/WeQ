import { NumericText } from '../NumericText';
import { EmptyState } from '../EmptyState';
import { CompositionButton } from './CompositionButton';
/**
 * 合并转发第二步：选择要转发到的会话（多选）。
 *
 * 会话来自主界面已经加载的列表，保留会话顺序，不按好友／群聊拆分。
 * 支持按名字、拼音和号码过滤。
 */

import { useId, useMemo, useState, type ReactElement } from 'react';
import {
  Check,
  Search,
  Users,
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  SearchX,
  X,
} from 'lucide-react';
import { Modal } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import { filterByName } from '../../lib/nameSearch';
import { WindowedList } from '../WindowedList';
import { cn } from '../../im-template/template/classNames';
import type { ForwardedConversationTarget, MfTarget } from './model';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/merge-forward-editor.css';
import '../../styles/composition-targets.css';

const targetRowHeight = 46;
const targetKey = (target: MfTarget | null) => target?.id ?? 'group-assistant-entry';

export function MergeForwardTargets({
  targets,
  selected,
  onChange,
}: {
  targets: MfTarget[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}): ReactElement {
  const [keyword, setKeyword] = useState('');
  const [insideAssistant, setInsideAssistant] = useState(false);
  const needle = keyword.trim().toLowerCase();

  const visible = useMemo(
    () =>
      filterByName(
        targets.filter((target) => Boolean(target.groupAssistant) === insideAssistant),
        needle,
        (target) => [target.name, ...(target.aliases ?? [])],
        (target, query) => target.conv.includes(query),
      ),
    [targets, needle, insideAssistant],
  );
  const assistantTargets = useMemo(
    () => targets.filter((target) => target.groupAssistant),
    [targets],
  );
  const assistantSelected = useMemo(
    () => assistantTargets.reduce((count, target) => count + Number(selected.has(target.id)), 0),
    [assistantTargets, selected],
  );
  const assistantEntry = !insideAssistant && assistantTargets.length > 0;
  const items = useMemo(
    () => (assistantEntry ? [null, ...visible] : visible),
    [assistantEntry, visible],
  );
  const ids = useMemo(() => visible.map((target) => target.id), [visible]);
  const assistantSummary = assistantSelected ? (
    `已选 ${assistantSelected}`
  ) : (
    <NumericText>{`${assistantTargets.length} 个群`}</NumericText>
  );

  const selection = useMultiSelection({
    ids,
    selected,
    onChange,
  });
  return (
    <div className="weq-mf-targets" {...selection.rootProps}>
      {insideAssistant ? (
        <div className="weq-mf-targets-header">
          <CompositionButton
            type="button"
            title="返回全部会话"
            onClick={() => setInsideAssistant(false)}
          >
            <ArrowLeft size={16} />
          </CompositionButton>
          <strong>群助手</strong>
          <span>{assistantSummary}</span>
        </div>
      ) : null}
      <div className="weq-mf-search">
        <Search size={14} />
        <input
          className="weq-mf-search-input"
          placeholder={insideAssistant ? '搜索群助手（群名或群号）' : '搜索会话（名字或 QQ 号）'}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          autoFocus
        />
      </div>
      {items.length ? (
        <WindowedList
          items={items}
          rowHeight={targetRowHeight}
          height={520}
          itemKey={targetKey}
          className="weq-mf-target-scroll"
          resetKey={`${insideAssistant}:${needle}`}
          scrollToKey={selection.focusRequest?.id}
          scrollRevision={selection.focusRequest?.revision}
          renderItem={(target) =>
            target ? (
              <TargetRow
                target={target}
                checked={selected.has(target.id)}
                selectionProps={selection.itemProps(target.id)}
              />
            ) : (
              <CompositionButton
                type="button"
                className="weq-mf-target weq-mf-assistant-entry"
                title="进入群助手选择转发目标"
                onClick={() => setInsideAssistant(true)}
              >
                <span className="weq-mf-avatar-fallback weq-mf-target-avatar">
                  <FolderOpen size={18} />
                </span>
                <span className="weq-mf-target-name">群助手</span>
                <span>{assistantSummary}</span>
                <ChevronRight size={16} />
              </CompositionButton>
            )
          }
        />
      ) : (
        <div className="weq-mf-target-scroll">
          <EmptyState compact icon={<SearchX />} title="没有匹配的会话" />
        </div>
      )}
    </div>
  );
}

function TargetRow({
  target,
  checked,
  selectionProps,
}: {
  target: MfTarget;
  checked: boolean;
  selectionProps: ReturnType<ReturnType<typeof useMultiSelection<string>>['itemProps']>;
}): ReactElement {
  return (
    <CompositionButton
      type="button"
      className={cn('weq-mf-target', checked && 'checked')}
      aria-pressed={checked}
      title={target.kind === 'c2c' && target.conv ? `${target.name} ${target.conv}` : target.name}
      {...selectionProps}
    >
      <span className={cn('weq-mf-target-check', checked && 'on')}>
        {checked ? <Check size={13} strokeWidth={3} /> : null}
      </span>
      <TargetIdentity target={target} />
    </CompositionButton>
  );
}

function TargetIdentity({
  target,
  showGroupCode = false,
}: {
  target: MfTarget;
  showGroupCode?: boolean;
}): ReactElement {
  return (
    <>
      {target.kind === 'group' && !target.avatarUrl ? (
        <span className="weq-mf-avatar-fallback weq-mf-target-avatar">
          <Users size={16} strokeWidth={1.75} />
        </span>
      ) : (
        <QqAvatar
          uin={target.kind === 'c2c' ? target.conv : undefined}
          url={target.avatarUrl}
          size={30}
          className="weq-mf-target-avatar"
        />
      )}
      <span className="weq-mf-target-name">{target.name}</span>
      {(target.kind === 'c2c' || showGroupCode) && target.conv ? (
        <span className="weq-mf-target-uin">{target.conv}</span>
      ) : null}
    </>
  );
}

export function ForwardedConversationsDialog({
  targets,
  onOpenTarget,
  onClose,
}: {
  targets: readonly ForwardedConversationTarget[];
  onOpenTarget: (target: ForwardedConversationTarget) => void;
  onClose: () => void;
}): ReactElement {
  const titleId = useId();
  return (
    <Modal
      width={400}
      className="weq-mf-forwarded-picker"
      labelledBy={titleId}
      onClose={onClose}
      focusContainerOnOpen
    >
      <header className="weq-mf-picker-head">
        <strong id={titleId}>选择转发会话</strong>
        <span className="weq-mf-picker-spacer" />
        <CompositionButton type="button" className="weq-mf-icon-btn" title="关闭" onClick={onClose}>
          <X size={16} aria-hidden />
        </CompositionButton>
      </header>
      <WindowedList
        items={targets}
        rowHeight={targetRowHeight}
        height={480}
        itemKey={targetKey}
        className="weq-mf-target-scroll"
        renderItem={(target) => (
          <CompositionButton
            type="button"
            className="weq-mf-target"
            title={target.conv ? `${target.name} ${target.conv}` : target.name}
            onClick={() => onOpenTarget(target)}
          >
            <TargetIdentity target={target} showGroupCode />
            <ChevronRight size={16} aria-hidden />
          </CompositionButton>
        )}
      />
    </Modal>
  );
}
