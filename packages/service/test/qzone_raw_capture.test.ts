import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebCredential } from '../src/account/web/credential';
import { getQzoneMsgList, mapMsgList } from '../src/account/web/qzone';
import { qzonePaginationLimiter } from '@weqbot/protocol';
import { stubWebFetch } from './support/web-fetch';

// 用例之间共享进程内的空间翻页额度（kernel 的限流器是全局单例）。默认
// 「10 秒内 5 页」在连续跑几个用例时会排队，这里放宽到基本不限额。
qzonePaginationLimiter.configure({ windowSeconds: 1, maxPages: 1000 });

// 业务实现已收编进 `@weqbot/protocol`，kernel 里直接调全局 `fetch` —— 所以从
// 最底层拦，而不是 mock WeQ 的 `./http`（那条路径已经不再被业务使用）。
// 桩在 beforeEach 里重装：afterEach 会 restore，只在模块顶层装一次的话第二个
// 用例起就失效了。
let web = stubWebFetch();

const CREDENTIAL: WebCredential = {
  uin: '10001',
  skey: 'synthetic-skey',
  pskey: 'synthetic-pskey',
};

describe('qzone msglist raw response capture', () => {
  beforeEach(() => {
    web = stubWebFetch();
  });
  afterEach(() => web.restore());

  it('awaits capture of the exact original unknown fields and large integer text', async () => {
    const text =
      ' \n_Callback({"code":0,"total":1,"unknown":{"big":18446744073709551615},"msglist":[{"tid":"9223372036854775807","content":"hello","unknownField":"retain raw"}]});\n';
    web.reply({ text: text });
    let finishCapture: (() => void) | undefined;
    const captureRaw = vi.fn(
      async (_text: string) =>
        new Promise<void>((resolve) => {
          finishCapture = resolve;
        }),
    );
    let resolved = false;
    const pending = getQzoneMsgList(CREDENTIAL, '10001', 0, 20, captureRaw).then((result) => {
      resolved = true;
      return result;
    });
    await vi.waitFor(() => expect(captureRaw).toHaveBeenCalledOnce());
    expect(captureRaw.mock.calls[0]).toEqual([text]);
    expect(resolved).toBe(false);
    finishCapture?.();
    const result = await pending;
    expect(result.list[0]?.tid).toBe('9223372036854775807');
    expect(result.list[0]?.content).toBe('hello');
  });

  it('rejects raw write failure before parsing or mapping the response', async () => {
    // Mapping would fail on a string pic; raw persistence failure must win first.
    web.reply({ text: '{"code":0,"msglist":[{"tid":"1","pic":"invalid-shape"}]}' });
    const failure = new Error('raw disk full');
    const captureRaw = vi.fn(async (_text: string) => {
      throw failure;
    });
    await expect(getQzoneMsgList(CREDENTIAL, '10001', 0, 20, captureRaw)).rejects.toBe(failure);
    expect(captureRaw).toHaveBeenCalledOnce();
    expect(captureRaw.mock.calls[0]).toHaveLength(1);
  });

  it('keeps old calls and default paging behavior compatible', async () => {
    web.reply({ text: '{"code":0,"total":0,"msglist":[]}' });
    expect(await getQzoneMsgList(CREDENTIAL, '10001')).toEqual({ total: 0, list: [] });
    const url = new URL(web.at(0).url);
    expect(url.searchParams.get('pos')).toBe('0');
    expect(url.searchParams.get('num')).toBe('20');
  });

  it('accepts the real authenticated null tail without confusing it with login failure', async () => {
    web.reply({
      text: JSON.stringify({
        code: 0,
        total: 0,
        msglist: null,
        logininfo: { uin: 10001 },
        usrinfo: { uin: 10001 },
      }),
    });
    expect(await getQzoneMsgList(CREDENTIAL, '10001', 42)).toEqual({ total: 0, list: [] });
  });

  it('keeps the server total when hidden or private posts leave the tail empty', async () => {
    // Real spaces can report total > 0 while returning msglist: null because posts
    // are hidden from this account; the count must survive for paging UI.
    web.reply({
      text: JSON.stringify({
        code: 0,
        total: 3,
        msglist: null,
        logininfo: { uin: 10001 },
        usrinfo: { uin: 10001 },
      }),
    });
    expect(await getQzoneMsgList(CREDENTIAL, '10001', 42)).toEqual({ total: 3, list: [] });
  });

  it.each([
    { code: 0, total: 0, msglist: null },
    { code: -3000, total: 0, msglist: null, logininfo: { uin: 10001 }, usrinfo: { uin: 10001 } },
    { code: 0, total: 0, msglist: null, logininfo: { uin: 20002 }, usrinfo: { uin: 10001 } },
  ])('rejects null tails without complete successful identity evidence: %j', async (body) => {
    web.reply({ text: JSON.stringify(body) });
    await expect(getQzoneMsgList(CREDENTIAL, '10001', 42)).rejects.toThrow();
  });

  it('retains voice identity and unmapped video native fields for incremental hashes', () => {
    const raw = {
      tid: 'fixture',
      pic: [{ is_video: 1, video_info: { video_id: 'video-id', video_time: '12' } }],
      voice: [
        { id: 'voice-id', time: 13, url: 'https://snsapp.qzone.qq.com/voice', unknown: 'kept' },
      ],
    };
    const before = mapMsgList({ msglist: [raw] }).list[0]!;
    expect(before.videos).toEqual([]);
    expect(before.nativeMedia?.pic).toEqual(raw.pic);
    expect(before.nativeMedia?.voice).toEqual(raw.voice);
    const after = mapMsgList({ msglist: [{ ...raw, voice: [{ ...raw.voice[0], time: 14 }] }] })
      .list[0]!;
    expect(before.content).toEqual(after.content);
    expect(before.images).toEqual(after.images);
    expect(before.videos).toEqual(after.videos);
    expect(JSON.stringify(before)).not.toEqual(JSON.stringify(after));
  });
});
