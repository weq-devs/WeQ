import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v3';
import type { RemoteObservation } from './device';
import type { RemoteDeviceInfo, RemoteConnectionInfo } from '../../shared/remote_device';
import type {
  RemoteAccountAccessRequest,
  RemoteAccountAccessResult,
  RemoteAccountSummary,
} from '../../shared/remote_account_switch';

export const INVITATION_TTL = 120_000;
export const CLAIM_TTL = 120_000;
export const claimSchema = z
  .object({
    invitation: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    name: z.string().trim().min(1).max(64),
    tokenHash: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    scope: z.enum(['status:read', 'web:access']).default('status:read'),
  })
  .strict();

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function equalHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export interface Claim {
  id: string;
  name: string;
  tokenHash: string;
  code: string;
  expiresAt: number;
  approvedAt: number | null;
  lastSeenAt: number | null;
  scope: 'status:read' | 'web:access';
  accountConfigIds?: string[];
  deviceInfo?: RemoteDeviceInfo;
  lastConnection?: RemoteConnectionInfo;
}

/** 只保存批准后的凭据哈希；邀请和未批准请求不会写入磁盘。 */
export class RemotePairing {
  private invitation: { secret: string; expiresAt: number } | null = null;
  private claims = new Map<string, Claim>();
  private accountRequests = new Map<
    string,
    RemoteAccountAccessRequest & { expiresAt: number; state: 'pending' | 'approved' | 'denied' }
  >();
  private watchers = new Map<string, Set<() => void>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private activityDirty = false;

  constructor(private readonly now: () => number = Date.now) {}
  onRequest: (() => void) | undefined;

  private save: (claims: (Claim & { approvedAt: number })[]) => void = () => {};

  restore(claims: Claim[], save: (claims: (Claim & { approvedAt: number })[]) => void): void {
    this.claims = new Map(claims.map((claim) => [claim.id, claim]));
    this.accountRequests.clear();
    this.save = save;
  }

  private persist(): void {
    this.save(
      [...this.claims.values()].filter(
        (claim): claim is Claim & { approvedAt: number } => claim.approvedAt !== null,
      ),
    );
    this.activityDirty = false;
  }

