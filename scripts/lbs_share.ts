/**
 * 位置共享联调脚本：借同机在线 QQ 的凭据，发起一次私聊 / 群聊位置共享，
 * 按服务端要求的心跳持续上报，并周期性查询房间成员。
 *
 * 协议实现本身在 `@weq/protocol` 的 `msg/lbs-share` 与 `@weq/service` 的
 * `LocationShareService` 里 —— 本脚本只负责「拿到凭据 + 驱动心跳」，
 * 不再自己拼 protobuf。
 *
 * 用法：
 *   pnpm tsx scripts/lbs_share.ts --peer 1707889225 [--seconds 120]
 *   pnpm tsx scripts/lbs_share.ts --group 673646675 [--seconds 120]
 *   pnpm tsx scripts/lbs_share.ts --peer 1707889225 --lng 116.397 --lat 39.908
 *   pnpm tsx scripts/lbs_share.ts --peer 1707889225 --no-card   # 只建房间不发卡片
 *
 * 权限：读别的进程内存 = ptrace attach。Windows 要管理员，Linux 要 root 或
 * `CAP_SYS_PTRACE`，macOS 要 root 且关 SIP。
 */

import { loadNative } from '../packages/native/src';
import type { Platform } from '../packages/platform/src';
import {
  createDarwinPlatform,
  createLinuxPlatform,
  createWin32Platform,
} from '../packages/platform/src';
import {
  registerSsoSession,
  resolveDeviceGuid,
  resolveSubAppId,
} from '../packages/service/src/account/sso_session';
import { readLoginAccounts } from '../packages/service/src/bootstrap/login_db';
import { ensureAttached } from '../packages/testkit/src/attach';
import { LocationShareService } from '../packages/service/src/account/lbs_share';
import { LbsRoomStatus } from '../packages/protocol/src/msg/lbs-share';
import { sendMessage } from '../packages/protocol/src/msg/send';

const LABEL = 'lbs-share';

function log(message: string): void {
  console.log(`[${LABEL}] ${new Date().toISOString().slice(11, 23)} ${message}`);
}

function fail(message: string): never {
  console.error(`[${LABEL}] 失败: ${message}`);
  process.exit(1);
}

// ─────────────────────────── 命令行 ───────────────────────────

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const opt = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const peerText = opt('--peer');
const groupText = opt('--group');
if (!peerText && !groupText) fail('缺少 --peer <对端 QQ 号> 或 --group <群号>');
if (peerText && groupText) fail('--peer 与 --group 只能给一个');

const scene = groupText !== undefined ? ('group' as const) : ('c2c' as const);
/** 会话号：私聊是 peerUin，群聊是 groupCode。 */
const peer = Number(peerText ?? groupText);
if (!Number.isSafeInteger(peer) || peer <= 0) fail(`会话号不合法：${peerText ?? groupText}`);

const lng = Number(opt('--lng') ?? '103.931543');
const lat = Number(opt('--lat') ?? '30.75535');
const totalSeconds = Number(opt('--seconds') ?? '120');
const heartbeatMs = Number(opt('--interval') ?? '2000');
const queryEvery = Number(opt('--query-every') ?? '5');

// ─────────────────────────── 平台 / 账号 ───────────────────────────

function createPlatform(
  native: ReturnType<typeof loadNative>,
  getUidForUin: (uin: string) => string | null,
): Platform {
  if (process.platform === 'linux') return createLinuxPlatform(native, () => null, getUidForUin);
  if (process.platform === 'darwin') return createDarwinPlatform(native, () => null, getUidForUin);
  return createWin32Platform(
    native,
    () => null,
    () => null,
  );
}

