import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

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
}

/** 只保存批准后的凭据哈希；邀请和未批准请求不会写入磁盘。 */
export class RemotePairing {
  private invitation: { secret: string; expiresAt: number } | null = null;
  private claims = new Map<string, Claim>();
  private watchers = new Map<string, Set<() => void>>();

  constructor(private readonly now: () => number = Date.now) {}
  onRequest: (() => void) | undefined;

  private save: (claims: (Claim & { approvedAt: number })[]) => void = () => {};

  restore(claims: Claim[], save: (claims: (Claim & { approvedAt: number })[]) => void): void {
    this.claims = new Map(claims.map((claim) => [claim.id, claim]));
    this.save = save;
  }

  private persist(): void {
    this.save(
      [...this.claims.values()].filter(
        (claim): claim is Claim & { approvedAt: number } => claim.approvedAt !== null,
      ),
    );
  }

  private prune(): void {
    for (const [id, claim] of this.claims) {
      if (claim.approvedAt === null && claim.expiresAt <= this.now()) this.claims.delete(id);
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

  claim(input: z.input<typeof claimSchema>) {
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
    };
    this.claims.set(id, claim);
    this.onRequest?.();
    return { id, code, expiresAt: claim.expiresAt };
  }

  decide(id: string, approve: boolean): void {
    this.prune();
    const claim = this.claims.get(id);
    if (!claim || claim.approvedAt !== null) throw new Error('配对请求已失效。');
    if (approve) {
      claim.approvedAt = this.now();
      try {
        this.persist();
      } catch (error) {
        claim.approvedAt = null;
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
    for (const notify of this.watchers.get(id) ?? []) notify();
    this.watchers.delete(id);
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

  authenticate(token: string): boolean {
    const hash = tokenHash(token);
    for (const claim of this.claims.values()) {
      if (claim.approvedAt !== null && equalHash(claim.tokenHash, hash)) {
        claim.lastSeenAt = this.now();
        return true;
      }
    }
    return false;
  }

  canAccessWeb(token: string): boolean {
    const hash = tokenHash(token);
    return [...this.claims.values()].some(
      (claim) =>
        claim.approvedAt !== null &&
        claim.scope === 'web:access' &&
        equalHash(claim.tokenHash, hash),
    );
  }

  watchWeb(token: string, onRevoke: () => void): () => void {
    const hash = tokenHash(token);
    const claim = [...this.claims.values()].find(
      (item) =>
        item.approvedAt !== null && item.scope === 'web:access' && equalHash(item.tokenHash, hash),
    );
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
      devices: [...this.claims.values()]
        .filter((c) => c.approvedAt !== null)
        .map(({ id, name, approvedAt, lastSeenAt, scope }) => ({
          id,
          name,
          approvedAt,
          lastSeenAt,
          scope,
        })),
    };
  }

  cancelInvitation(): void {
    this.invitation = null;
    for (const [id, claim] of this.claims) if (claim.approvedAt === null) this.claims.delete(id);
  }

  clear(): void {
    this.cancelInvitation();
    for (const listeners of this.watchers.values()) for (const notify of listeners) notify();
    this.watchers.clear();
  }
}
