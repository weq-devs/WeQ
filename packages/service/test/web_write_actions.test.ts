/**
 * Web CGI 写能力的离线单测：群公告 / 群打卡 / 空间点赞评论 / 群相册上传。
 *
 * 全部 mock 全局 `fetch`，断言 URL、表单字段与成功判据（`ec` / `code` / `ret`）。
 * 不联网、不碰真实 QQ 数据。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebCredential } from '../src/account/web';
import {
  deleteGroupNotice,
  parseGroupNoticeImageUploadResponse,
  resolveGroupNoticeOptions,
  setGroupNotice,
  uploadGroupNoticeImage,
} from '../src/account/web/group_notice';
import { dayYmd, fetchDaySignedList, mapDaySignedList } from '../src/account/web/group_signin';
import { uploadGroupAlbumImage } from '../src/account/web/group_album';
import { commentQzoneMsg, setQzoneLike } from '../src/account/web/qzone';

const CRED: WebCredential = { uin: '10001', skey: 'SK', pskey: 'PSK' };

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(response: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = typeof response === 'string' ? response : JSON.stringify(response);
    return new Response(body, { status });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useRealTimers();
});

describe('群公告', () => {
  it('resolveGroupNoticeOptions：默认值、新成员、冲突检测', () => {
    expect(resolveGroupNoticeOptions()).toMatchObject({
      pinned: 0,
      type: 1,
      sendToNewMembers: false,
      isShowEditCard: 1,
      tipWindowType: 1,
      confirmRequired: 1,
    });
    expect(resolveGroupNoticeOptions({ type: 20 })).toMatchObject({
      type: 20,
      sendToNewMembers: true,
    });
    expect(() => resolveGroupNoticeOptions({ type: 20, sendToNewMembers: false })).toThrow();
    expect(() => resolveGroupNoticeOptions({ pinned: 2 as 1 })).toThrow();
  });

  it('setGroupNotice：URL bkn 用 p_skey、body bkn 用 skey', async () => {
    const calls = mockFetch({ ec: 0, fid: 'fid-1' });
    const result = await setGroupNotice(CRED, '123', 'hello', { pinned: 1 });
    expect(result).toEqual({ noticeId: 'fid-1' });
    const [call] = calls;
    expect(call!.url).toContain('/cgi-bin/announce/add_qun_notice');
    expect(call!.url).toContain('bkn=');
    const body = new URLSearchParams(String(call!.init.body));
    expect(body.get('qid')).toBe('123');
    expect(body.get('text')).toBe('hello');
    expect(body.get('pinned')).toBe('1');
    expect(body.get('type')).toBe('1');
    expect(body.get('bkn')).not.toBe(call!.url.split('bkn=')[1]);
  });

  it('setGroupNotice：新成员公告走 add_qun_instruction；ec 非 0 抛错', async () => {
    const okCalls = mockFetch({ ec: 0 });
    await setGroupNotice(CRED, '123', 'welcome', { sendToNewMembers: true });
    expect(okCalls[0]!.url).toContain('/add_qun_instruction');

    mockFetch({ ec: 100, em: 'no permission' });
    await expect(setGroupNotice(CRED, '123', 'x')).rejects.toThrow('no permission');
  });

  it('deleteGroupNotice：del_feed + fid/qid', async () => {
    const calls = mockFetch({ ec: 0 });
    await deleteGroupNotice(CRED, '123', 'fid-1');
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(calls[0]!.url).toContain('/cgi-bin/announce/del_feed');
    expect(body.get('fid')).toBe('fid-1');
    expect(body.get('qid')).toBe('123');
  });

  it('上传图片：解析 HTML 转义 JSON 元数据', () => {
    expect(
      parseGroupNoticeImageUploadResponse(
        JSON.stringify({
          ec: 0,
          id: '{&quot;id&quot;:&quot;pic-1&quot;,&quot;w&quot;:540,&quot;h&quot;:300}',
        }),
      ),
    ).toEqual({ id: 'pic-1', width: 540, height: 300 });

    expect(() => parseGroupNoticeImageUploadResponse(JSON.stringify({ ec: 1 }))).toThrow();
    expect(() =>
      parseGroupNoticeImageUploadResponse(JSON.stringify({ ec: 0, id: '{bad' })),
    ).toThrow();
  });

  it('uploadGroupNoticeImage：multipart 字段与空图片校验', async () => {
    const calls = mockFetch(
      JSON.stringify({
        ec: 0,
        id: '{&quot;id&quot;:&quot;p&quot;,&quot;w&quot;:1,&quot;h&quot;:1}',
      }),
    );
    await uploadGroupNoticeImage(CRED, new Uint8Array([1, 2, 3]));
    const init = calls[0]!.init;
    expect(String(init.body)).toContain('name="pic_up"');
    expect(String(init.body)).toContain('troopNotice');
    expect((init.headers as Record<string, string>)['Content-Type']).toContain(
      'multipart/form-data',
    );
    await expect(uploadGroupNoticeImage(CRED, new Uint8Array(0))).rejects.toThrow();
  });
});

describe('群打卡', () => {
  it('dayYmd 生成本地 YYYYMMDD', () => {
    expect(dayYmd(new Date(2026, 0, 2))).toBe('20260102');
  });

  it('mapDaySignedList：rank 去偏、缺失 infos 返回空', () => {
    expect(
      mapDaySignedList({
        response: {
          page: [
            {
              infos: [
                { uid: '42', uidGroupNick: 'nick', signedTimeStamp: '100', signInRank: 1 },
                { uid: '43', uidGroupNick: 'b', signedTimeStamp: '200', signInRank: 3 },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      { userId: 42, nick: 'nick', time: 100, rank: 1 },
      { userId: 43, nick: 'b', time: 200, rank: 2 },
    ]);
    expect(mapDaySignedList({ response: { page: [{}] } })).toEqual([]);
  });

  it('fetchDaySignedList：POST JSON，缺 page 抛 WebAuthError', async () => {
    const calls = mockFetch({ response: { page: [{ infos: [] }] } });
    await fetchDaySignedList(CRED, { groupId: '123', dayYmd: '20260102' });
    expect(calls[0]!.url).toContain('/v2/signin/trpc/GetDaySignedList');
    expect(calls[0]!.url).toContain('g_tk=');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      dayYmd: '20260102',
      groupId: '123',
      uid: '10001',
    });

    mockFetch({ retCode: -3000, response: {} });
    await expect(fetchDaySignedList(CRED, { groupId: '123' })).rejects.toThrow();
  });
});

describe('空间写操作', () => {
  it('setQzoneLike：点赞 / 取消走不同 CGI，code 非 0 抛错', async () => {
    const likeCalls = mockFetch({ code: 0, subcode: 0 });
    await setQzoneLike(CRED, '20002', 'tid-1', true);
    expect(likeCalls[0]!.url).toContain('internal_dolike_app');
    const body = new URLSearchParams(String(likeCalls[0]!.init.body));
    expect(body.get('fid')).toBe('tid-1');
    expect(body.get('unikey')).toBe('http://user.qzone.qq.com/20002/mood/tid-1');

    const unlikeCalls = mockFetch({ code: 0 });
    await setQzoneLike(CRED, '20002', 'tid-1', false);
    expect(unlikeCalls[0]!.url).toContain('internal_unlike_app');

    mockFetch({ code: -3000, subcode: 0, message: 'auth' });
    await expect(setQzoneLike(CRED, '20002', 'tid-1', true)).rejects.toThrow();
  });

  it('commentQzoneMsg：topicId 拼接与 rich 参数成对校验', async () => {
    const calls = mockFetch({ code: 0, subcode: 0, commentid: 'c-1' });
    const result = await commentQzoneMsg(CRED, '20002', 'tid-1', 'hi');
    expect(result).toEqual({ commentId: 'c-1' });
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('topicId')).toBe('20002_tid-1__1');
    expect(body.get('content')).toBe('hi');

    await expect(commentQzoneMsg(CRED, '20002', 'tid-1', 'hi', 1)).rejects.toThrow();
    await expect(commentQzoneMsg(CRED, '20002', 'tid-1', '  ')).rejects.toThrow();
  });
});

describe('群相册上传', () => {
  it('先建会话再按 16 KiB 分片，且不自动重试', async () => {
    // 第一发：FileBatchControl；后续每片：FileUpload。
    const calls: FetchCall[] = [];
    let uploads = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('FileBatchControl')) {
        return new Response(JSON.stringify({ ret: 0, data: { session: 'S1' } }), { status: 200 });
      }
      uploads += 1;
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    });

    const image = new Uint8Array(40 * 1024).fill(7);
    const result = await uploadGroupAlbumImage(CRED, {
      groupId: '123',
      albumId: 'a1',
      albumName: 'album',
      image,
      fileName: 'pic.jpg',
    });
    expect(result).toEqual({ session: 'S1' });
    expect(calls[0]!.url).toContain('FileBatchControl');
    // 40 KiB / 16 KiB = 3 片。
    expect(uploads).toBe(3);
    expect(String(calls[0]!.init.body)).toContain('"sAlbumID":"a1"');

    await expect(
      uploadGroupAlbumImage(CRED, {
        groupId: '123',
        albumId: 'a1',
        albumName: 'a',
        image: new Uint8Array(0),
      }),
    ).rejects.toThrow();
  });

  it('分片返回 ret 非 0 时抛错', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('FileBatchControl')) {
        return new Response(JSON.stringify({ ret: 0, data: { session: 'S1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ret: 1, msg: 'bad' }), { status: 200 });
    });
    await expect(
      uploadGroupAlbumImage(CRED, {
        groupId: '123',
        albumId: 'a1',
        albumName: 'a',
        image: new Uint8Array(1024),
      }),
    ).rejects.toThrow('bad');
  });
});
