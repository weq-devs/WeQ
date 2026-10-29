import type { AppContext } from '../context/app_context';
import { ActionError, bool, id, integer, text, type Params } from './contracts';

export type ActionServices = NonNullable<AppContext['services']>;
export type ActionSession = NonNullable<AppContext['account']>;

export function createActions(
  services: ActionServices,
  session: ActionSession,
  requireActive: () => void,
  imageReady: () => Promise<boolean>,
) {
  async function uid(value: unknown, group?: string): Promise<string> {
    const uin = id(value);
    let result = session.uidMap.uidByUin(BigInt(uin));
    if (!result && group) {
      const members = await services.groupInfo.fetchOnlineMembers(Number(group));
      requireActive();
      result = members.find((member) => String(member.uin) === uin)?.uid ?? '';
    }
    if (!result) throw new ActionError(`无法解析 QQ ${uin} 的 UID`);
    return result;
  }

  async function groupInfo(groupId: string) {
    const group = await services.groupInfo.getGroupDetail(BigInt(groupId));
    requireActive();
    if (!group) throw new ActionError('没有该群的资料', 1404);
    return {
      group_id: Number(groupId),
      group_name: group.groupName,
      member_count: group.memberCount,
      max_member_count: group.maxMemberCount,
    };
  }

  async function run(action: string, p: Params): Promise<unknown> {
    switch (action) {
      case 'get_friend_list': {
        const out: { user_id: number; nickname: string; remark: string }[] = [];
        for (let offset = 0; ; offset += 500) {
          const buddies = await services.profile.listBuddies(500, offset);
          requireActive();
          const profiles = await services.profile.profilesByUids(buddies.map((buddy) => buddy.uid));
          requireActive();
          const byUid = new Map(profiles.map((profile) => [profile.uid, profile]));
          for (const buddy of buddies) {
            const profile = byUid.get(buddy.uid);
            out.push({
              user_id: Number(buddy.uin),
              nickname: profile?.nick ?? '',
              remark: profile?.remark ?? '',
            });
          }
          if (buddies.length < 500) return out;
        }
      }
      case 'get_group_list': {
        const directory = await services.groupInfo.listGroupDirectory();
        requireActive();
        const out = [];
        for (const entry of directory) {
          out.push(await groupInfo(entry.groupCode));
        }
        return out;
      }
      case 'can_send_image':
        return { yes: await imageReady() };
      case 'can_send_record':
        return { yes: false };
      case 'set_group_name':
        await services.groupModeration.setName({
          groupId: Number(id(p.group_id)),
          name: text(p.group_name),
        });
        return null;
      case 'set_group_whole_ban':
        await services.groupModeration.muteAll({
          groupId: Number(id(p.group_id)),
          enable: bool(p.enable, true),
        });
        return null;
      case 'set_group_card':
      case 'set_group_ban':
      case 'set_group_admin':
      case 'set_group_kick': {
        const groupId = id(p.group_id);
        const targetUid = await uid(p.user_id, groupId);
        requireActive();
        if (action === 'set_group_card')
          await services.groupModeration.setMemberCard({
            groupId,
            targetUid,
            card: text(p.card, ''),
          });
        if (action === 'set_group_ban')
          await services.groupModeration.muteMember({
            groupId,
            targetUid,
            duration: integer(p.duration, 1800, 0, 30 * 86400),
          });
        if (action === 'set_group_admin')
          await services.groupModeration.setAdmin({
            groupId,
            targetUid,
            enable: bool(p.enable, true),
          });
        if (action === 'set_group_kick')
          await services.groupModeration.kickMember({
            groupId,
            targetUid,
            reject: bool(p.reject_add_request),
          });
        return null;
      }
      case 'get_group_at_all_remain': {
        const result = await services.groupModeration.getAtAllRemain(
          id(p.group_id),
          session.context.uin,
        );
        return {
          can_at_all: result.canAtAll,
          remain_at_all_count_for_group: result.remainCountForGroup,
          remain_at_all_count_for_uin: result.remainCountForUin,
        };
      }
      case 'set_friend_remark': {
        const targetUid = await uid(p.user_id);
        requireActive();
        const result = await services.accountWrite.friendRemark(targetUid, text(p.remark, ''));
        if (result.state === 'unconfirmed')
          throw new ActionError('好友备注操作结果未确认，请读回后核对', 1500);
        return result;
      }
      case 'set_group_remark':
        return services.accountWrite.groupRemark(Number(id(p.group_id)), text(p.remark, ''));
      case 'send_poke':
      case 'friend_poke':
      case 'group_poke': {
        const group =
          action === 'group_poke' || (action === 'send_poke' && p.group_id !== undefined);
        await services.interaction.sendPoke({
          peerType: group ? 'group' : 'c2c',
          targetId: id(group ? p.group_id : p.user_id),
          ...(group ? { targetUin: id(p.user_id) } : {}),
        });
        return null;
      }
      case 'mark_private_msg_as_read': {
        const target = await uid(p.user_id);
        requireActive();
        return services.unreadInfo.markReadAndReport(1, target);
      }
      case 'mark_group_msg_as_read':
        return services.unreadInfo.markReadAndReport(2, id(p.group_id));
      case 'get_group_root_files':
      case 'get_group_files_by_folder': {
        const groupId = Number(id(p.group_id));
        const listing = await services.groupFile.list(
          groupId,
          action === 'get_group_root_files' ? '/' : text(p.folder_id ?? p.folder),
          { beforeRequest: requireActive },
        );
        return {
          files: listing.files.map((file) => ({
            group_id: groupId,
            file_id: file.fileId,
            file_name: file.fileName,
            busid: file.busId,
            file_size: file.fileSize,
            upload_time: file.uploadedTime,
            dead_time: file.expireTime,
            modify_time: file.modifiedTime,
            download_times: file.downloadedTimes,
            uploader: file.uploaderUin,
            uploader_name: file.uploaderName,
          })),
          folders: listing.folders.map((folder) => ({
            group_id: groupId,
            folder_id: folder.folderId,
            folder_name: folder.folderName,
            create_time: folder.createTime,
            creator: folder.creatorUin,
            creator_name: folder.creatorName,
            total_file_count: folder.totalFileCount,
          })),
        };
      }
      case 'get_group_file_system_info': {
        const groupId = Number(id(p.group_id));
        const count = await services.groupFile.count(groupId);
        requireActive();
        const space = await services.groupFile.space(groupId);
        return {
          file_count: count.fileCount,
          limit_count: count.maxCount,
          used_space: space.usedSpace,
          total_space: space.totalSpace,
        };
      }
      case 'get_group_file_url':
        return {
          url: await services.mediaUrl.getGroupFileUrl(
            Number(id(p.group_id)),
            text(p.file_id),
            integer(p.busid, 102),
          ),
        };
      case 'delete_group_file':
        await services.groupFile.deleteFile(Number(id(p.group_id)), text(p.file_id));
        return null;
      case 'rename_group_file':
        await services.groupFile.renameFile(
          Number(id(p.group_id)),
          text(p.file_id),
          text(p.current_parent_directory ?? p.parent_directory, '/'),
          text(p.new_name),
        );
        return { ok: true };
      case 'move_group_file':
        await services.groupFile.moveFile(
          Number(id(p.group_id)),
          text(p.file_id),
          text(p.parent_directory),
          text(p.target_directory),
        );
        return null;
      case 'create_group_file_folder': {
        const folderInfo = await services.groupFile.createFolder(
          Number(id(p.group_id)),
          text(p.parent_id, '/'),
          text(p.name),
        );
        return { result: { retCode: 0, retMsg: 'success' }, groupItem: { folderInfo } };
      }
      case 'delete_group_folder':
      case 'delete_group_file_folder':
        await services.groupFile.deleteFolder(Number(id(p.group_id)), text(p.folder_id));
        return null;
      default:
        throw new ActionError(`不支持的 OneBot action：${action}`, 1404);
    }
  }
  return async (action: string, params: Params) => {
    requireActive();
    const result = await run(action, params);
    requireActive();
    return result;
  };
}
