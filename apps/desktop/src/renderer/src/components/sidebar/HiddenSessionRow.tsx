/**
 * 隐藏会话固定行 —— 渲染在普通会话列表最上方（仅当存在至少一个隐藏会话时）。
 * 点击后展开隐藏会话子列表（见 MergedSessionPanel）。按要求：外部不显示任何
 *内部最新消息的预览或时间，只显示数量。
 */

import type { ReactElement } from 'react';
import { EyeOff } from 'lucide-react';
import { cn } from '../../im-template/template';

export function HiddenSessionRow({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}): ReactElement | null {
  if (count <= 0) return null;

  return (
    <button type="button" className={cn('conversation-row', 'weq-merged-row')} onClick={onOpen}>
      <span className="weq-merged-row-icon">
        <EyeOff size={20} strokeWidth={1.8} />
      </span>
      <span className={cn('row-main')}>
        <strong>
          <span className={cn('row-title-text')}>隐藏会话</span>
        </strong>
      </span>
      <span className={cn('row-meta')}>
        <span className={cn('row-time-line')}>{count} 个</span>
      </span>
    </button>
  );
}
