import { z } from 'zod';
import { procedure, router } from '../trpc';
import { groupBulletinToWire, groupNoticeToBulletinWire } from '../serde';
import type { AccountServices } from '../../context/app_context';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
export function createSearchTargetsRouter(
  resolve: (input: z.infer<typeof binding>) => AccountServices,
) {
  return router({
    group: procedure
      .input(
        binding.extend({
          kind: z.enum(['groupBulletin', 'groupEssence']),
          groupCode: z.string().regex(/^[1-9]\d*$/),
          id: z.string().min(1),
        }),
      )
      .query(async ({ input }) => {
        const services = resolve(input);
        const check = () => {
          if (resolve(input) !== services) throw new Error('账号已切换');
        };
        const name =
          (await services.groupInfo.getGroupDetail(BigInt(input.groupCode)))?.groupName ||
          input.groupCode;
        check();
        if (input.kind === 'groupBulletin') {
          const seen = new Set<string>();
          for (let offset = 0; ; offset += 100) {
            check();
            const page = await services.groupInfo.getGroupBulletins(
              BigInt(input.groupCode),
              100,
              offset,
            );
            check();
            const found = page.find((row) => row.fid === input.id);
            if (found)
              return { kind: 'bulletin' as const, name, bulletin: groupBulletinToWire(found) };
            const keys = page.map((row) => row.fid);
            if (page.length < 100 || !keys.some((key) => !seen.has(key))) break;
            for (const key of keys) seen.add(key);
          }
          const notices = await services.webQuery.getGroupNotice(input.groupCode);
          check();
          const found = notices.find((row) => row.noticeId === input.id);
          if (found)
            return {
              kind: 'bulletin' as const,
              name,
              bulletin: groupNoticeToBulletinWire(found, input.groupCode),
            };
        } else {
          const seen = new Set<string>();
          for (let offset = 0; ; offset += 1) {
            check();
            const page = await services.groupInfo.getEssencePageWithContent(
              input.groupCode,
              offset,
              50,
            );
            check();
            const found = page.messages.find((row) => String(row.msgSeq) === input.id);
            if (found) return { kind: 'essence' as const, name, message: found };
            const keys = page.messages.map((row) => String(row.msgSeq));
            if (!keys.some((key) => !seen.has(key)) || page.complete) break;
            for (const key of keys) seen.add(key);
          }
        }
        throw new Error('未找到对应内容，可能已移除或当前无法读取；搜索结果仍保留');
      }),
  });
}
