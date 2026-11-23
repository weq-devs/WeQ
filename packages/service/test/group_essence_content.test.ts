import { expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { GroupInfoService } from '../src/account/group_info';

it('联网精华读取失败必须可区分于成功空列表，不能伪装已取消', async () => {
  const svc = new GroupInfoService({} as unknown as AccountSession);
  await expect(svc.getEssenceMessagesWithContent('123')).rejects.toThrow();
  const getGroupEssence = vi.fn().mockRejectedValue(new Error('合成读取失败'));
  svc.setWebQueryService({ getGroupEssence });
  await expect(svc.getEssenceMessagesWithContent('123')).rejects.toThrow('合成读取失败');
  getGroupEssence.mockResolvedValue([]);
  await expect(svc.getEssenceMessagesWithContent('123')).resolves.toEqual([]);
});

it('保留已验证分页的完整标记，旧数组接口仍返回相同消息数组', async () => {
  const svc = new GroupInfoService({} as unknown as AccountSession);
  const getGroupEssencePage = vi.fn().mockResolvedValue({ messages: [], complete: true });
  svc.setWebQueryService({ getGroupEssence: vi.fn(), getGroupEssencePage });
  await expect(svc.getEssencePageWithContent('123')).resolves.toEqual({
    messages: [],
    complete: true,
  });
  await expect(svc.getEssenceMessagesWithContent('123')).resolves.toEqual([]);
  getGroupEssencePage.mockRejectedValue(new Error('合成分页失败'));
  await expect(svc.getEssenceMessagesWithContent('123')).rejects.toThrow('合成分页失败');
});

it('聊天只取精华序号时不展开正文，保留完整页证据和已设精华的顺序', async () => {
  const svc = new GroupInfoService({} as unknown as AccountSession);
  const readBody = vi.fn(() => [{ msg_type: 1, text: '合成精华正文' }]);
  svc.setWebQueryService({
    getGroupEssence: vi.fn(),
    getGroupEssencePage: vi.fn().mockResolvedValue({
      complete: true,
      messages: [
        {
          msg_seq: 42,
          get msg_content() {
            return readBody();
          },
        },
        { msg_seq: 17, msg_content: [] },
      ],
    }),
  });
  await expect(svc.getEssencePageSequences('123')).resolves.toEqual({
    complete: true,
    sequences: ['42', '17'],
  });
  expect(readBody).not.toHaveBeenCalled();
  const page = await svc.getEssencePageWithContent('123');
  expect(page.messages[0]?.content).toMatchObject([{ type: 1, text: '合成精华正文' }]);
  expect(readBody).toHaveBeenCalledOnce();
});
