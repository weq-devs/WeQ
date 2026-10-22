import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseQzonePermissionList,
  setQzoneFriendPermission,
} from '../src/account/web/qzone_friend_permissions';

afterEach(() => vi.unstubAllGlobals());
describe('空间单好友权限', () => {
  it('兼容 CGI 的单引号、无引号键和尾逗号对象字面量，不执行返回脚本', () => {
    const blocked = `_Callback({\ncode: 0,\nsubcode: 0,\ndata: {items: [{uin: '10002', nick: '合成昵称',},],},\n});`;
    expect(parseQzonePermissionList(blocked, 'blocked')).toEqual([
      { uin: '10002', name: '合成昵称' },
    ]);
    const hidden = `_Callback({code:0,data:{data:{hide_uins:[],hide_apps:[],},},});`;
    expect(parseQzonePermissionList(hidden, 'hidden')).toEqual([]);
    expect(() =>
      parseQzonePermissionList('_Callback({code:0,data:(()=>{throw 1})()});', 'blocked'),
    ).toThrow();
  });
  it('名单缺失与明确空表分开，隐藏应用列表不能冒充隐藏好友', () => {
    expect(parseQzonePermissionList('{"code":0,"data":{"items":[]}}', 'blocked')).toEqual([]);
    expect(() => parseQzonePermissionList('{"code":0,"data":{}}', 'blocked')).toThrow();
    expect(() =>
      parseQzonePermissionList('{"code":0,"data":{"data":{"hide_uins":[]}}}', 'hidden'),
    ).toThrow();
    expect(
      parseQzonePermissionList(
        '{"code":0,"data":{"data":{"hide_uins":[{"uin":"10002"}],"hide_apps":[]}}}',
        'hidden',
      ),
    ).toEqual([{ uin: '10002', name: '' }]);
  });
  it('服务端提示还有后页时不能误判某好友不在名单', () => {
    expect(() =>
      parseQzonePermissionList('{"code":0,"data":{"items":[],"has_more":1}}', 'blocked'),
    ).toThrow('完整');
  });
  it.each(['blocked', 'hidden'] as const)(
    '单人修改 %s 只走增删接口，不走整表覆盖',
    async (kind) => {
      const fetch = vi.fn(async () => new Response('{"code":0}'));
      vi.stubGlobal('fetch', fetch);
      const current = vi.fn();
      await setQzoneFriendPermission(
        { uin: '10001', skey: 'synthetic', pskey: 'synthetic' },
        kind,
        '10002',
        false,
        current,
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(current).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).not.toContain('pannel_set');
      const params = new URLSearchParams(String(init.body));
      expect(params.get(kind === 'blocked' ? 'action' : 'otype')).toBe(
        kind === 'blocked' ? '2' : '1',
      );
    },
  );
});
