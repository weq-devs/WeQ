import type {
  MailAction,
  MailAttachment,
  MailComposeInput,
  MailDetail,
  MailEvent,
  MailFolder,
  MailListInput,
  MailPage,
  MailStatus,
} from '@weq/service/mail';
import { client } from '../../trpc/client';
import { IS_WEB } from '../../lib/target.shared';
import { pickAccountFile } from '../../lib/accountFilePicker';
import {
  getRemoteCacheRecord,
  putRemoteCacheRecord,
  remoteDataCacheAccount,
  remoteDataCacheOffline,
  remoteDataCacheStatus,
} from '../../lib/remoteDataCache';
import type { ExportSavePolicy } from '@weq/service';

export type MailSubmission =
  | { state: 'accepted'; id: string; messageId: string }
  | { state: 'rejected' | 'unknown'; message: string };
export interface MailApi {
  status(): Promise<MailStatus>;
  connect(signal?: AbortSignal): Promise<MailStatus>;
  disconnect(): Promise<void>;
  folders(signal?: AbortSignal): Promise<MailFolder[]>;
  list(input: MailListInput, signal?: AbortSignal): Promise<MailPage>;
  read(id: string, signal?: AbortSignal): Promise<MailDetail & { fromRemoteCache?: true }>;
  previewUnread(): Promise<{ ids: string[]; configId: string }>;
  markAllRead(ids: string[], expectedAccountConfigId: string): Promise<void>;
  action(ids: string[], action: MailAction): Promise<void>;
  send(message: MailComposeInput, draft: boolean): Promise<MailSubmission>;
  notifications(enabled: boolean): Promise<MailStatus>;
  upload(signal?: AbortSignal): Promise<MailAttachment | null>;
  download(id: string, signal?: AbortSignal): Promise<boolean>;
  save(id: string, savePolicy: ExportSavePolicy, expectedAccountConfigId: string): Promise<string>;
  exportMessages(
    ids: string[],
    savePolicy: ExportSavePolicy,
    expectedAccountConfigId: string,
  ): Promise<string>;
  image(id: string, signal?: AbortSignal): Promise<{ mime: string; base64: string }>;
  subscribe(listener: (event: MailEvent) => void): () => void;
  openLink(url: string): Promise<void>;
  dispose(): void;
}

export function createMailApi(selfUin: string): MailApi {
  const pending = new Set<string>();
  async function request<T>(
    run: (requestId: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    pending.add(requestId);
    const cancel = (): void => {
      void client.mail.cancel.mutate({ selfUin, requestId }).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await run(requestId);
    } finally {
      pending.delete(requestId);
      signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    status: () => client.mail.status.query({ selfUin }),
    connect: (signal) =>
      request((requestId) => client.mail.connect.mutate({ selfUin, requestId }), signal),
    disconnect: async () => {
      await client.mail.disconnect.mutate({ selfUin });
    },
    folders: (signal) =>
      request((requestId) => client.mail.folders.query({ selfUin, requestId }), signal),
    list: (input, signal) =>
      request(
        (requestId) =>
          client.mail.list.query({
            selfUin,
            requestId,
            folderId: input.folderId,
            page: input.page,
            unreadOnly: input.unreadOnly ?? false,
            keyword: input.keyword,
          }),
        signal,
      ),
    async read(id, signal) {
      const account = remoteDataCacheAccount();
      const status = account ? await remoteDataCacheStatus() : undefined;
      const key = JSON.stringify(['mail-detail', account, selfUin, id]);
      const local = async () => {
        const value = await getRemoteCacheRecord<MailDetail>(key);
        signal?.throwIfAborted();
        return value && remoteDataCacheAccount() === account
          ? { ...value, fromRemoteCache: true as const }
          : undefined;
      };
      if (status && remoteDataCacheOffline()) {
        const value = await local();
        if (value) return value;
        if (navigator.onLine === false) throw new Error('这封邮件尚未缓存，请连接电脑后打开。');
      }
      try {
        const value = await request(
          (requestId) => client.mail.read.mutate({ selfUin, requestId, id }),
          signal,
        );
        if (status && !signal?.aborted && remoteDataCacheAccount() === account)
          void putRemoteCacheRecord(key, value, status);
        return value;
      } catch (error) {
        if (status && remoteDataCacheOffline() && !signal?.aborted) {
          const value = await local();
          if (value) return value;
        }
        throw error;
      }
    },
    previewUnread: () =>
      request((requestId) => client.mail.previewUnread.query({ selfUin, requestId })),
    markAllRead: (ids, expectedAccountConfigId) =>
      request((requestId) =>
        client.mail.markAllRead.mutate({ selfUin, requestId, ids, expectedAccountConfigId }),
      ),
    action: (ids, action) =>
      request((requestId) => client.mail.action.mutate({ selfUin, requestId, ids, action })),
    send: (message, draft) =>
      request((requestId) => client.mail.send.mutate({ selfUin, requestId, message, draft })),
    notifications: (enabled) =>
      request((requestId) => client.mail.notifications.mutate({ selfUin, requestId, enabled })),
    upload: async (signal) => {
      const picked = IS_WEB ? await pickAccountFile('file', undefined, signal) : undefined;
      if (IS_WEB && !picked) return null;
      signal?.throwIfAborted();
      return request(
        (requestId) => client.mail.upload.mutate({ selfUin, requestId, path: picked?.path }),
        signal,
      );
    },
    download: async (id, signal) => {
      const result = await request(
        (requestId) => client.mail.download.mutate({ selfUin, requestId, id }),
        signal,
      );
      if (result?.downloadId) {
        const link = document.createElement('a');
        link.href = `/_download/${encodeURIComponent(result.downloadId)}`;
        link.download = '';
        link.click();
      }
      return result !== null;
    },
    image: (id, signal) =>
      request((requestId) => client.mail.image.query({ selfUin, requestId, id }), signal),
    save: (id, savePolicy, expectedAccountConfigId) =>
      client.mail.saveAttachment.mutate({ selfUin, id, savePolicy, expectedAccountConfigId }),
    exportMessages: (ids, savePolicy, expectedAccountConfigId) =>
      client.mail.exportMessages.mutate({ selfUin, ids, savePolicy, expectedAccountConfigId }),
    subscribe: (listener) => {
      const subscription = client.mail.events.subscribe({ selfUin }, { onData: listener });
      return () => subscription.unsubscribe();
    },
    openLink: async (url) => {
      if (IS_WEB) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      const result = await client.help.openExternal.mutate({ url });
      if (!result.ok) throw new Error(result.error || '无法打开链接。');
    },
    dispose: () => {
      for (const requestId of pending)
        void client.mail.cancel.mutate({ selfUin, requestId }).catch(() => {});
      pending.clear();
    },
  };
}
