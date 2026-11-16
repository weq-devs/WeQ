import { trpc as base, client, useQQWriteSession } from './profile-display.stub';
import { withFallback } from './self-profile.stub';

export { client, useQQWriteSession };
export const trpc = withFallback({
  ...base,
  account: {
    ...base.account,
    getOnlineStatus: {
      useQuery: (input: { uid: string }) => {
        const result = base.account.getOnlineStatus.useQuery();
        return { ...result, data: { ...result.data, uid: input.uid } };
      },
    },
  },
});
