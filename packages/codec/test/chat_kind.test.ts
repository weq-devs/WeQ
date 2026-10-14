/**
 * ChatType (SQL column 40010) → conversation kind.
 *
 * 这个分类是导出/计数/头像那条链路的地基，而它最容易踩的坑是**枚举名互相
 * 包含**：`KCHATTYPETEMPC2CFROMGROUP`（100，群聊发起的临时会话）名字里同时
 * 含 'C2C' 和 'GROUP'。曾经各调用点各自 `String(chatType).includes('GROUP')`
 * 判断，于是这种临时会话被当成群聊 —— 去群消息表按 uid 查计数恒得 0、头像拼成
 * 群头像、导出走错表导空（issue #87）。断言把这层语义钉在这里。
 */

import { describe, expect, it } from 'vitest';
import {
  ChatType,
  classifyChatType,
  enumName,
  isGroupTempChatType,
  toChatTypeNumber,
} from '../src/domain/msg';

describe('classifyChatType', () => {
  it('classifies temp c2c-from-group as direct despite the GROUP in its name', () => {
    // 数字与枚举名字符串两种 wire 形态都要落到 direct。
    expect(classifyChatType(100)).toBe('direct');
    expect(classifyChatType('KCHATTYPETEMPC2CFROMGROUP')).toBe('direct');
    // db 层给已知值的就是这个带 GROUP 的枚举名 —— 子串判的坑就出在它身上。
    expect(enumName(ChatType, ChatType.KCHATTYPETEMPC2CFROMGROUP)).toBe(
      'KCHATTYPETEMPC2CFROMGROUP',
    );
  });

  it('treats every direct temp session as direct', () => {
    for (const v of [
      ChatType.KCHATTYPEC2C,
      ChatType.KCHATTYPETEMPC2CFROMUNKNOWN,
      ChatType.KCHATTYPETEMPC2CFROMGROUP,
      ChatType.KCHATTYPETEMPFRIENDVERIFY,
    ]) {
      expect(classifyChatType(v)).toBe('direct');
    }
  });

  it('classifies only KCHATTYPEGROUP as group', () => {
    expect(classifyChatType(ChatType.KCHATTYPEGROUP)).toBe('group');
    expect(classifyChatType('KCHATTYPEGROUP')).toBe('group');
    // 群通知 / 群助手 / 群祝福不是真群聊，不能因为名字带 GROUP 就归 group。
    for (const v of [
      ChatType.KCHATTYPEGROUPNOTIFY,
      ChatType.KCHATTYPEGROUPHELPER,
      ChatType.KCHATTYPEGROUPBLESS,
      ChatType.KCHATTYPEGROUPGUILD,
    ]) {
      expect(classifyChatType(v)).not.toBe('group');
    }
  });

  it('separates dataline / service / official from c2c and group', () => {
    expect(classifyChatType(ChatType.KCHATTYPEDATALINE)).toBe('dataline');
    expect(classifyChatType(ChatType.KCHATTYPEDATALINEMQQ)).toBe('dataline');
    expect(classifyChatType(ChatType.KCHATTYPESERVICEASSISTANT)).toBe('service');
    expect(classifyChatType(ChatType.KCHATTYPETEMPPUBLICACCOUNT)).toBe('official');
  });

  it('returns null (not a guess) for types outside the allowlist', () => {
    expect(classifyChatType(0)).toBeNull();
    expect(classifyChatType(ChatType.KCHATTYPEGUILD)).toBeNull();
    expect(classifyChatType(999999)).toBeNull();
    expect(classifyChatType('NOT_A_CHAT_TYPE')).toBeNull();
  });

  it('maps unknown values through toChatTypeNumber unchanged', () => {
    expect(toChatTypeNumber('123')).toBe(123);
    expect(toChatTypeNumber(123)).toBe(123);
    expect(toChatTypeNumber('KCHATTYPEC2C')).toBe(ChatType.KCHATTYPEC2C);
    expect(toChatTypeNumber('BOGUS')).toBeNull();
  });
});

describe('isGroupTempChatType', () => {
  it('is true only for chatType 100, in either wire form', () => {
    expect(isGroupTempChatType(ChatType.KCHATTYPETEMPC2CFROMGROUP)).toBe(true);
    expect(isGroupTempChatType('KCHATTYPETEMPC2CFROMGROUP')).toBe(true);
    expect(isGroupTempChatType(100)).toBe(true);
  });

  it('stays false for a plain c2c even though 60001 may still carry a stale group code', () => {
    // 从群临时会话转成正式好友：会话行 chatType 翻成 1，60001 却残留来源群号。
    // 判据只认 chatType，因此好友私聊不会被误判成临时会话（发文件不再被拦）。
    expect(isGroupTempChatType(ChatType.KCHATTYPEC2C)).toBe(false);
    expect(isGroupTempChatType('KCHATTYPEC2C')).toBe(false);
    expect(isGroupTempChatType(ChatType.KCHATTYPEGROUP)).toBe(false);
    expect(isGroupTempChatType(ChatType.KCHATTYPETEMPC2CFROMUNKNOWN)).toBe(false);
    expect(isGroupTempChatType(0)).toBe(false);
    expect(isGroupTempChatType('BOGUS')).toBe(false);
  });
});
