import { z } from 'zod';
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { accountRouter } from './account';
import {
  comparableMessages,
  compareMessageWindow,
  conditionalDirectories,
  contentVersion,
} from '../../../shared/content_version';

const version = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});

function requireBinding(input: z.infer<typeof binding>) {
  const context = getAppContext();
  if (
    String(context.account?.context.uin) !== input.expectedAccountUin ||
    context.services?.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId
  )
    throw new Error('账号数据源已切换');
  return context.services;
}

export const remoteCacheRouter = router({
  directory: procedure
    .input(
      binding.extend({
        name: z.enum(conditionalDirectories),
        knownVersion: version,
        limit: z.number().int().min(1).max(2000).optional(),
        cursor: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const services = requireBinding(input);
      const caller = accountRouter.createCaller(ctx);
      const page = input.limit === undefined ? undefined : { limit: input.limit };
      const data = await (input.name === 'listRecentContacts'
        ? caller.listRecentContacts({ ...input, limit: input.limit ?? 200 })
        : input.name === 'listTopContacts'
          ? caller.listTopContacts(input)
          : input.name === 'listAllGroups' ||
              input.name === 'listBuddies' ||
              input.name === 'listProfiles'
            ? caller[input.name](page)
            : caller[input.name]());
      if (requireBinding(input) !== services) throw new Error('账号数据源已切换');
      return contentVersion(data) === input.knownVersion
        ? { unchanged: true as const }
        : { unchanged: false as const, data };
    }),
  messages: procedure
    .input(
      binding.extend({
        kind: z.enum(['c2c', 'group']),
        conv: z.string().min(1),
        sinceSeq: z.string().regex(/^[1-9]\d{0,19}$/),
        limit: z.number().int().min(1).max(500),
        count: z.number().int().min(1).max(500),
        version,
        readWindow: z.object({ owner: z.string().uuid(), generation: z.number().int().positive() }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await accountRouter
        .createCaller(ctx)
        .listFrom({ ...input, deferReplyMedia: true });
      return compareMessageWindow(rows.reverse(), input, input.limit, comparableMessages);
    }),
});
