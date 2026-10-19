import { describe, expect, it, vi } from 'vitest';
import { encode, message } from '../src/protobuf';
import { FetchGroupRequests, FetchFilteredGroupRequests } from '../src/oidb/request/group-requests';

const user = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'name', tag: 2, type: 'string' },
]);
const response = message([
  {
    name: 'requests',
    tag: 1,
    repeated: true,
    type: message([
      { name: 'sequence', tag: 1, type: 'uint64' },
      { name: 'eventType', tag: 2, type: 'uint32' },
      { name: 'state', tag: 3, type: 'uint32' },
      { name: 'target', tag: 5, type: user },
      { name: 'invitor', tag: 6, type: user },
    ]),
  },
]);

describe('群申请收件箱身份解码', () => {
  it.each([FetchGroupRequests, FetchFilteredGroupRequests])(
    'UIN 信封中的 UID 字符串不丢失',
    async (spec) => {
      const nt = {
        sendOidbPacket: vi.fn(async () =>
          Buffer.from(
            encode(response, {
              requests: [
                {
                  sequence: 55,
                  eventType: 7,
                  state: 1,
                  target: { uid: 'u_applicant', name: '申请人' },
                  invitor: { uid: 'u_inviter' },
                },
              ],
            }),
          ),
        ),
      };
      const result = await spec.invoke(nt, 1, {});
      expect(result.requests[0]).toMatchObject({
        eventType: 7,
        state: 1,
        target: { uid: 'u_applicant', uin: 0, name: '申请人' },
        invitor: { uid: 'u_inviter', uin: 0 },
      });
    },
  );
  it('数值 QQ 号仍保留，不伪造成 UID', async () => {
    const nt = {
      sendOidbPacket: vi.fn(async () =>
        Buffer.from(
          encode(FetchGroupRequests.respSchema, {
            requests: [
              { sequence: 56, eventType: 7, state: 1, target: { uin: 10002, name: '申请人' } },
            ],
          }),
        ),
      ),
    };
    const result = await FetchGroupRequests.invoke(nt, 1, {});
    expect(result.requests[0]?.target).toEqual({ uid: '', uin: 10002, name: '申请人' });
  });
});
