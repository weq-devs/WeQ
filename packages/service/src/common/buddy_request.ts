export type BuddyRequestState = 'accepted' | 'pending' | 'unknown';

/** 21502：0 表示已同意，1 表示尚未同意；21505 是来源类型，不能判断审核结果。 */
export function buddyRequestState(request: { isAccepted: number }): BuddyRequestState {
  if (request.isAccepted === 0) return 'accepted';
  if (request.isAccepted === 1) return 'pending';
  return 'unknown';
}

/** 21501 才是申请方向：1 为对方申请加我，0 为我申请加对方。 */
export function isIncomingPendingBuddyRequest(request: { isAccepted: number; initiator: number }) {
  return request.initiator === 1 && buddyRequestState(request) === 'pending';
}
