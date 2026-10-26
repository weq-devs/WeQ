import { describe, expect, it } from 'vitest';
import {
  buddyRequestDirection,
  buddyRequestState,
  isIncomingPendingBuddyRequest,
} from '../src/common/buddy_request';

describe('好友申请状态', () => {
  it('收到的未处理通知不因 21502 为 0 就误判已同意', () => {
    const request = { isAccepted: 0, initiator: 0, status: 1 };
    expect(buddyRequestState(request)).toBe('pending');
    expect(buddyRequestDirection(request)).toBe('incoming');
    expect(isIncomingPendingBuddyRequest(request)).toBe(true);
  });
  it('已同意通知按请求类型识别，处理标记不是申请方向', () => {
    const request = { isAccepted: 0, initiator: 1, status: 3 };
    expect(buddyRequestState(request)).toBe('accepted');
    expect(buddyRequestDirection(request)).toBe('incoming');
    expect(isIncomingPendingBuddyRequest(request)).toBe(false);
  });
  it('自己发出的待确认申请仍是待处理，不是过期或已取消，也不能审批', () => {
    const request = { isAccepted: 1, initiator: 0, status: 13 };
    expect(buddyRequestState(request)).toBe('pending');
    expect(buddyRequestDirection(request)).toBe('outgoing');
    expect(isIncomingPendingBuddyRequest(request)).toBe(false);
  });
  it.each([2, 3, 4, 5])('同意类请求类型 %s 不允许重复审批', (status) => {
    const request = { isAccepted: 0, initiator: 1, status };
    expect(buddyRequestState(request)).toBe('accepted');
    expect(isIncomingPendingBuddyRequest(request)).toBe(false);
  });
  it.each([6, 7])('拒绝类请求类型 %s 不显示为已同意', (status) => {
    const request = { isAccepted: 0, initiator: 1, status };
    expect(buddyRequestState(request)).toBe('rejected');
    expect(isIncomingPendingBuddyRequest(request)).toBe(false);
  });
  it.each([8, 9, 10, 11, 12, 99])('未建模的请求类型 %s 不猜测结果或允许审批', (status) => {
    const request = { isAccepted: 0, initiator: 0, status };
    expect(buddyRequestState(request)).toBe('unknown');
    expect(isIncomingPendingBuddyRequest(request)).toBe(false);
  });
  it('审批要求收到、未处理且类型为对方申请，不能只凭 pending', () => {
    for (const request of [
      { isAccepted: 1, initiator: 0, status: 1 },
      { isAccepted: 0, initiator: 1, status: 1 },
      { isAccepted: 0, initiator: 0, status: 0 },
      { isAccepted: 0, initiator: 0, status: 13 },
      { isAccepted: 8, initiator: 0, status: 1 },
      { isAccepted: 0, initiator: 8, status: 1 },
    ]) {
      expect(isIncomingPendingBuddyRequest(request)).toBe(false);
    }
  });
});
