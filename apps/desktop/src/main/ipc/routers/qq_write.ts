import { z } from 'zod';
import type { AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
const uid = z.string().regex(/^u_[A-Za-z0-9_-]+$/);
const uint32 = z.number().int().min(0).max(0xffffffff);
const groupId = uint32.positive();
const remark = z.string().max(1024);
const source = z.string().min(1);

export type QQWriteBinding = z.infer<typeof binding>;

export interface QQWriteServices {
  accountWrite: Pick<
    AccountServices['accountWrite'],
    | 'friendRemark'
    | 'groupRemark'
    | 'pin'
    | 'friendDisturb'
    | 'groupMessagePolicy'
    | 'friendCategory'
    | 'selfProfile'
    | 'onlineStatus'
    | 'selfAvatar'
    | 'groupAvatar'
    | 'selfIdentity'
  >;
  groupModeration: Pick<
    AccountServices['groupModeration'],
    'setName' | 'setMemberCard' | 'setSpecialTitle' | 'setEssence'
  >;
  profile: Pick<AccountServices['profile'], 'getProfile' | 'getBuddy' | 'getSelfProfile'>;
  groupInfo: Pick<
    AccountServices['groupInfo'],
    'getGroupDetail' | 'listGroupDirectory' | 'getMemberInfo'
  >;
  recentContacts: Pick<AccountServices['recentContacts'], 'getTopContacts' | 'getByTargetUids'>;
  onlineStatus: Pick<AccountServices['onlineStatus'], 'getOnlineStatus' | 'editableStatuses'>;
}

/** 身份绑定和在线检查由账号路由共用入口提供，所有 mutation 都必须通过。 */
export function createQQWriteRouter(
  resolve: (input: QQWriteBinding) => QQWriteServices,
  read: (input: QQWriteBinding) => QQWriteServices,
) {
  return router({
    memberState: procedure.input(binding.extend({ groupId, uid })).query(async ({ input }) => {
      const services = read(input);
      const member = await services.groupInfo.getMemberInfo(BigInt(input.groupId), input.uid);
      if (read(input) !== services) throw new Error('账号已切换，请重新读取成员资料');
      return member ? { uid: member.uid, card: member.card, title: member.customTitle } : null;
    }),
    selfState: procedure.input(binding).query(async ({ input }) => {
      const services = read(input);
      const identity = services.accountWrite.selfIdentity();
      const profile = await services.profile.getSelfProfile();
      if (profile && profile.uin.toString() !== identity.uin)
        throw new Error('资料缓存与当前账号不匹配');
      const status = identity.uid
        ? await services.onlineStatus.getOnlineStatus(identity.uid)
        : null;
      if (read(input) !== services) throw new Error('账号已切换，请重新读取资料');
      return {
        profile: profile
          ? {
              uid: profile.uid,
              uin: profile.uin.toString(),
              nick: profile.nick,
              signature: profile.signature,
              gender: profile.gender,
            }
          : null,
        status,
        statusOptions: services.onlineStatus.editableStatuses(),
        source: 'qq-local-cache' as const,
        identity,
      };
    }),
    peerState: procedure
      .input(
        binding.extend({
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('c2c'), uid }),
            z.object({ kind: z.literal('group'), groupId }),
          ]),
        }),
      )
      .query(async ({ input }) => {
        const services = read(input);
        const target = input.target;
        const conv = target.kind === 'c2c' ? target.uid : String(target.groupId);
        const identity = services.accountWrite.selfIdentity();
        const [tops, rows, profile, buddy, group, directory] = await Promise.all([
          services.recentContacts.getTopContacts(),
          services.recentContacts.getByTargetUids([conv]),
          target.kind === 'c2c' ? services.profile.getProfile(target.uid) : null,
          target.kind === 'c2c' ? services.profile.getBuddy(target.uid) : null,
          target.kind === 'group'
            ? services.groupInfo.getGroupDetail(BigInt(target.groupId))
            : null,
          target.kind === 'group' ? services.groupInfo.listGroupDirectory() : [],
        ]);
        const member =
          target.kind === 'group' && identity.uid
            ? await services.groupInfo.getMemberInfo(BigInt(target.groupId), identity.uid)
            : null;
        if (read(input) !== services) throw new Error('账号已切换，请重新读取会话设置');
        const entry = directory.find((item) => item.groupCode === conv);
        const notifyLevel = entry?.notifyLevel ?? rows[0]?.notifyLevel ?? null;
        return {
          source: 'qq-local-cache' as const,
          pinned: tops.some((item) => item.targetId === conv),
          notifyLevel,
          friend: Boolean(buddy),
          categoryId: buddy?.categoryId ?? null,
          remark: profile?.remark ?? group?.remark ?? null,
          groupName: group?.groupName ?? null,
          selfUid: identity.uid,
          selfCard: member?.card ?? null,
          selfTitle: member?.customTitle ?? null,
          role:
            entry?.role ??
            (group?.ownerUid && identity.uid && group.ownerUid === identity.uid ? 'owner' : null),
        };
      }),
    friendRemark: procedure
      .input(binding.extend({ uid, remark }))
      .mutation(({ input }) => resolve(input).accountWrite.friendRemark(input.uid, input.remark)),
    groupRemark: procedure
      .input(binding.extend({ groupId, remark }))
      .mutation(({ input }) =>
        resolve(input).accountWrite.groupRemark(input.groupId, input.remark),
      ),
    pin: procedure
      .input(
        binding.extend({
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('c2c'), uid }),
            z.object({ kind: z.literal('group'), groupId }),
          ]),
          enabled: z.boolean(),
        }),
      )
      .mutation(({ input }) => resolve(input).accountWrite.pin(input.target, input.enabled)),
    friendDisturb: procedure
      .input(binding.extend({ uid, enabled: z.boolean() }))
      .mutation(({ input }) => resolve(input).accountWrite.friendDisturb(input.uid, input.enabled)),
    groupMessagePolicy: procedure
      .input(
        binding.extend({
          groupId,
          policy: z.union([z.literal(1), z.literal(4), z.literal(2), z.literal(3)]),
        }),
      )
      .mutation(({ input }) =>
        resolve(input).accountWrite.groupMessagePolicy(input.groupId, input.policy),
      ),
    friendCategory: procedure
      .input(binding.extend({ uid, categoryId: uint32 }))
      .mutation(({ input }) =>
        resolve(input).accountWrite.friendCategory(input.uid, input.categoryId),
      ),
    selfProfile: procedure
      .input(
        binding.extend({
          patch: z
            .object({
              nickname: z.string().min(1).max(256).optional(),
              signature: z.string().max(4096).optional(),
              gender: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
            })
            .strict(),
        }),
      )
      .mutation(({ input }) => resolve(input).accountWrite.selfProfile(input.patch)),
    onlineStatus: procedure
      .input(
        binding.extend({
          status: uint32.positive(),
          extStatus: uint32.optional(),
          batteryStatus: uint32.optional(),
          custom: z
            .object({ faceId: uint32, faceType: uint32, wording: z.string().max(1024) })
            .optional(),
        }),
      )
      .mutation(({ input }) => resolve(input).accountWrite.onlineStatus(input)),
    selfAvatar: procedure
      .input(binding.extend({ source }))
      .mutation(({ input }) => resolve(input).accountWrite.selfAvatar(input.source)),
    groupAvatar: procedure
      .input(binding.extend({ groupId, source }))
      .mutation(({ input }) =>
        resolve(input).accountWrite.groupAvatar(input.groupId, input.source),
      ),
    groupName: procedure
      .input(binding.extend({ groupId, name: z.string().min(1).max(256) }))
      .mutation(async ({ input }) => {
        await resolve(input).groupModeration.setName(input);
        return { state: 'accepted' as const };
      }),
    groupMemberCard: procedure
      .input(binding.extend({ groupId, targetUid: uid, card: z.string().max(256) }))
      .mutation(async ({ input }) => {
        await resolve(input).groupModeration.setMemberCard(input);
        return { state: 'accepted' as const };
      }),
    groupSpecialTitle: procedure
      .input(binding.extend({ groupId, targetUid: uid, title: z.string().max(256) }))
      .mutation(async ({ input }) => {
        await resolve(input).groupModeration.setSpecialTitle(input);
        return { state: 'accepted' as const };
      }),
    groupEssence: procedure
      .input(
        binding.extend({
          groupId,
          sequence: uint32.positive(),
          random: uint32,
          enable: z.boolean(),
        }),
      )
      .mutation(async ({ input }) => {
        await resolve(input).groupModeration.setEssence(input);
        return { state: 'accepted' as const };
      }),
  });
}
