import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUid } from './write-validation';
import type { OidbNative } from '../transport';

export const SNS_SPECIAL_CARE_RING = 13568;
export const SNS_SPECIAL_CARE_ZONE = 13572;
export const SNS_SPECIAL_CARE = 13573;

/** 产品采用三项整体开关；未知业务 ACK 必须由独立名册读回确认。 */
export namespace SetFriendSpecialCare {
  export const command = 0x5d6;
  export const subCommand = 6;
  export const needSign = true;
  export const reqSchema = message([
    { name: 'sequence', tag: 1, type: 'uint32', force: true },
    {
      name: 'target',
      tag: 2,
      type: message([
        { name: 'uid', tag: 1, type: 'string' },
        {
          name: 'attributes',
          tag: 400,
          repeated: true,
          type: message([
            { name: 'type', tag: 1, type: 'uint32' },
            { name: 'value', tag: 2, type: 'bytes', force: true },
          ]),
        },
      ]),
    },
    { name: 'domain', tag: 3, type: 'uint32' },
  ]);
  export const respSchema = message([]);
  export function serialize(p: { uid: string; enabled: boolean }): Record<string, unknown> {
    return {
      sequence: 0,
      domain: 1,
      target: {
        uid: requireUid(p.uid),
        attributes: [SNS_SPECIAL_CARE_RING, SNS_SPECIAL_CARE_ZONE, SNS_SPECIAL_CARE].map(
          (type) => ({
            type,
            value: p.enabled ? Uint8Array.of(49) : new Uint8Array(),
          }),
        ),
      },
    };
  }
  export const deserialize = (_body: Record<string, unknown>): 'unconfirmed' => 'unconfirmed';
  export const invoke = (
    nt: OidbNative,
    pid: number,
    p: { uid: string; enabled: boolean },
  ): Promise<'unconfirmed'> => invokeOidb(nt, pid, SetFriendSpecialCare, p);
}
