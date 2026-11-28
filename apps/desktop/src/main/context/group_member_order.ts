import { z } from 'zod/v3';
import { createPinyinMatcher } from '@weq/codec/pinyin-search';
import { formatUnixTime } from '@weq/time';
import { profileTimeSeconds } from '@weqbot/protocol/profile-values';
import type { GroupMember } from '@weq/db';
import type { ContactMetricRows } from '@weq/service';
import { holdTaskOnPage } from '../task_page';
import {
  GROUP_MEMBER_SORTS,
  GROUP_MEMBER_ONLINE_SORTS,
  compareGroupMemberValues,
  groupMemberCollator,
  displayGroupMemberName,
  groupMemberRoleOrder,
  isGroupMemberOnlineSort,
  type GroupMemberOrderValue,
  type GroupMemberOnlineSort,
  type GroupMemberSort,
  type GroupMemberSortView,
} from '../../shared/group_member_order';
import {
  birthReference,
  contactBirth,
  contactBirthdayText,
  birthRangeText,
} from '../../shared/contactBirth';
import { groupMemberToWire } from '../ipc/serde';
import { archiveCompletedTask, backgroundTasks, taskError } from '../background_tasks';
import { recordAccountTask } from '../account_task_receipts';
import { albumAccessState } from '../account_resource_exports';
import { getAppContext, type AccountServices } from './app_context';

type CachedProfile = Awaited<ReturnType<AccountServices['profile']['profilesByUids']>>[number];
type MemberProfile = Pick<CachedProfile, 'uid' | 'nick' | 'remark'> &
  Partial<
    Pick<
      CachedProfile,
      | 'birthYear'
      | 'birthMonth'
      | 'birthDay'
      | 'age'
      | 'intimacy'
      | 'sigUpdateTime'
      | 'isBot'
      | 'extInfo'
    >
  >;

async function rosterProfiles(
  services: AccountServices,
  members: readonly GroupMember[],
  sort: GroupMemberSort,
) {
  const full = ['age', 'birthday', 'intimacy', 'sigUpdateTime', 'likeCount'].includes(sort);
  const profiles = new Map<string, MemberProfile>();
  for (let offset = 0; offset < members.length; offset += 400) {
    const ids = members.slice(offset, offset + 400).map(({ uid }) => uid);
    const rows = full
      ? await services.profile.profilesByUids(ids)
      : await services.profile.memberNamesByUids(ids);
    for (const row of rows) profiles.set(row.uid, row);
  }
  return profiles;
}

async function activeRoster(services: AccountServices, groupCode: string) {
  const rows = await services.groupInfo.listMembersInGroup(BigInt(groupCode), -1);
  const members = new Map<string, GroupMember>();
  for (const row of rows) {
    if (row.uid.trim() && row.uin > 0n && !members.has(row.uid)) members.set(row.uid, row);
  }
  return [...members.values()];
}

