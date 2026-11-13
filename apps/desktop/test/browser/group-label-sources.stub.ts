import avatarUrl from '@resources/brand/logo.png';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
export const useQQWriteSession = () => ({ binding, available: true });
export const client = {
  account: {
    getGroupLabelSetter: {
      query: async (input: { uid: string }) => {
        Object.assign(window, {
          setterReads: ((window as unknown as { setterReads?: number }).setterReads ?? 0) + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          uid: input.uid,
          uin: '10002',
          nick: '在线补全昵称',
          avatarUrl,
          remark: '',
          card: '',
          error: null,
        };
      },
    },
  },
};
