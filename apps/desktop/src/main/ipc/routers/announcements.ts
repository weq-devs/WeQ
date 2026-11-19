import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { ANNOUNCEMENT_ID, MAX_ANNOUNCEMENTS } from '@weq/network/announcement-metadata';
import { getAnnouncements } from '../../announcements';
import { procedure, router } from '../trpc';

const id = z.string().regex(ANNOUNCEMENT_ID);

export const announcementsRouter = router({
  list: procedure.query(() => getAnnouncements().list()),
  detail: procedure.input(id).query(({ input }) => getAnnouncements().detail(input)),
  refresh: procedure.mutation(async () => {
    const announcements = getAnnouncements();
    await announcements.refresh();
    return announcements.list();
  }),
  markRead: procedure
    .input(z.array(id).max(MAX_ANNOUNCEMENTS))
    .mutation(({ input }) => getAnnouncements().markRead(input)),
  claimBanner: procedure.input(id).mutation(({ input }) => getAnnouncements().claimBanner(input)),
  finishBanner: procedure
    .input(z.object({ token: z.string().uuid(), shown: z.boolean() }))
    .mutation(({ input }) => getAnnouncements().finishBanner(input.token, input.shown)),
  changed: procedure.subscription(() =>
    observable<number>((emit) => getAnnouncements().subscribe((value) => emit.next(value))),
  ),
});
