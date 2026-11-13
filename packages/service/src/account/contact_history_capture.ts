import { createHash } from 'node:crypto';
import {
  type ContactHistoryService,
  type ContactObservation,
  canonicalContactValue,
  encodeContactValue,
} from './contact_history';

type Capture = {
  service: string;
  methods: string[];
  kind: 'friend' | 'group' | 'account';
  source: 'local' | 'online';
  self?: boolean;
  page?: boolean;
  collection?: boolean;
  fallback?: boolean;
  complete?: boolean;
};
/** 接入清单只列只读业务方法；写操作仅通过其内部确认回读留存，不缓存写请求。 */
export const CONTACT_HISTORY_CAPTURE: readonly Capture[] = [
  { service: 'qqShow.opts', methods: ['fetchShow'], kind: 'friend', source: 'online' },
  {
    service: 'profile',
    methods: ['getProfile', 'getProfileByUin', 'getBotProfile', 'getBuddy'],
    kind: 'friend',
    source: 'local',
  },
  {
    service: 'profile',
    methods: [
      'profilesByUids',
      'listProfiles',
      'listFriendsByIntimacy',
      'listBuddies',
      'listExportFriends',
    ],
    kind: 'account',
    source: 'local',
    collection: true,
    page: true,
  },
  {
    service: 'profile',
    methods: ['listCategories', 'listBuddyRequests', 'listDoubtFriendRequests'],
    kind: 'account',
    source: 'local',
    self: true,
    page: true,
  },
  { service: 'profile', methods: ['getSelfProfile'], kind: 'friend', source: 'local', self: true },
  {
    service: 'profile',
    methods: ['nicksByUids', 'botUids'],
    kind: 'account',
    source: 'local',
    self: true,
    page: true,
  },
  {
    service: 'groupNotify',
    methods: [
      'listAllNotifications',
      'listNormalNotifications',
      'listDoubtNotifications',
      'fetchOnlineRequests',
    ],
    kind: 'account',
    source: 'local',
    collection: true,
    page: true,
  },
  {
    service: 'peerStats',
    methods: ['getQqLevel', 'getLikeCount', 'getQqShow', 'getPeerStats'],
    kind: 'friend',
    source: 'online',
  },
  {
    service: 'profileExtras',
    methods: ['details', 'energy', 'educationHistory', 'personalityLabels'],
    kind: 'friend',
    source: 'online',
  },
  {
    service: 'profileExtras',
    methods: [
      'signatureHistory',
      'signatureLikes',
      'anonymousDetail',
      'anonymousComments',
      'personalityPhotos',
      'anonymousQuestions',
    ],
    kind: 'friend',
    source: 'online',
    page: true,
  },
  {
    service: 'profileExtras',
    methods: ['avatarHistory'],
    kind: 'friend',
    source: 'online',
    self: true,
    page: true,
  },
  {
    service: 'accountWrite',
    methods: [
      'commonRelationships',
      'friendClue',
      'getFriendRemark',
      'getFriendDisturb',
      'getFriendSpecialCare',
    ],
    kind: 'friend',
    source: 'online',
  },
  {
    service: 'accountWrite',
    methods: ['editableSelfProfile', 'selfProfileDisplaySettings'],
    kind: 'friend',
    source: 'online',
    self: true,
  },
  {
    service: 'accountWrite',
    methods: ['friendRoster'],
    kind: 'account',
    source: 'online',
    self: true,
    collection: true,
    page: true,
  },
  {
    service: 'groupInfo',
    methods: ['getJoinInfo', 'getMessagePolicy'],
    kind: 'group',
    source: 'online',
  },
  {
    service: 'groupInfo',
    methods: ['getMemberLevelInfo', 'getGroupDetail', 'getGroupExt'],
    kind: 'group',
    source: 'local',
  },
  { service: 'groupInfo', methods: ['fetchOnlineMembers'], kind: 'group', source: 'online' },
  {
    service: 'groupInfo',
    methods: ['getMemberNotify'],
    kind: 'group',
    source: 'online',
    page: true,
  },
  {
    service: 'groupInfo',
    methods: [
      'getMemberInfo',
      'getMembersByUids',
      'getMembersByUins',
      'listMembersInGroup',
      'listLeftMembersInGroup',
      'listMembersByLevel',
      'searchMembersInGroup',
      'getGroupBulletins',
      'getEssenceMessages',
    ],
    kind: 'group',
    source: 'local',
    page: true,
  },
  {
    service: 'groupInfo',
    methods: ['getEssencePageWithContent', 'listMutedMembers'],
    kind: 'group',
    source: 'online',
    page: true,
  },
  {
    service: 'groupInfo',
    methods: [
      'listGroupDirectory',
      'listAllGroups',
      'listAllGroupsExt',
      'listExportGroups',
      'listAnalysisGroups',
    ],
    kind: 'account',
    source: 'local',
    collection: true,
    page: true,
  },
  {
    service: 'groupInfo',
    methods: ['listUserGroups'],
    kind: 'friend',
    source: 'local',
    page: true,
  },
  {
    service: 'groupInfo',
    methods: ['listAnalysisMembers', 'listExportMembers'],
    kind: 'group',
    source: 'local',
  },
  {
    service: 'onlineStatus',
    methods: ['getOnlineStatus'],
    kind: 'friend',
    source: 'local',
    fallback: false,
  },
  {
    service: 'onlineStatus',
    methods: ['fetchOnlineStatus'],
    kind: 'friend',
    source: 'online',
    fallback: false,
  },
  {
    service: 'webQuery',
    methods: ['getFriendDress', 'getFriendMutualMark', 'getQzoneSpaceStats'],
    kind: 'friend',
    source: 'online',
  },
  {
    service: 'webQuery',
    methods: ['getSelfDress', 'getVipInfo', 'getSpecialCare', 'getQzoneFriendPermissionList'],
    kind: 'friend',
    source: 'online',
    self: true,
  },
  {
    service: 'webQuery',
    methods: ['getGroupNotice'],
    kind: 'group',
    source: 'online',
    complete: true,
  },
  {
    service: 'webQuery',
    methods: [
      'getGroupEssence',
      'getGroupEssencePage',
      'getGroupAlbumList',
      'getGroupAlbumDetails',
      'getGroupAlbumFeed',
      'getGroupAlbumUploadPermission',
    ],
    kind: 'group',
    source: 'online',
    page: true,
  },
  {
    service: 'webQuery',
    methods: ['getQzoneNicknames'],
    kind: 'account',
    source: 'online',
    self: true,
    page: true,
  },
  {
    service: 'groupAlbumMedia',
    methods: ['getMediaList'],
    kind: 'group',
    source: 'online',
    page: true,
  },
  {
    service: 'groupFile',
    methods: ['list', 'listRecursive', 'count', 'space'],
    kind: 'group',
    source: 'online',
    page: true,
  },
  { service: 'groupGift', methods: ['getPanel'], kind: 'group', source: 'online' },
  {
    service: 'webQuery',
    methods: ['getHonorList', 'getDaySignedList'],
    kind: 'group',
    source: 'online',
    page: true,
  },
  {
    service: 'groupModeration',
    methods: ['getAtAllRemain', 'getTodoList'],
    kind: 'group',
    source: 'online',
  },
];

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number'
    ? String(value)
    : '';
}
function rowOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function serviceAt(services: object, path: string): object | null {
  const direct: unknown = Reflect.get(services, path);
  if (direct && typeof direct === 'object') return direct;
  let value: unknown = services;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object') return null;
    value = Reflect.get(value, key);
  }
  return value && typeof value === 'object' ? value : null;
}
function scopeOf(args: unknown[]) {
  return createHash('sha256')
    .update(canonicalContactValue(encodeContactValue(args)))
    .digest('hex');
}