const positive = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const knownCount = (value?: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const numbers = new Intl.NumberFormat('zh-CN');

function memberMetric(
  rows: ContactMetricRows,
  member: Pick<GroupMember, 'uid' | 'uin'>,
  sort: GroupMemberOnlineSort,
) {
  return rows[`friend:${member.uin}`]?.[sort]?.value ?? rows[`friend:${member.uid}`]?.[sort]?.value;
}

function orderValue(
  member: GroupMember,
  profile: MemberProfile | undefined,
  name: string,
  sort: GroupMemberSort,
  metricRows: ContactMetricRows,
  birth: ReturnType<typeof contactBirth> | undefined,
  messageTime: number | null | undefined,
  affinity: number | undefined,
): GroupMemberOrderValue {
  switch (sort) {
    case 'displayName':
      return name;
    case 'nick':
      return member.nick.trim() || profile?.nick.trim() || null;
    case 'remark':
      return profile?.remark.trim() || null;
    case 'uin':
      return String(member.uin);
    case 'joinedAt':
      return member.joinTime > 1 ? member.joinTime : null;
    case 'lastSpeakAt':
      return positive(member.lastSpeakTime);
    case 'memberLevel':
      return positive(member.memberLevel);
    case 'age':
      return birth?.ageOrder ?? null;
    case 'birthday':
      return birth?.birthdayOrder ?? null;
    case 'intimacy':
      return positive(profile?.intimacy);
    case 'sigUpdateTime':
      return profileTimeSeconds(profile?.sigUpdateTime);
    case 'lastMessageAt':
      return positive(messageTime);
    case 'affinity':
      return knownCount(affinity);
    case 'likeCount':
      if (profile?.isBot || profile?.extInfo?.isEnterprise) return null;
      break;
  }
  const metric = memberMetric(metricRows, member, sort);
  if (sort === 'commonGroups' && Array.isArray(metric)) return metric.length;
  return typeof metric === 'number' ? knownCount(metric) : null;
}

function orderDetail(
  sort: GroupMemberSort,
  value: GroupMemberOrderValue,
  birth?: ReturnType<typeof contactBirth>,
) {
  if (sort === 'displayName') return null;
  if (birth) {
    const date = contactBirthdayText(birth);
    const age = birth.age === null ? '' : `${birth.age} 岁`;
    return {
      text: date ? (age ? `${date}（${age}）` : date) : age || '未读取',
      title: birthRangeText(birth) ?? undefined,
    };
  }
  if (value === null) return { text: '未读取' };
  const display =
    typeof value === 'number'
      ? ['joinedAt', 'lastSpeakAt', 'sigUpdateTime', 'lastMessageAt', 'addedAt'].includes(sort)
        ? formatUnixTime(value, 'minute')
        : sort === 'memberLevel'
          ? `Lv${value}`
          : numbers.format(value)
      : value;
  return { text: display };
}

export async function listOrderedGroupMembers(
  services: AccountServices,
  input: {
    groupCode: string;
    keyword: string;
    sort: GroupMemberSort;
    descending: boolean;
    prioritizeAdmins: boolean;
    limit: number | 'all';
    offset: number;
  },
) {
  const { groupCode, keyword, sort, descending, prioritizeAdmins, offset, limit } = input;
  const directory = services.contactDirectory;
  const [roster, detail] = await Promise.all([
    activeRoster(services, groupCode),
    services.groupInfo.getGroupDetail(BigInt(groupCode)),
  ]);
  const [profiles, metrics, times, affinities] = await Promise.all([
    rosterProfiles(services, roster, sort),
    isGroupMemberOnlineSort(sort) && directory
      ? directory.cache.rowsFor(
          roster.flatMap(({ uid, uin }) => [`friend:${uid}`, `friend:${uin}`]),
        )
      : undefined,
    sort === 'lastMessageAt' ? directory?.localTimes() : undefined,
    sort === 'affinity' ? directory?.cachedProfiles() : undefined,
  ]);
  const affinityByUid = new Map(affinities?.map((row) => [row.uid, row.affinity]));
  const needle = keyword.toLowerCase();
  const matcher = createPinyinMatcher(keyword);
  const reference = birthReference();
  const ordered = roster.flatMap((member) => {
    const profile = profiles.get(member.uid);
    const nick = member.nick.trim() || profile?.nick.trim();
    const name = displayGroupMemberName(member.card, profile?.remark, nick, String(member.uin));
    if (
      needle &&
      ![name, member.card, nick, String(member.uin)].some((text) =>
        text?.toLowerCase().includes(needle),
      ) &&
      !matcher?.rankWithPreferredName(name, nick ?? '')
    )
      return [];
    const birth =
      sort === 'age' || sort === 'birthday' ? contactBirth(profile ?? {}, reference) : undefined;
    const value = orderValue(
      member,
      profile,
      name,
      sort,
      metrics ?? {},
      birth,
      times?.rows[member.uid]?.time ?? times?.rows[String(member.uin)]?.time,
      affinityByUid.get(member.uid),
    );
    const role = prioritizeAdmins
      ? groupMemberRoleOrder(detail?.ownerUid === member.uid, member.adminFlag > 0)
      : 0;
    return [{ member, name, birth, value, role }];
  });
  ordered.sort(
    (a, b) =>
      a.role - b.role ||
      compareGroupMemberValues(a.value, b.value, descending) ||
      (sort === 'birthday'
        ? compareGroupMemberValues(a.birth?.ageOrder ?? null, b.birth?.ageOrder ?? null, descending)
        : 0) ||
      groupMemberCollator.compare(a.name, b.name) ||
      a.member.uid.localeCompare(b.member.uid),
  );
  return {
    members: ordered
      .slice(offset, limit === 'all' ? undefined : offset + limit)
      .map(({ member, name, birth, value }) => ({
        member: groupMemberToWire(member),
        displayName: name,
        remark: profiles.get(member.uid)?.remark,
        nick: member.nick.trim() || profiles.get(member.uid)?.nick,
        isBot: profiles.get(member.uid)?.isBot || undefined,
        sortDetail: orderDetail(sort, value, birth),
      })),
    ownerUid: detail?.ownerUid,
    total: ordered.length,
    preparing: times?.done === false,
  };
}

const pendingTasks = new WeakMap<AccountServices, Map<string, string>>();
const groupMemberOrderRequest = z.object({
  groupCode: z.string().regex(/^[1-9]\d{0,9}$/),
  sort: z.enum(GROUP_MEMBER_ONLINE_SORTS),
  descending: z.boolean().optional(),
  prioritizeAdmins: z.boolean().optional(),
});

export function retryGroupMemberOrderTask(
  id: string,
  scope: { uin: string; configId?: string },
  raw: unknown,
) {
  const { groupCode, sort, ...order } = groupMemberOrderRequest.parse(raw);
  const { account, services } = getAppContext();
  const configId = scope.configId;
  const checkAccount = () => {
    const current = getAppContext();
    const record = current.services?.accountConfig.getRecord();
    if (
      current.account !== account ||
      current.services !== services ||
      record?.uin !== scope.uin ||
      record.configId !== configId
    )
      throw new Error('账号或数据源已切换，请返回原账号后继续');
  };
  if (!services || !configId) throw new Error('原数据源未打开');
  checkAccount();
  const access = albumAccessState(services);
  if (!access.qqOnline || !access.attachEnabled) throw new Error('请先连接 QQ 再补取成员资料');
  startGroupMemberOrderTask(
    services,
    { ...scope, configId },
    groupCode,
    sort,
    checkAccount,
    undefined,
    id,
    order,
  );
}

export function startGroupMemberOrderTask(
  services: AccountServices,
  scope: { uin: string; configId: string },
  groupCode: string,
  sort: GroupMemberOnlineSort,
  checkAccount: () => void,
  pageId?: string,
  existingId?: string,
  order?: GroupMemberSortView,
) {
  const directory = services.contactDirectory;
  if (!directory) throw new Error('好友/群信息缓存尚未就绪');
  const tasks = pendingTasks.get(services) ?? new Map<string, string>();
  pendingTasks.set(services, tasks);
  const key = `${groupCode}:${sort}`;
  const running = tasks.get(key);
  if (running) {
    if (existingId && running !== existingId) throw new Error('该群资料正在读取，请等待完成');
    return running;
  }
  const foreground = holdTaskOnPage(pageId, `member-sort:${scope.configId}:${key}`, () => {
    if (tasks.get(key) === taskId) backgroundTasks.setForeground(taskId, false);
  });
  const taskId =
    existingId ??
    backgroundTasks.start({
      name: `读取群 ${groupCode} 成员的${GROUP_MEMBER_SORTS[sort]}`,
      kind: 'contacts',
      scope,
      groupMemberOrder: { groupCode, sort, ...order },
      foreground,
      statusLabel: '读取成员名单',
    });
  const request = { groupCode, sort, ...order };
  const archiveRoot = getAppContext().platform?.appDataRoot?.();
  const save = recordAccountTask(taskId, scope, request);
  const retry = {
    id: 'retry',
    label: '继续补取',
    run: () => retryGroupMemberOrderTask(taskId, scope, request),
  };
  tasks.set(key, taskId);
  backgroundTasks.resume(taskId);
  backgroundTasks.update(taskId, {
    progress: undefined,
    statusLabel: '读取成员名单',
    note: undefined,
    details: [],
  });
  backgroundTasks.setActions(taskId, []);
  void (async () => {
    try {
      checkAccount();
      save();
      const roster = await activeRoster(services, groupCode);
      const friendUids =
        sort === 'addedAt'
          ? new Set((await services.profile.listBuddies()).map((row) => row.uid))
          : null;
      const profiles = sort === 'likeCount' ? await rosterProfiles(services, roster, sort) : null;
      const members = roster.filter((row) => {
        if (String(row.uin) === scope.uin || !/^u_[\w-]+$/.test(row.uid)) return false;
        if (friendUids && !friendUids.has(row.uid)) return false;
        const profile = profiles?.get(row.uid);
        return !profile?.isBot && !profile?.extInfo?.isEnterprise;
      });
      const rows = await directory.cache.rowsFor(
        members.flatMap(({ uid, uin }) => [`friend:${uid}`, `friend:${uin}`]),
      );
      const needed = members.filter((member) => memberMetric(rows, member, sort) == null);
      let done = 0;
      let failed = 0;
      const errors = new Set<string>();
      checkAccount();
      for (let offset = 0; offset < needed.length; offset += 4) {
        checkAccount();
        await Promise.all(
          needed.slice(offset, offset + 4).map(async ({ uid, uin }) => {
            try {
              const target = String(uin);
              switch (sort) {
                case 'level':
                  await services.peerStats.getQqLevel(target, 1);
                  break;
                case 'energy':
                  await services.profileExtras.energy(target, 1);
                  break;
                case 'likeCount':
                  await services.peerStats.getLikeCount(uid, 1);
                  break;
                case 'addedAt':
                  await services.accountWrite.friendClue(uid, 1);
                  break;
                default: {
                  const common = await services.accountWrite.commonRelationships(
                    target,
                    1,
                    'attributes',
                  );
                  if (sort === 'commonGroups' && common.groupError)
                    throw new Error(common.groupError);
                }
              }
              const value = memberMetric(
                await directory.cache.rowsFor([`friend:${uid}`, `friend:${uin}`]),
                { uid, uin },
                sort,
              );
              if (value == null) throw new Error('QQ 未返回该字段');
            } catch (error) {
              failed++;
              if (errors.size < 5) errors.add(taskError(error));
            }
            done++;
            backgroundTasks.update(taskId, {
              progress: (100 * done) / needed.length,
              statusLabel: `${done}/${needed.length}`,
            });
          }),
        );
      }
      checkAccount();
      await directory.cache.flush();
      checkAccount();
      backgroundTasks.finish(taskId, failed ? 'failed' : 'completed', {
        statusLabel: failed && done > failed ? '部分资料未取得' : undefined,
        note: needed.length
          ? `已取得 ${done - failed}/${needed.length} 位成员的资料`
          : '暂无需要补取的资料',
        details: [...errors],
      });
      if (failed) backgroundTasks.setActions(taskId, [retry]);
      else archiveCompletedTask(archiveRoot, taskId);
    } catch (error) {
      backgroundTasks.finish(taskId, 'failed', { note: taskError(error) });
      backgroundTasks.setActions(taskId, [retry]);
    } finally {
      tasks.delete(key);
      try {
        save();
      } catch (error) {
        console.warn('[群成员] 任务回执保存失败', error);
      }
    }
  })();
  return taskId;
}
