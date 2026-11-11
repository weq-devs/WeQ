import { z } from 'zod';
import type { ProfileExtrasService } from '@weq/service';
import { procedure, router } from '../trpc';

const target = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
  uin: z.string().regex(/^[1-9]\d{0,19}$/),
});
type Binding = z.infer<typeof target>;
const cursor = z.string().min(1).max(32768).optional();
export function createProfileExtrasRouter(
  resolve: (input: Binding) => { profileExtras: ProfileExtrasService },
) {
  async function read<T extends { targetUin: string }>(
    input: Binding,
    run: (service: ProfileExtrasService) => Promise<T>,
  ) {
    const services = resolve(input);
    const result = await run(services.profileExtras);
    if (resolve(input) !== services || result.targetUin !== input.uin)
      throw new Error('资料读取目标已变化，请重新打开');
    return result;
  }
  return router({
    details: procedure.input(target).query(({ input }) => read(input, (s) => s.details(input.uin))),
    avatarHistory: procedure
      .input(
        target
          .omit({ uin: true })
          .strict()
          .extend({ cursor: z.number().int().min(1).max(0xffffffff).optional() }),
      )
      .query(({ input }) =>
        read({ ...input, uin: input.expectedAccountUin }, (s) => s.avatarHistory(input.cursor)),
      ),
    educationHistory: procedure
      .input(target)
      .query(({ input }) => read(input, (s) => s.educationHistory(input.uin))),
    energy: procedure.input(target).query(({ input }) => read(input, (s) => s.energy(input.uin))),
    signatureHistory: procedure
      .input(target.extend({ cursor: z.number().int().min(0).max(0x7fffffff).optional() }))
      .query(({ input }) => read(input, (s) => s.signatureHistory(input.uin, input.cursor))),
    personalityLabels: procedure
      .input(target)
      .query(({ input }) => read(input, (s) => s.personalityLabels(input.uin))),
    personalityPhotos: procedure
      .input(target.extend({ labelId: z.string().regex(/^[1-9]\d{0,19}$/), cursor }))
      .query(({ input }) =>
        read(input, (s) => s.personalityPhotos(input.uin, input.labelId, input.cursor)),
      ),
    anonymousQuestions: procedure
      .input(target.extend({ filter: z.enum(['all', 'answered']), cursor }))
      .query(({ input }) =>
        read(input, (s) => s.anonymousQuestions(input.uin, input.filter, input.cursor)),
      ),
  });
}
