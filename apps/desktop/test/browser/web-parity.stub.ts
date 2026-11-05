export const client = {
  account: {
    getAccountConfig: { query: async () => ({ uin: '10001', configId: 'fixture' }) },
    pickedFileStart: { mutate: async () => ({ id: 'fixture-upload' }) },
    pickedFileChunk: {
      mutate: async (input: { offset: number; base64: string }) => ({
        offset: input.offset + atob(input.base64).length,
      }),
    },
    pickedFileFinish: {
      mutate: async () => ({ path: '/fixture/fixture.txt', fileName: 'fixture.txt', size: 3 }),
    },
    pickedFileDiscard: { mutate: async () => {} },
  },
};
