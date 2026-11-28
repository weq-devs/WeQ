import { z } from 'zod/v3';
import type { ForwardCacheKind } from '@weq/db';

export const forwardCacheKindInput = z.enum([
  'c2c',
  'group',
  'aiAssistant',
] as const satisfies readonly ForwardCacheKind[]);
