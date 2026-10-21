import { describe, expect, it } from 'vitest';
import { buddyRequestState, isIncomingPendingBuddyRequest } from '../src/common/buddy_request';

describe('好友申请状态', () => {
  it('已同意标记不受来源码影响，不把来源码当审核结果', () => {
    for (const status of [1, 2, 3, 9, 13]) {
      const request = { isAccepted: 0, initiator: 1, status };
      expect(buddyRequestState(request)).toBe('accepted');
      expect(isIncomingPendingBuddyRequest(request)).toBe(false);
    }
  });
  it('只有收到且尚未同意的申请可处理，自己发出的申请不可处理', () => {
    expect(buddyRequestState({ isAccepted: 1 })).toBe('pending');
    expect(isIncomingPendingBuddyRequest({ isAccepted: 1, initiator: 1 })).toBe(true);
    expect(isIncomingPendingBuddyRequest({ isAccepted: 1, initiator: 0 })).toBe(false);
  });
  it('未知标记不冒充待处理，也不允许审批', () => {
    expect(buddyRequestState({ isAccepted: 8 })).toBe('unknown');
    expect(isIncomingPendingBuddyRequest({ isAccepted: 8, initiator: 1 })).toBe(false);
  });
});