async function main(): Promise<void> {
  const native = loadNative();
  const nt = native.ntHelper;
  const uidByUin = new Map<string, string>();
  const platform = createPlatform(native, (uin) => uidByUin.get(uin) ?? null);

  const accounts = await readLoginAccounts(platform);
  for (const account of accounts) uidByUin.set(account.uin, account.uid);

  let target: { uin: string; uid: string; pid: number } | null = null;
  for (const account of accounts) {
    const pid = platform.resolveQqPid(account.uin);
    if (pid === null) continue;
    target = { uin: account.uin, uid: account.uid, pid };
    break;
  }
  if (!target) fail('没有在线账号，先把 QQ 打开并登录');
  if (!target.uid) fail(`账号 ${target.uin} 的 uid 为空`);

  const selfUin = Number(target.uin);
  const pid = target.pid;
  log(`目标账号 uin=${selfUin} uid=${target.uid} pid=${pid}`);
  log(
    `${scene === 'group' ? '群聊 groupCode' : '私聊 peerUin'}=${peer}  坐标 lng=${lng} lat=${lat}`,
  );

  // ① 借凭据登记 SSO 会话（只登记，不建连）。
  const material = await ensureAttached(nt, pid, target.uin, { label: LABEL });
  const guid = resolveDeviceGuid(nt, platform);
  if (!guid) fail('读不到设备 guid');
  const subAppId = resolveSubAppId(nt, platform, pid);
  const registered = await registerSsoSession(
    nt,
    platform,
    pid,
    { uin: target.uin, uid: target.uid, guid, subAppId },
    material,
  );
  if (!registered) fail('会话物料不齐，没登记上 SSO 会话');
  log('SSO 会话已登记');

  const service = new LocationShareService(nt, () => pid);

  // ② 发起。
  const started = await service.start({ scene, peer, selfUin, longitude: lng, latitude: lat });
  log(`room_operation ok=${started.ok} code=${started.code} ${started.message}`);
  if (!started.ok) fail('服务端拒绝发起位置共享');

  // ③ 自己发「发起了位置共享」卡片。
  //
  // 真实客户端这一步由服务端 MsgPush 完成，但 WeQ 的 SSO 是「发一包就断」，
  // 服务端判定发起方不在线就不投递 —— 所以自己 SendMsg。
  if (!has('--no-card')) {
    const elements = service.buildShareCardElements(scene);
    const peerUid = uidByUin.get(String(peer));
    try {
      const receipt = await sendMessage(nt, pid, {
        ...(scene === 'group' ? { groupId: peer } : { userUin: peer }),
        ...(scene === 'c2c' && peerUid ? { userUid: peerUid } : {}),
        elements,
        ...(scene === 'c2c' ? { msgFlag: Math.floor(Date.now() / 1000) } : {}),
      });
      log(`卡片消息 ok=${receipt.ok} result=${receipt.result} ${receipt.errMsg || ''}`);
    } catch (error) {
      log(`卡片消息失败: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ④ 心跳：上报自己 + 定期查询成员。停上报约 60 秒后服务端会把房间置为已结束，
  //    所以「退出共享」不需要额外命令。
  const deadline = Date.now() + totalSeconds * 1000;
  let round = 0;
  let lastQuery = 0;
  while (Date.now() < deadline) {
    round++;
    // extra 语义未确认（抓包里每次不同、服务端原样回显），给个稳定值即可。
    const extra = 208 + (round % 7) * 0.1;
    try {
      const reply = await service.report({
        scene,
        peer,
        selfUin,
        longitude: lng,
        latitude: lat,
        extra,
      });
      log(`#${round} report ok=${reply.ok} 下次间隔=${reply.interval}s`);
    } catch (error) {
      log(`#${round} report 失败: ${error instanceof Error ? error.message : error}`);
    }

    if (Date.now() - lastQuery >= queryEvery * heartbeatMs) {
      lastQuery = Date.now();
      try {
        const room = await service.query({ scene, peer, selfUin, mode: 1 });
        const members = room.members
          .map((m) => `${m.uin}@${m.longitude.toFixed(6)},${m.latitude.toFixed(6)}`)
          .join(' ');
        log(
          `#${round} query status=${room.status === LbsRoomStatus.ACTIVE ? '进行中' : room.status} ` +
            `成员(${room.members.length}): ${members || '<空>'}`,
        );
      } catch (error) {
        log(`#${round} query 失败: ${error instanceof Error ? error.message : error}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
  }
  log(`跑满 ${totalSeconds} 秒，结束（停止上报，房间会自行超时关闭）`);
}

main().catch((error: unknown) => {
  console.error(`[${LABEL}] 失败:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
