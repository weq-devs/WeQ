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
  })
  .strict();

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function equalHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

interface Claim {
  id: string;
  name: string;
  tokenHash: string;
  code: string;
  expiresAt: number;
  approvedAt: number | null;
  lastSeenAt: number | null;
}

/** 原型授权只在内存保存；不接入 QQ，不向网络端提供管理操作。 */
export class RemotePairing {
  private invitation: { secret: string; expiresAt: number } | null = null;
  private claims = new Map<string, Claim>();

  constructor(private readonly now: () => number = Date.now) {}

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

  claim(input: z.infer<typeof claimSchema>) {
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
    };
    this.claims.set(id, claim);
    return { id, code, expiresAt: claim.expiresAt };
  }

  decide(id: string, approve: boolean): void {
    this.prune();
    const claim = this.claims.get(id);
    if (!claim || claim.approvedAt !== null) throw new Error('配对请求已失效。');
    if (approve) claim.approvedAt = this.now();
    else this.claims.delete(id);
  }

  revoke(id: string): void {
    this.claims.delete(id);
  }

  poll(id: string, token: string) {
    this.prune();
    const claim = this.claims.get(id);
    if (!claim || !equalHash(claim.tokenHash, tokenHash(token))) return null;
    return {
      id,
      name: claim.name,
      approved: claim.approvedAt !== null,
      scope: 'status:read' as const,
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

  snapshot() {
    this.prune();
    return {
      invitationExpiresAt: this.invitation?.expiresAt ?? null,
      pending: [...this.claims.values()]
        .filter((c) => c.approvedAt === null)
        .map(({ id, name, code, expiresAt }) => ({ id, name, code, expiresAt })),
      devices: [...this.claims.values()]
        .filter((c) => c.approvedAt !== null)
        .map(({ id, name, approvedAt, lastSeenAt }) => ({ id, name, approvedAt, lastSeenAt })),
    };
  }

  clear(): void {
    this.invitation = null;
    this.claims.clear();
  }
}
