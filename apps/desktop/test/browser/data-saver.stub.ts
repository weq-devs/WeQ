export { trpc } from './chat-image-cache.stub';
let revision = 0;
const saved: Record<string, unknown> = { dataSaverMode: 'always' };
export const client = {
  settings: {
    networkCost: {
      query: async () => ({
        state: 'unrestricted',
        constrained: false,
        metered: false,
        source: 'fixture',
      }),
    },
  },
  clientState: {
    patch: {
      mutate: async (values: object) => ({
        epoch: 'fixture',
        revision: ++revision,
        values: { ...Object.assign(saved, values) },
        records: {},
      }),
    },
  },
};
