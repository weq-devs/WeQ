/**
 * 输入框的「引用」：右键消息 → 引用，在输入框上方挂一条引用条，发送时把被引用消息
 * 编成 `reply` 元素跟着正文一起发出去。
 *
 * 只描述**前端待发送的引用**，不碰协议：
 *   - 昵称留在本地；摘要元素随引用指针一起发送，让接收端也能显示被引用内容；
 *   - origMsgIndex 只给本地预览跳转使用，协议编码器不会把它写进 wire。
 *
 * **`origMsgSeq` 填哪个号，群聊和私聊不是一回事**（2026-10-17 真机对账）：
 *   - 群聊：群内 seq（列 40003）—— 群消息的 `contentHead.sequence` 就是群内 seq；
 *   - 私聊：被引用消息的**发送方本地 client sequence**（列 40005，wire
 *     `contentHead.sequence` tag 5）。QQ 在私聊里按这套编号解析 `srcMsg.origSeqs[0]`，
 *     会话级 seq（40003 / `ntMsgSeq`）那套是历史分页用的 —— 拿 40003 去引用，收端
 *     只会显示一个定位不到原消息的引用框。
 * 所以 {@link composerQuoteElement} 优先用 `clientSeq`，没有（群聊 / 老数据）才退回 `msgSeq`。
 *
 * **允许嵌套引用**（引用的消息自己也是引用）：发送摘要时过滤原消息的 reply 元素，
 * 不把上一层引用再发一遍。{@link quotePreview} 同样跳过 reply，不把上一层引用
 * 带进引用条（见 {@link withoutReplyElements}）。
 *
 * 唯一不给引的是**系统灰条**（拍一拍 / 撤回 / 群通知…）—— 它们本来就没有可引的内容。
 *
 * 与「只能单独发」的槽位（视频 / 文件 / 超级表情）互斥由 chatPane 负责：挂上任意
 * 一边就会把另一边清掉 —— 这个槽位一次只放一样东西。
 */

import { X } from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from './classNames';
import type { ComposerQuote } from './composerQuote.shared';

/**
 * 输入框上方那条引用条：左侧一根强调色竖条 + 昵称 + 单行摘要 + 取消。
 * 它占 `.composer` 网格里正文上面那一行（见 composer-media.css 的 `.composer-quote`），
 * 所以有引用时正文会短一截，而不是把引用压在正文上。
 */
export function ComposerQuoteBar({
  quote,
  panelRef,
  onRemove,
}: {
  quote: ComposerQuote;
  panelRef?: RefObject<HTMLDivElement | null>;
  onRemove: () => void;
}) {
  return (
    <div className={cn('composer-quote')} ref={panelRef} aria-label="待发送的引用">
      <span className={cn('composer-quote-rail')} aria-hidden="true" />
      <span className={cn('composer-quote-body')}>
        <strong>{quote.senderName || '原消息'}</strong>
        <em title={quote.preview}>{quote.preview}</em>
      </span>
      <button
        type="button"
        className={cn('composer-quote-remove')}
        title="取消引用"
        aria-label="取消引用"
        onClick={onRemove}
      >
        <X size={13} strokeWidth={2.6} />
      </button>
    </div>
  );
}
export type { ComposerQuote } from './composerQuote.shared';
