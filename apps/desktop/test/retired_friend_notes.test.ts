// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AccountWriteService } from '../../../packages/service/src/account/account_write';
import {
  CONTACT_CARD_FIELDS,
  normalizeContactCard,
} from '../../../packages/service/src/common/contact_card';
import { createQQWriteRouter } from '../src/main/ipc/routers/qq_write';

describe('撤下好友扩展备注资料', () => {
  it('不再暴露读写接口，普通备注接口保留', () => {
    const resolve = () => {
      throw new Error('不应读取账号');
    };
    const procedures = Object.keys(createQQWriteRouter(resolve, resolve)._def.procedures);
    expect(procedures).not.toContain('friendNotesState');
    expect(procedures).not.toContain('friendNotes');
    expect(procedures).toContain('friendRemarkState');
    expect(procedures).toContain('friendRemark');
    expect(AccountWriteService.prototype).not.toHaveProperty('getFriendNotes');
    expect(AccountWriteService.prototype).not.toHaveProperty('friendNotes');
  });
  it('旧显示偏好不恢复已撤下字段，公开资料字段不受影响', () => {
    const settings = normalizeContactCard({ visible: { notes: true }, order: ['notes'] });
    expect(CONTACT_CARD_FIELDS.map(([key]) => key)).not.toContain('notes');
    expect(settings.order).not.toContain('notes');
    expect(settings.visible).not.toHaveProperty('notes');
    expect(settings.visible.company).toBe(true);
    expect(settings.visible.description).toBe(true);
  });
});
