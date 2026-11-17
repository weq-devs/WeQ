export { trpc } from './trpc.stub';

let revision = 0;
let values: Record<string, unknown> = {};
export const client = {
  clientState: {
    patch: {
      mutate: async (patch: Record<string, unknown>) => {
        values = { ...values, ...patch };
        return { revision: ++revision, values, records: {} };
      },
    },
  },
};
