import { trpc as base } from './contact-history.stub';
export const trpc = {
  ...base,
  bootstrap: { getSettings: { useQuery: () => ({ data: { exportSaveMode: 'before' } }) } },
};
export const client = {};
