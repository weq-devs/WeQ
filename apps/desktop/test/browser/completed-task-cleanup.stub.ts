export { trpc } from './trpc.stub';

export const client = {
  account: {
    clearFinishedTasks: {
      mutate: async () => ({ removed: 3, skipped: 0, errors: [] }),
    },
  },
};
