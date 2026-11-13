import type { QzoneLikesResult } from '../views/qzone_types';

/** 本人状态优先使用服务端标记，只有旧接口缺失标记时才从名单判断。 */
export function qzoneSelfLiked(
  result: Pick<QzoneLikesResult, 'likes' | 'coverage' | 'selfLiked'> | null | undefined,
  selfUin: string,
): boolean | null {
  if (typeof result?.selfLiked === 'boolean') return result.selfLiked;
  if (result?.likes.some((person) => person.uin === selfUin)) return true;
  return result?.coverage === 'complete' ? false : null;
}

export interface QzoneReplyTarget {
  id: string;
  nickname: string;
  uin: string;
  rootId: string;
  rootUin: string;
}

export function qzoneForwardDraft(quotePrevious: boolean, content: string): string {
  return quotePrevious && content.trim() ? `//：${content}` : '';
}

/** 自动补齐只消费本轮额度，只有向下滚动才能开启下一轮。 */
export class QzoneRelatedRound {
  private used = 0;
  readonly limit = 5;

  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  scrollDown(): boolean {
    if (!this.exhausted) return false;
    this.used = 0;
    return true;
  }
}