/** 装在共享服务实例上，内部 this.method 调用、MCP 和所有路由均走同一留存路径。 */
export function installContactHistoryCapture(
  services: object,
  history: ContactHistoryService,
  selfUin: string,
  current: () => boolean,
  online: () => boolean = () => false,
) {
  const restore: Array<() => void> = [];
  for (const spec of CONTACT_HISTORY_CAPTURE) {
    const service = serviceAt(services, spec.service);
    if (!service || typeof service !== 'object') continue;
    for (const method of spec.methods) {
      const original: unknown = Reflect.get(service, method);
      if (typeof original !== 'function') continue;
      const owned = Object.getOwnPropertyDescriptor(service, method);
      const wrapped = async function (this: unknown, ...args: unknown[]) {
        const memberCache: unknown = Reflect.get(service, 'onlineMembersCache');
        const beforeMembers: unknown =
          method === 'fetchOnlineMembers' && memberCache instanceof Map
            ? memberCache.get(args[0])?.members
            : undefined;
        const id = spec.self || spec.kind === 'account' ? selfUin : scalar(args[0]);
        if (!id) return Reflect.apply(original, this, args);
        const entity = `${spec.kind}:${id}`;
        const category =
          method === 'fetchOnlineMembers'
            ? 'members'
            : method === 'getProfileByUin' || method === 'getSelfProfile'
              ? 'getProfile'
              : method;
        const scopeArgs = spec.self || spec.kind === 'account' ? [...args] : args.slice(1);
        if (
          ['profilesByUids', 'nicksByUids', 'getMembersByUids', 'getMembersByUins'].includes(
            method,
          ) &&
          Array.isArray(scopeArgs[0])
        )
          scopeArgs[0] = [...new Set(scopeArgs[0].map(scalar))].sort();
        const scope = spec.page ? scopeOf(scopeArgs) : '';
        const key = { entity, category, source: spec.source, scope };
        let result: unknown;
        try {
          result = await Reflect.apply(original, this, args);
        } catch (error) {
          if (!current() || online() || spec.fallback === false) throw error;
          const cached = await history.latest(key).catch(() => null);
          if (!cached) throw error;
          history.lastError = `已回退到 ${cached.last_at} 的资料：${error instanceof Error ? error.message : String(error)}`;
          return cached.value;
        }
        if (!current()) return result;
        if (result === beforeMembers && result !== undefined) return result;
        if (result === null || result === undefined) {
          if (method === 'getLikeCount' && result === null)
            await history
              .capture([{ ...key, value: null, completeness: 'complete', at: Date.now() }])
              .catch((error: unknown) => {
                history.lastError = String(error);
              });
          if (
            !['getProfile', 'getProfileByUin', 'getSelfProfile', 'getBotProfile'].includes(method)
          )
            return result;
          const cached = await history.latest(key).catch(() => null);
          return cached ? cached.value : result;
        }
        try {
          const observations: ContactObservation[] = [];
          const links: Array<{ uid: string; uin: string }> = [];
          const row = rowOf(result);
          if (row && scalar(row.targetUin) && scalar(row.targetUin) !== id) return result;
          if (
            row &&
            scalar(row.groupId ?? row.groupCode) &&
            spec.kind === 'group' &&
            scalar(row.groupId ?? row.groupCode) !== id
          )
            return result;
          if (
            row &&
            spec.kind === 'friend' &&
            id.startsWith('u_') &&
            scalar(row.uid) &&
            scalar(row.uid) !== id
          )
            return result;
          if (row?.uid && row.uin) links.push({ uid: scalar(row.uid), uin: scalar(row.uin) });
          const value =
            method === 'fetchOnlineMembers' && Array.isArray(result)
              ? [...result].sort((a, b) =>
                  scalar(rowOf(a)?.uin).localeCompare(scalar(rowOf(b)?.uin)),
                )
              : result;
          observations.push({
            ...key,
            value,
            at: Date.now(),
            completeness:
              method === 'fetchOnlineMembers' || spec.complete
                ? 'complete'
                : spec.page
                  ? 'page'
                  : 'partial',
          });
          if (spec.collection && Array.isArray(result)) {
            for (const entry of result) {
              const item = rowOf(entry);
              if (!item) continue;
              const group = scalar(item.groupCode ?? item.code);
              const uid = scalar(item.uid),
                uin = scalar(item.uin);
              if (uid && uin) links.push({ uid, uin });
              const target = group ? `group:${group}` : uid || uin ? `friend:${uid || uin}` : '';
              if (target)
                observations.push({
                  entity: target,
                  category: `${spec.service}.${method}`,
                  source: spec.source,
                  value: entry,
                  at: Date.now(),
                });
            }
          }
          if (method === 'nicksByUids' && row) {
            for (const [uid, nick] of Object.entries(row))
              if (/^u_[\w-]+$/.test(uid))
                observations.push({
                  entity: `friend:${uid}`,
                  category: 'nickname',
                  source: 'local',
                  value: { uid, nick },
                  at: Date.now(),
                });
          }
          if (spec.kind === 'group' && Array.isArray(result)) {
            for (const member of result) {
              const identity = rowOf(member);
              if (identity?.uid && identity.uin)
                links.push({ uid: scalar(identity.uid), uin: scalar(identity.uin) });
            }
          }
          await history.capture(observations, links);
        } catch (error) {
          history.lastError = error instanceof Error ? error.message : String(error);
          console.error('[contacts] 资料历史保存失败', error);
        }
        return result;
      };
      const proxy = new Proxy(original, {
        apply: (_target, receiver, args) => Reflect.apply(wrapped, receiver, args),
      });
      Reflect.set(service, method, proxy);
      restore.push(() => {
        if (Reflect.get(service, method) !== proxy) return;
        if (owned) Object.defineProperty(service, method, owned);
        else Reflect.deleteProperty(service, method);
      });
    }
  }
  // 精确查询第一个参数是对象类别而不是身份，单独处理。
  const writer = Reflect.get(services, 'accountWrite');
  if (writer && typeof writer.exactProfile === 'function') {
    const original = writer.exactProfile;
    writer.exactProfile = async (kind: 'user' | 'group', target: string) => {
      const result = await original.call(writer, kind, target);
      if (current())
        try {
          await history.capture([
            {
              entity: `${kind === 'user' ? 'friend' : 'group'}:${target}`,
              category: 'exactProfile',
              source: 'online',
              value: result,
              at: Date.now(),
            },
          ]);
        } catch (error) {
          history.lastError = String(error);
        }
      return result;
    };
    const wrapped = writer.exactProfile;
    restore.push(() => {
      if (writer.exactProfile === wrapped) writer.exactProfile = original;
    });
  }
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}
