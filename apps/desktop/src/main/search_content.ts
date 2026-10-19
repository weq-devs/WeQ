import {
  contentSearchKey,
  htmlPlainText,
  type ContentSearchStore,
  type ContentSearchCategory,
  type ContentSearchPage,
  type GuildDirectService,
} from '@weq/service';
import { searchCatalog } from './market_catalog';
import type { MailSummary, MailDetail } from '@weq/service/mail';

export function searchAccountContent(
  store: ContentSearchStore,
  guild: GuildDirectService,
  category: ContentSearchCategory,
  keyword: string,
  limit: number,
  offset: number,
  ownUin?: string,
): ContentSearchPage | Promise<ContentSearchPage> {
  if (category === 'guildMessage') return guild.search(keyword, limit, offset);
  if (category !== 'marketEmoji') return store.search(category, keyword, limit, offset, ownUin);
  const page = searchCatalog({ keyword, limit, cursor: String(offset) });
  const records = searchCatalog({ limit: 1 }).total;
  return {
    items: page.entries.map((entry) => {
      const target = { kind: 'marketEmoji' as const, packId: entry.id };
      return {
        category: 'marketEmoji',
        id: contentSearchKey(target),
        target,
        title: entry.name,
        content: entry.mark,
        sourceName: entry.feeType,
        time: 0,
        observedAt: 0,
      };
    }),
    total: page.total,
    coverage: {
      scope: 'offline-catalog',
      records,
      limited: false,
      updatedAt: null,
      available: records > 0,
    },
  };
}

export function rememberMail(
  store: ContentSearchStore | undefined,
  rows: readonly (MailSummary | MailDetail)[],
) {
  store?.remember(
    rows.map((row) => ({
      target: { kind: 'mailMessage', id: row.id, folderId: row.folderId },
      detail: 'html' in row,
      title: row.subject || '(无主题)',
      content: [
        row.snippet,
        'html' in row ? htmlPlainText(row.html) : '',
        row.sender.name,
        row.sender.email,
        ...[...row.to, ...row.cc, ...row.bcc].map((person) => `${person.name} ${person.email}`),
        ...('attachments' in row ? row.attachments.map((file) => file.name) : []),
      ].join('\n'),
      sourceName: row.sender.name || row.sender.email,
      time: row.time,
    })),
  );
}

export function rememberQzonePosts(
  store: ContentSearchStore | undefined,
  uin: string,
  rows: readonly {
    tid: string;
    content: string;
    time: number;
    repost?: { content: string } | null;
  }[],
  name = '',
  detail = false,
) {
  store?.remember(
    rows.map((row) => ({
      target: { kind: 'qzonePost', uin, tid: row.tid },
      title: name,
      content: [row.content, row.repost?.content].filter(Boolean).join('\n'),
      sourceName: `空间 ${uin}`,
      time: row.time,
      detail,
    })),
  );
}
export function rememberQzoneAlbums(
  store: ContentSearchStore | undefined,
  uin: string,
  rows: readonly { id: string; name: string; desc: string; createTime: number }[],
) {
  store?.remember(
    rows.map((row) => ({
      target: { kind: 'qzoneAlbum', uin, albumId: row.id },
      title: row.name,
      content: row.desc,
      sourceName: `空间 ${uin}`,
      time: row.createTime,
    })),
  );
}
