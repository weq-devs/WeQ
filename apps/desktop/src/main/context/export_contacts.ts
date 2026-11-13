import type { GroupInfoService, MediaDeps, ProfileService } from '@weq/service';

/** 在线账号与导入账号共用本地资料读取，导出选择不触发在线资料刷新。 */
export function createContactsExportDeps(
  profile: ProfileService,
  groupInfo: GroupInfoService,
): NonNullable<MediaDeps['contacts']> {
  const groupRow = (
    group: NonNullable<Awaited<ReturnType<GroupInfoService['getGroupDetail']>>>,
  ) => ({
    ...group,
    groupCode: group.groupCode.toString(),
    customLabels: group.customLabels.map((label) => ({
      ...label,
      groupCode: label.groupCode?.toString(),
      labelId: label.labelId?.toString(),
      setTimestamp: label.setTimestamp?.toString(),
    })),
  });
  return {
    groupByCode: async (code) => {
      const group = await groupInfo.getGroupDetail(BigInt(code));
      return group ? groupRow(group) : null;
    },
    listGroups: async (limit, offset) =>
      (await groupInfo.listAllGroups(limit, offset)).map(groupRow),
    listBuddies: async (limit, offset) =>
      (await profile.listBuddies(limit, offset)).map((buddy) => ({
        uid: buddy.uid,
        uin: buddy.uin.toString(),
        qid: buddy.qid,
        categoryId: buddy.categoryId,
      })),
    listCategories: async () =>
      (await profile.listCategories()).map((category) => ({
        id: category.id,
        name: category.name,
      })),
    profilesByUids: async (uids) =>
      (await profile.profilesByUids(uids)).map((value) => ({
        uid: value.uid,
        nick: value.nick,
        remark: value.remark,
        signature: value.signature,
        sigUpdateTime: value.sigUpdateTime,
        gender: value.gender,
        age: value.age,
        birthYear: value.birthYear,
        birthMonth: value.birthMonth,
        birthDay: value.birthDay,
        intimacy: value.intimacy,
        extInfo: value.extInfo,
      })),
    listGroupMembers: async (code, limit, offset) =>
      (await groupInfo.listMembersInGroup(BigInt(code), limit, offset)).map((member) => ({
        uid: member.uid,
        uin: member.uin.toString(),
        card: member.card,
        nick: member.nick,
        adminFlag: member.adminFlag,
        customTitle: member.customTitle,
        memberLevel: member.memberLevel,
        joinTime: member.joinTime,
        lastSpeakTime: member.lastSpeakTime,
      })),
    groupOwnerUid: async (code) => (await groupInfo.getGroupDetail(BigInt(code)))?.ownerUid ?? null,
  };
}
