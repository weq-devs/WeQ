import { create } from 'zustand';

export const useRemoteEntryFixture = create(() => ({
  web: false,
  remote: false,
  autoStart: false,
}));

function webStatus() {
  const state = useRemoteEntryFixture.getState();
  return {
    available: true,
    assetsInstalled: true,
    enabled: state.web,
    autoStart: state.autoStart,
    url: state.web ? 'http://127.0.0.1:7690' : null,
    error: null,
  };
}

function remoteStatus() {
  const state = useRemoteEntryFixture.getState();
  return {
    available: true,
    helperInstalled: true,
    enabled: state.remote,
    network: {
      state: state.remote ? 'online' : 'offline',
      addresses: state.remote ? ['https://192.168.1.8:7691'] : [],
    },
    pending: [],
    devices: [],
    invitationExpiresAt: null,
  };
}

function query(read: () => object) {
  return {
    useQuery() {
      useRemoteEntryFixture();
      return { data: read(), isLoading: false, refetch: async () => ({ data: read() }) };
    },
  };
}

const noop = { useMutation: () => ({ isLoading: false, mutateAsync: async () => {} }) };
function toggle(key: 'web' | 'remote' | 'autoStart') {
  return {
    useMutation: () => ({
      isLoading: false,
      mutateAsync: async ({ enabled }: { enabled: boolean }) =>
        useRemoteEntryFixture.setState({ [key]: enabled }),
    }),
  };
}

export const trpc = {
  remote: {
    status: query(remoteStatus),
    webStatus: query(webStatus),
    setEnabled: toggle('remote'),
    setWebEnabled: toggle('web'),
    setWebAutoStart: toggle('autoStart'),
    openLogin: noop,
    setTailscaleEnabled: noop,
    changeNetwork: noop,
    decide: noop,
    revoke: noop,
  },
};
export const client = { remote: { webToken: { mutate: async () => 'synthetic-token' } } };
