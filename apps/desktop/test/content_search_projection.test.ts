import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ContentSearchStore } from '@weq/service';
import { rememberMail, rememberQzonePosts } from '../src/main/search_content';
import type { MailDetail } from '@weq/service/mail';

it('正文投影不保存图片票据或脚本，邮件摘要刷新不能覆盖详情', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-content-projection-'));
  const path = join(root, 'cache.json');
  const store = new ContentSearchStore(path);
  try {
    const row: MailDetail = {
      id: '@fixture',
      folderId: 1,
      messageId: '',
      subject: '同名主题',
      snippet: '摘要',
      sender: { name: '合成作者', email: 'author@example.invalid' },
      to: [],
      cc: [],
      bcc: [],
      time: 1,
      size: 1,
      unread: false,
      starred: false,
      hasAttachments: false,
      draft: false,
      html: '<p>正文专有词 needle</p><script>private-script</script><img src="https://example.invalid/?token=secret">',
      replyTo: null,
      attachments: [],
    };
    rememberMail(store, [row]);
    const { html: _html, replyTo: _reply, attachments: _files, ...summary } = row;
    rememberMail(store, [summary]);
    expect(store.search('mailMessage', 'needle', 10).total).toBe(1);
    expect(store.search('mailMessage', 'private-script', 10).total).toBe(0);
    rememberQzonePosts(store, '10001', [{ tid: 'post', content: '摘要', time: 1 }], '作者名字');
    rememberQzonePosts(
      store,
      '10001',
      [{ tid: 'post', content: '完整正文 needle', time: 0 }],
      '',
      true,
    );
    expect(store.search('qzonePost', '作者名字', 10).items[0]?.content).toContain('needle');
    store.flush();
    expect(readFileSync(path, 'utf8')).not.toMatch(/token=secret|private-script|https:\/\/example/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
