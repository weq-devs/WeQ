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
import { IS_WEB } from '../../lib/target';

export type MailSubmission =
  | { state: 'accepted'; id: string; messageId: string }
  | { state: 'rejected' | 'unknown'; message: string };
export interface MailApi {
  status(): Promise<MailStatus>;
  connect(signal?: AbortSignal): Promise<MailStatus>;
  disconnect(): Promise<void>;
  folders(signal?: AbortSignal): Promise<MailFolder[]>;
  list(input: MailListInput, signal?: AbortSignal): Promise<MailPage>;
  read(id: string, signal?: AbortSignal): Promise<MailDetail>;
  action(ids: string[], action: MailAction): Promise<void>;
  send(message: MailComposeInput, draft: boolean): Promise<MailSubmission>;
  notifications(enabled: boolean): Promise<MailStatus>;
  upload(signal?: AbortSignal): Promise<MailAttachment | null>;
  download(id: string, signal?: AbortSignal): Promise<boolean>;
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
    read: (id, signal) =>
      request((requestId) => client.mail.read.mutate({ selfUin, requestId, id }), signal),
    action: (ids, action) =>
      request((requestId) => client.mail.action.mutate({ selfUin, requestId, ids, action })),
    send: (message, draft) =>
      request((requestId) => client.mail.send.mutate({ selfUin, requestId, message, draft })),
    notifications: (enabled) =>
      request((requestId) => client.mail.notifications.mutate({ selfUin, requestId, enabled })),
    upload: (signal) =>
      request((requestId) => client.mail.upload.mutate({ selfUin, requestId }), signal),
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
