import { observable } from '@trpc/server/observable';
import { z } from 'zod/v3';
import type { GroupCallSnapshot } from '@weq/service';
import { currentGroupCall, inviteGroupCallMembers, startGroupCall } from '../../group_call';
import { withCallStart } from '../../call_registry';
import { procedure, router } from '../trpc';

const callId = z.object({ id: z.string().uuid() });
const memberInput = callId.extend({ uin: z.number().int().positive().max(0xffffffff) });
const uids = z
  .array(z.string().regex(/^u_[\w-]+$/))
  .min(1)
  .max(100);
const frame = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.length > 0 && bytes.length <= 200_000);

export const groupCallRouter = router({
  start: procedure
    .input(
      z.object({
        expectedAccountUin: z.string().regex(/^\d+$/),
        groupId: z
          .string()
          .regex(/^\d{1,10}$/)
          .refine((id) => Number(id) > 0 && Number(id) <= 0xffffffff),
        uids,
        media: z.enum(['audio', 'video']),
      }),
    )
    .mutation(({ input }) => withCallStart(() => startGroupCall(input))),
  invite: procedure
    .input(callId.extend({ uids }))
    .mutation(({ input }) => inviteGroupCallMembers(input.id, input.uids)),
  leave: procedure.input(callId).mutation(async ({ input }) => {
    await currentGroupCall(input.id)?.session?.hangup();
  }),
  mic: procedure.input(callId.extend({ muted: z.boolean() })).mutation(({ input }) => {
    currentGroupCall(input.id)?.session?.setMic(input.muted);
  }),
  camera: procedure.input(callId.extend({ on: z.boolean() })).mutation(({ input }) => {
    currentGroupCall(input.id)?.session?.setCamera(input.on);
  }),
  muteMember: procedure.input(memberInput).mutation(({ input }) => {
    const session = currentGroupCall(input.id)?.session;
    const snapshot = session?.snapshot();
    if (
      !snapshot ||
      snapshot.ownerUin !== snapshot.selfUin ||
      !snapshot.members.some((member) => member.uin === input.uin && !member.self)
    ) {
      throw new Error('只有发起人可以静音房间内的其他成员');
    }
    session?.muteMember(input.uin);
  }),
  removeMember: procedure.input(memberInput).mutation(async ({ input }) => {
    const session = currentGroupCall(input.id)?.session;
    if (!session) throw new Error('通话已结束');
    await session.removeMember(input.uin);
  }),
  pushAudio: procedure
    .input(callId.extend({ pcm: z.instanceof(Uint8Array).refine((pcm) => pcm.length === 640) }))
    .mutation(async ({ input }) => {
      await currentGroupCall(input.id)?.session?.pushAudio(input.pcm);
    }),
  pushVideo: procedure
    .input(callId.extend({ data: frame, secondary: frame.optional(), keyframe: z.boolean() }))
    .mutation(({ input }) => {
      currentGroupCall(input.id)?.session?.pushVideoFrame(
        input.data,
        input.keyframe,
        input.secondary,
      );
    }),
  state: procedure.input(callId).subscription(({ input }) =>
    observable<GroupCallSnapshot | null>((sink) => {
      const session = currentGroupCall(input.id)?.session;
      if (!session) {
        sink.next(null);
        sink.complete();
        return;
      }
      sink.next(session.snapshot());
      return session.onUpdate((snapshot) => sink.next(snapshot));
    }),
  ),
  audio: procedure
    .input(callId)
    .subscription(({ input }) =>
      observable<{ pcm: Uint8Array; uin: number }>((sink) =>
        currentGroupCall(input.id)?.session?.onAudio((pcm, uin) => sink.next({ pcm, uin })),
      ),
    ),
  video: procedure
    .input(callId)
    .subscription(({ input }) =>
      observable<{ data: Uint8Array; uin: number; keyframe: boolean }>((sink) =>
        currentGroupCall(input.id)?.session?.onVideo((data, { uin, keyframe }) =>
          sink.next({ data, uin, keyframe }),
        ),
      ),
    ),
});
