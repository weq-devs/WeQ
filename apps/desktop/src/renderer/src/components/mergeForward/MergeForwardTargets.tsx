/**
 * 合并转发第二步：选择要转发到的会话（多选）。
 *
 * 会话来自主界面已经加载的列表，保留会话顺序，不按好友／群聊拆分。
 * 支持按名字 / QQ 号过滤。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Check, Search, Users } from 'lucide-react';
import { QqAvatar } from '../QqAvatar';
import { cn } from '../../im-template/template/classNames';
import type { MfTarget } from './model';
import { useMultiSelection } from '../../hooks/useMultiSelection';

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
  const needle = keyword.trim().toLowerCase();

  const visible = useMemo(
    () =>
      targets.filter(
        (target) =>
          !needle || target.name.toLowerCase().includes(needle) || target.conv.includes(needle),
      ),
    [targets, needle],
  );

  const selection = useMultiSelection({
    ids: visible.map((target) => target.id),
    selected,
    onChange,
  });
  return (
    <div className="weq-mf-targets" {...selection.rootProps}>
      <div className="weq-mf-search">
        <Search size={14} />
        <input
          className="weq-mf-search-input"
          placeholder="搜索会话（名字或 QQ 号）"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          autoFocus
        />
      </div>
      <div className="weq-mf-target-scroll">
        {visible.length === 0 ? <div className="weq-mf-empty">没有匹配的会话</div> : null}
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
    <button type="button" className={cn('weq-mf-target', checked && 'checked')} {...selectionProps}>
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
    </button>
  );
}