  private touch(claim: Claim, observation?: RemoteObservation): void {
    claim.lastSeenAt = this.now();
    if (observation?.deviceInfo) claim.deviceInfo = observation.deviceInfo;
    if (observation?.lastConnection) claim.lastConnection = observation.lastConnection;
    this.activityDirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flushActivity();
      }, 30_000);
      this.saveTimer.unref();
    }
  }

  private flushActivity(): void {
    if (!this.activityDirty) return;
    try {
      this.persist();
    } catch {
      /* 活跃记录写入失败不阻断连接，下次访问重试。 */
    }
  }

  private prune(): void {
    for (const [id, claim] of this.claims) {
      if (claim.approvedAt === null && claim.expiresAt <= this.now()) this.claims.delete(id);
    }
    for (const [id, request] of this.accountRequests) {
      if (request.expiresAt <= this.now()) this.accountRequests.delete(id);
    }
    if (this.invitation && this.invitation.expiresAt <= this.now()) this.invitation = null;
  }

  invite() {
    this.prune();
    if (this.claims.size >= 16) throw new Error('最多配对 16 台设备，请先撤销旧设备。');
    // 刷新二维码同时取消尚未确认的请求，避免批准旧邀请。
    for (const [id, claim] of this.claims) if (claim.approvedAt === null) this.claims.delete(id);
    this.invitation = {
      secret: randomBytes(32).toString('hex'),
      expiresAt: this.now() + INVITATION_TTL,
    };
    return { ...this.invitation };
  }

  claim(input: z.input<typeof claimSchema>, observation?: RemoteObservation) {
    const parsed = claimSchema.parse(input);
    this.prune();
    if (
      !this.invitation ||
      !equalHash(tokenHash(parsed.invitation), tokenHash(this.invitation.secret))
    ) {
      throw new Error('邀请已失效或已使用。');
    }
    if ([...this.claims.values()].some((claim) => claim.tokenHash === parsed.tokenHash)) {
      throw new Error('请生成新的设备凭据。');
    }
    this.invitation = null;
    const id = randomUUID();
    const code = (
      Number.parseInt(tokenHash(`${id}:${parsed.tokenHash}`).slice(0, 8), 16) % 1_000_000
    )
      .toString()
      .padStart(6, '0');
    const claim: Claim = {
      id,
      name: parsed.name,
      tokenHash: parsed.tokenHash,
      code,
      expiresAt: this.now() + CLAIM_TTL,
      approvedAt: null,
      lastSeenAt: null,
      scope: parsed.scope,
      ...(observation?.deviceInfo ? { deviceInfo: observation.deviceInfo } : {}),
    };
    this.claims.set(id, claim);
    this.onRequest?.();
    return { id, code, expiresAt: claim.expiresAt };
  }

  decide(id: string, approve: boolean, accountConfigIds?: readonly string[]): void {
    this.prune();
    const claim = this.claims.get(id);
    if (!claim || claim.approvedAt !== null) throw new Error('配对请求已失效。');
    if (approve) {
      if (claim.scope === 'web:access' && accountConfigIds) {
        if (!accountConfigIds.length) throw new Error('请至少选择一个要授权的账号。');
        claim.accountConfigIds = [...new Set(accountConfigIds)];
      }
      claim.approvedAt = this.now();
      try {
        this.persist();
      } catch (error) {
        claim.approvedAt = null;
        delete claim.accountConfigIds;
        throw error;
      }
    } else this.revoke(id);
  }

  revoke(id: string): void {
    const previous = this.claims.get(id);
    this.claims.delete(id);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.claims.set(id, previous);
      throw error;
    }
    this.accountRequests.delete(id);
    this.invalidateWeb(id);
  }

  private invalidateWeb(id: string): void {
    for (const notify of this.watchers.get(id) ?? []) notify();
    this.watchers.delete(id);
  }

  setAccountConfigIds(id: string, ids: string[]): void {
    const claim = this.claims.get(id);
    if (!claim || claim.approvedAt === null || claim.scope !== 'web:access')
      throw new Error('此设备没有有效的 WeQ 网页授权。');
    this.saveAccountConfigIds(claim, ids);
    const request = this.accountRequests.get(id);
    if (request?.state === 'pending' && ids.includes(request.account.configId)) {
      request.state = 'approved';
      request.expiresAt = this.now() + CLAIM_TTL;
    }
    this.invalidateWeb(id);
  }

  private saveAccountConfigIds(claim: Claim, ids: string[]): void {
    const previous = claim.accountConfigIds;
    claim.accountConfigIds = [...new Set(ids)];
    try {
      this.persist();
    } catch (error) {
      claim.accountConfigIds = previous;
      throw error;
    }
  }

  private webClaim(token: string): Claim | undefined {
    const hash = tokenHash(token);
    return [...this.claims.values()].find(
      (item) =>
        item.approvedAt !== null && item.scope === 'web:access' && equalHash(item.tokenHash, hash),
    );
  }

  accountConfigIds(token: string): readonly string[] {
    return this.webClaim(token)?.accountConfigIds ?? [];
  }

  requestAccountAccess(token: string, account: RemoteAccountSummary): RemoteAccountAccessResult {
    this.prune();
    const claim = this.webClaim(token);
    if (!claim) throw new Error('此设备没有有效的 WeQ 网页授权。');
    if (claim.accountConfigIds?.includes(account.configId)) return { state: 'approved' };
    const pending = this.accountRequests.get(claim.id);
    if (pending?.state === 'pending') {
      if (pending.account.configId === account.configId)
        return { state: 'pending', id: pending.id };
      throw new Error('此设备已有账号申请，电脑处理后可再次申请。');
    }
    const { id: deviceId, name, lastSeenAt, deviceInfo, lastConnection } = claim;
    const id = randomUUID();
    this.accountRequests.set(deviceId, {
      id,
      account,
      device: { id: deviceId, name, lastSeenAt, deviceInfo, lastConnection },
      state: 'pending',
      expiresAt: this.now() + CLAIM_TTL,
    });
    this.onRequest?.();
    return { state: 'pending', id };
  }

  pollAccountAccess(token: string, id: string): RemoteAccountAccessResult {
    this.prune();
    const claim = this.webClaim(token);
    if (!claim) return { state: 'expired' };
    const request = this.accountRequests.get(claim.id);
    if (!request || request.id !== id) return { state: 'expired' };
    if (claim.accountConfigIds?.includes(request.account.configId)) return { state: 'approved' };
    if (request.state === 'pending') return { state: 'pending', id };
    return { state: request.state === 'denied' ? 'denied' : 'expired' };
  }

  decideAccountAccess(
    id: string,
    approve: boolean,
    isCurrent: (account: RemoteAccountSummary) => boolean,
  ): void {
    this.prune();
    const request = [...this.accountRequests.values()].find((item) => item.id === id);
    const claim = request && this.claims.get(request.device.id);
    if (request?.state !== 'pending' || claim?.approvedAt == null || claim.scope !== 'web:access')
      throw new Error('账号访问申请已失效。');
    if (approve) {
      if (!isCurrent(request.account)) throw new Error('账号数据源已经变化。');
      const current = claim.accountConfigIds ?? [];
      if (!current.includes(request.account.configId)) {
        // 只增加权限，已打开的账号路由无需断开。
        this.saveAccountConfigIds(claim, [...current, request.account.configId]);
      }
    }
    request.state = approve ? 'approved' : 'denied';
    request.expiresAt = this.now() + CLAIM_TTL;
  }

  poll(id: string, token: string) {
    this.prune();
    const claim = this.claims.get(id);
    if (!claim || !equalHash(claim.tokenHash, tokenHash(token))) return null;
    return {
      id,
      name: claim.name,
      approved: claim.approvedAt !== null,
      scope: claim.scope,
    };
  }

  authenticate(token: string, observation?: RemoteObservation): boolean {
    const hash = tokenHash(token);
    for (const claim of this.claims.values()) {
      if (claim.approvedAt !== null && equalHash(claim.tokenHash, hash)) {
        this.touch(claim, observation);
        return true;
      }
    }
    return false;
  }

  canAccessWeb(token: string, observation?: RemoteObservation): boolean {
    const claim = this.webClaim(token);
    if (claim && observation) this.touch(claim, observation);
    return !!claim;
  }

  watchWeb(token: string, onRevoke: () => void): () => void {
    const claim = this.webClaim(token);
    if (!claim) {
      onRevoke();
      return () => {};
    }
    const listeners = this.watchers.get(claim.id) ?? new Set<() => void>();
    listeners.add(onRevoke);
    this.watchers.set(claim.id, listeners);
    return () => {
      listeners.delete(onRevoke);
      if (!listeners.size) this.watchers.delete(claim.id);
    };
  }

  snapshot() {
    this.prune();
    return {
      invitationExpiresAt: this.invitation?.expiresAt ?? null,
      pending: [...this.claims.values()]
        .filter((c) => c.approvedAt === null)
        .map(({ id, name, code, expiresAt, scope }) => ({ id, name, code, expiresAt, scope })),
      accountRequests: [...this.accountRequests.values()]
        .filter((request) => request.state === 'pending')
        .map(({ id, account, device }) => ({ id, account, device })),
      devices: [...this.claims.values()]
        .filter((c) => c.approvedAt !== null)
        .map(
          ({
            id,
            name,
            approvedAt,
            lastSeenAt,
            scope,
            accountConfigIds,
            deviceInfo,
            lastConnection,
          }) => ({
            id,
            name,
            approvedAt,
            lastSeenAt,
            scope,
            accountConfigIds,
            deviceInfo,
            lastConnection,
          }),
        ),
    };
  }

  cancelInvitation(): void {
    this.invitation = null;
    for (const [id, claim] of this.claims) if (claim.approvedAt === null) this.claims.delete(id);
  }

  clear(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.flushActivity();
    this.cancelInvitation();
    this.accountRequests.clear();
    for (const listeners of this.watchers.values()) for (const notify of listeners) notify();
    this.watchers.clear();
  }
}
