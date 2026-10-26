export type BuddyRequestState = 'accepted' | 'pending' | 'rejected' | 'unknown';

/** 21505 是 QQ BuddyReqType；21502 是 isInitiator，不能作为是否同意的依据。 */
export function buddyRequestState(request: { status: number }): BuddyRequestState {
  if ([0, 1, 13].includes(request.status)) return 'pending';
  if ([2, 3, 4, 5].includes(request.status)) return 'accepted';
  if ([6, 7].includes(request.status)) return 'rejected';
  return 'unknown';
}

/** 保留旧字段名兼容调用方：isAccepted 实际存的是 21502（是否由自己发起）。 */
export function buddyRequestDirection(request: { isAccepted: number }): 'incoming' | 'outgoing' {
  return request.isAccepted === 0 ? 'incoming' : 'outgoing';
}

/** 21501 是 isDecide；只有对方发起且未处理的申请才能审批。 */
export function isIncomingPendingBuddyRequest(request: {
  isAccepted: number;
  initiator: number;
  status: number;
}) {
  return request.isAccepted === 0 && request.initiator === 0 && request.status === 1;
}
