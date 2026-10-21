import { CompositionButton } from './CompositionButton';
/**
 * 合并转发第二步：选择要转发到的会话（多选）。
 *
 * 会话来自主界面已经加载的列表，保留会话顺序，不按好友／群聊拆分。
 * 支持按名字 / QQ 号过滤。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Check, Search, Users, ArrowLeft, ChevronRight, FolderOpen } from 'lucide-react';
import { QqAvatar } from '../QqAvatar';
import { cn } from '../../im-template/template/classNames';
import type { MfTarget } from './model';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/composition-targets.css';

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
      targets.filter(
        (target) =>
          Boolean(target.groupAssistant) === insideAssistant &&
          (!needle || target.name.toLowerCase().includes(needle) || target.conv.includes(needle)),
      ),
    [targets, needle, insideAssistant],
  );
  const assistantTargets = targets.filter((target) => target.groupAssistant);
  const assistantSelected = assistantTargets.filter((target) => selected.has(target.id)).length;

  const selection = useMultiSelection({
    ids: visible.map((target) => target.id),
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
          <span>
            {assistantSelected ? `已选 ${assistantSelected}` : `${assistantTargets.length} 个群`}
          </span>
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
      <div className="weq-mf-target-scroll">
        {!insideAssistant && assistantTargets.length ? (
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
            <span>
              {assistantSelected ? `已选 ${assistantSelected}` : `${assistantTargets.length} 个群`}
            </span>
            <ChevronRight size={16} />
          </CompositionButton>
        ) : null}
        {visible.length === 0 && (insideAssistant || !assistantTargets.length) ? (
          <div className="weq-mf-empty">没有匹配的会话</div>
        ) : null}
        {visible.map((t) => (
          <TargetRow
            key={t.id}
            target={t}
            checked={selected.has(t.id)}
            selectionProps={selection.itemProps(t.id)}
          />
        ))}
      </div>
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
      {...selectionProps}
    >
      <span className={cn('weq-mf-target-check', checked && 'on')}>
        {checked ? <Check size={13} strokeWidth={3} /> : null}
      </span>
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
      {target.kind === 'c2c' && target.conv ? (
        <span className="weq-mf-target-uin">{target.conv}</span>
      ) : null}
    </CompositionButton>
  );
}
