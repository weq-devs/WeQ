import { createHash } from 'node:crypto';
import type { AgentLabModelRef } from './types';

/** 身份包含端点而不携带 URL/密钥原文；显示名和凭据轮换不改变索引空间。 */
export function modelEndpointIdentity(ref: AgentLabModelRef, baseUrl: string): string {
  return createHash('sha256')
    .update(JSON.stringify([ref.providerId, ref.model, baseUrl]))
    .digest('hex');
}
