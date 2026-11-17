export { trpc } from './chat-image-cache.stub';
import {
  DataSaverSession,
  networkCost,
  type DataSaverTemporaryRequest,
  type DataSaverStatus,
} from '@weq/service/data-saver';
let revision = 0;
const saved: Record<string, unknown> = { dataSaverMode: 'always', dataSaverOnMetered: false };
export const fixtureDataSaver = new DataSaverSession();
fixtureDataSaver.update('always', networkCost(false, false, 'fixture'));
fixtureDataSaver.setPendingTasks(2);
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
    dataSaver: {
      windowClosed: { mutate: async () => undefined },
      status: { query: async () => fixtureDataSaver.status() },
      temporary: {
        mutate: async ({ value }: { value: DataSaverTemporaryRequest }) => {
          fixtureDataSaver.setTemporary(value);
          return fixtureDataSaver.status();
        },
      },
      clearTemporary: {
        mutate: async () => {
          fixtureDataSaver.clearTemporary();
          return fixtureDataSaver.status();
        },
      },
      changed: {
        subscribe: (_input: unknown, handler: { onData: (value: DataSaverStatus) => void }) => {
          handler.onData(fixtureDataSaver.status());
          const stop = fixtureDataSaver.subscribe(() => handler.onData(fixtureDataSaver.status()));
          return { unsubscribe: stop };
        },
      },
    },
  },
  clientState: {
    patch: {
      mutate: async (values: {
        dataSaverMode?: 'auto' | 'always' | 'never';
        dataSaverOnMetered?: boolean;
      }) => {
        Object.assign(saved, values);
        if (values.dataSaverMode !== undefined || values.dataSaverOnMetered !== undefined) {
          fixtureDataSaver.update(
            values.dataSaverMode ?? fixtureDataSaver.status().mode,
            fixtureDataSaver.status().host,
            saved.dataSaverOnMetered === true,
          );
          fixtureDataSaver.clearTemporary('settings');
        }
        return {
          epoch: 'fixture',
          revision: ++revision,
          values: { ...Object.assign(saved, values) },
          records: {},
        };
      },
    },
  },
};
