import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGroupAlbum,
  modifyGroupAlbum,
  deleteGroupAlbum,
  getGroupAlbumUploadPermission,
  getGroupAlbumDetails,
} from '../src/account/web/group_album_management';
import { computeBkn, WebAuthError } from '../src/account/web/credential';
import { WebCredentialProvider } from '../src/account/web/credential';
import { WebQueryService } from '../src/account/web';
import { getGroupAlbumList } from '../src/account/web/group_album';
import type { AccountSession } from '@weq/account';

const credential = { uin: '10001', skey: 'synthetic-sk', pskey: 'synthetic-psk' };
function respond(body: unknown) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('群相册管理 Web 请求', () => {
  it('翻页使用服务器 offset，而不是以记录数代替下一页起点', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { album: [{ id: 'a' }], total: 2, offset: 40 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { album: [{ id: 'b' }], total: 2, offset: 80 } })));
    vi.stubGlobal('fetch', fetcher);
    expect((await getGroupAlbumList(credential, '123')).map((row) => row.id)).toEqual(['a', 'b']);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('start')).toBe('40');
  });
  it('相册字段缺失不能当成空表，明确 total=0 才允许缺省列表', async () => {
    respond({ code: 0, data: {} }); await expect(getGroupAlbumList(credential, '123')).rejects.toThrow('列表缺失');
    respond({ code: 0, data: { total: 0, offset: 1000 } }); expect(await getGroupAlbumList(credential, '123')).toEqual([]);
  });
  it('详情的 album 是单对象，保留原权限和已有封面，编辑只带回已存在字段', async () => {
    respond({ code: 0, data: { album: { id: 'a', privacy: 0, lloc: 'original-cover' } } });
    expect(await getGroupAlbumDetails(credential, '123', 'a', '10001')).toEqual({ privacy: 0, lloc: 'original-cover' });
    const fetcher = respond({ code: 0 });
    await modifyGroupAlbum(credential, { groupId: '123', albumId: 'a', title: 'A', description: '', privacy: 0, lloc: 'original-cover' });
    expect(new URLSearchParams(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).get('lloc')).toBe('original-cover');
    respond({ code: 0, data: { album: { id: 'other', privacy: 0 } } });
    await expect(getGroupAlbumDetails(credential, '123', 'a', '10001')).rejects.toThrow('目标不一致');
  });
  it('新建复现官方字段，返回服务端相册 ID，不重放请求', async () => {
    const fetcher = respond({ code: 0, data: { albumid: 'synthetic-album' } });
    const beforeSend = vi.fn();
    await expect(
      createGroupAlbum(credential, {
        groupId: '123',
        title: ' 合成相册 ',
        description: '合成描述',
        beforeSend,
      }),
    ).resolves.toEqual({ albumId: 'synthetic-album' });
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      '/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_add_album_v2',
    );
    expect(new URL(url).searchParams.get('g_tk')).toBe(String(computeBkn(credential.pskey)));
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toMatchObject({
      qunId: '123',
      uin: credential.uin,
      title: '合成相册',
      desc: '合成描述',
      priv: '1',
      platform: 'qzone',
      source: 'qzone',
    });
  });

  it('编辑显式保留原 priv=0，不套用默认权限、不附带封面或密码', async () => {
    const fetcher = respond({ code: 0, data: {} });
    await modifyGroupAlbum(credential, {
      groupId: '123',
      albumId: 'synthetic-album',
      title: '新名称',
      description: '',
      privacy: 0,
    });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/qun_mod_album_v2?');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('albumId')).toBe('synthetic-album');
    expect(body.get('priv')).toBe('0');
    expect(body.get('desc')).toBe('');
    expect(body.has('passwd')).toBe(false);
    expect(body.has('coverId')).toBe(false);
  });

  it('删除只携带目标群与相册，不混用删除媒体接口', async () => {
    const fetcher = respond({ code: 0 });
    await deleteGroupAlbum(credential, { groupId: '123', albumId: 'synthetic-album' });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/qun_del_album_v2?');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({
      qunId: '123',
      albumId: 'synthetic-album',
    });
  });

  it('formSender 包裹仅作为 JSON 数据解析，不执行脚本', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          '<script>frameElement.callback({"code":0,"data":{"albumid":"new"}});</script>',
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      createGroupAlbum(credential, { groupId: '123', title: '新相册', description: '' }),
    ).resolves.toEqual({ albumId: 'new' });
  });

  it.each([{}, { code: '0' }, { code: 0, data: {} }, { code: 1, message: '无权限' }])(
    '不把缺少业务码、未知回执或缺 ID 当作新建成功：%j',
    async (body) => {
      const fetcher = respond(body);
      await expect(
        createGroupAlbum(credential, { groupId: '123', title: '新相册', description: '' }),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('认证拒绝不自动换票重放写入', async () => {
    const fetcher = respond({ code: -3000, message: '登录失效' });
    await expect(
      deleteGroupAlbum(credential, { groupId: '123', albumId: 'synthetic-album' }),
    ).rejects.toBeInstanceOf(WebAuthError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('网络结果不明不重试新建', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('synthetic disconnect');
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(
      createGroupAlbum(credential, { groupId: '123', title: '新相册', description: '' }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('无效群号、名称和描述在网络前拒绝', async () => {
    const fetcher = respond({ code: 0 });
    for (const patch of [
      { groupId: '0' },
      { groupId: '123&qunId=456' },
      { groupId: '4294967296' },
      { title: '' },
      { title: 'x'.repeat(31) },
      { description: 'x'.repeat(2001) },
    ]) {
      await expect(
        createGroupAlbum(credential, {
          groupId: '123',
          title: '新相册',
          description: '',
          ...patch,
        }),
      ).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('晚到的账号检查失败，不发送下一笔写入', async () => {
    const fetcher = respond({ code: 0 });
    await expect(
      deleteGroupAlbum(credential, {
        groupId: '123',
        albumId: 'synthetic-album',
        beforeSend: () => {
          throw new Error('来源已改变');
        },
      }),
    ).rejects.toThrow('来源已改变');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('上传权限严格依赖权威数字字段，不把缺失或字符串 0 当作允许', async () => {
    const fetcher = respond({ code: 0, data: { uploadRight: 0 } });
    await expect(getGroupAlbumUploadPermission(credential, '123')).resolves.toMatchObject({
      allowed: true,
      status: 0,
    });
    const [url] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('uin')).toBe(credential.uin);
    respond({ code: 0, data: { uploadRight: 1, msg: '仅管理员可上传' } });
    await expect(getGroupAlbumUploadPermission(credential, '123')).resolves.toMatchObject({
      allowed: false,
      status: 1,
    });
    for (const uploadRight of [undefined, '0', -1, 0.5]) {
      respond({ code: 0, data: { uploadRight } });
      await expect(getGroupAlbumUploadPermission(credential, '123')).rejects.toThrow();
    }
  });

  it('列表保留实际权限 0，缺字段不补默认权限', async () => {
    respond({ code: 0, data: { album: [{ id: 'a', privacy: 0 }, { id: 'b' }] } });
    expect((await getGroupAlbumList(credential, '123')).map((album) => album.privacy)).toEqual([
      0,
      null,
    ]);
  });

  it('列表缺少明确业务码时不能作为空相册或删除后不存在的证据', async () => {
    for (const body of [{}, { code: '0' }, { code: null }]) {
      respond(body);
      await expect(getGroupAlbumList(credential, '123')).rejects.toThrow();
    }
  });

  it('账号服务异步取票后再复核来源，阻止切源后的写请求', async () => {
    let current = true;
    vi.spyOn(WebCredentialProvider.prototype, 'forDomain').mockImplementation(async () => {
      current = false;
      return credential;
    });
    const fetcher = respond({ code: 0 });
    const service = new WebQueryService(
      { ptFetchCredentials: vi.fn() },
      { context: { uin: credential.uin } } as unknown as AccountSession,
      () => 101,
    );
    await expect(
      service.deleteGroupAlbum({
        groupId: '123',
        albumId: 'synthetic-album',
        beforeSend: () => {
          if (!current) throw new Error('来源已改变');
        },
      }),
    ).rejects.toThrow('来源已改变');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('账号服务遇到认证拒绝也不隐式重新取票重放新建', async () => {
    const credentials = vi
      .spyOn(WebCredentialProvider.prototype, 'forDomain')
      .mockResolvedValue(credential);
    const fetcher = respond({ code: -3000 });
    const service = new WebQueryService(
      { ptFetchCredentials: vi.fn() },
      { context: { uin: credential.uin } } as unknown as AccountSession,
      () => 101,
    );
    await expect(
      service.createGroupAlbum({ groupId: '123', title: '新相册', description: '' }),
    ).rejects.toBeInstanceOf(WebAuthError);
    expect(credentials).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
