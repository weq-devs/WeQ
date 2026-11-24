import type { WeqRestoreChoice, WeqDefaultsChoice } from '@weq/service';
import { client } from '../../trpc/client';
import '../../styles/backup.css';
export const backupApi = {
  inventory: () => client.bootstrap.backupInventory.query(),
  export: (input: Parameters<typeof client.bootstrap.backupExport.mutate>[0]) =>
    client.bootstrap.backupExport.mutate(input),
  pick: () => client.bootstrap.backupPick.mutate(),
  begin: (name: string, bytes: number) =>
    client.bootstrap.backupBeginUpload.mutate({ name, bytes }),
  chunk: (id: string, offset: number, data: string) =>
    client.bootstrap.backupUploadChunk.mutate({ id, offset, data }),
  finish: (id: string) => client.bootstrap.backupFinishUpload.mutate({ id }),
  prepare: (sourceId: string, choice: WeqRestoreChoice) =>
    client.bootstrap.backupPrepare.mutate({ sourceId, ...choice }),
  stage: (previewId: string) => client.bootstrap.backupStage.mutate({ previewId }),
  defaultsInfo: () => client.bootstrap.backupDefaultsInfo.query(),
  defaults: (clientId: string, choice: WeqDefaultsChoice = {}) =>
    client.bootstrap.backupDefaults.mutate({ clientId, ...choice }),
  dispose: (id: string) => client.bootstrap.backupDiscardPreview.mutate({ id }),
  cancel: () => client.bootstrap.backupCancel.mutate(),
  apply: () => client.bootstrap.backupApply.mutate(),
  reveal: (id: string) => client.bootstrap.backupRevealExport.mutate({ id }),
  claim: (id: string, clientId: string) =>
    client.bootstrap.backupClaimClient.mutate({ id, clientId }),
  skip: (id: string) => client.bootstrap.backupSkipClient.mutate({ id }),
};
