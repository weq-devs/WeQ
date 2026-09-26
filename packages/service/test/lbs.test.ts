/**
 * LbsService（腾讯位置服务）的归一化 + 错误透传单测。
 *
 * 样本是**真机打回来的原文**（北京南站 / 天安门），只是裁掉了无关字段：
 *   - 输入提示：`/ws/place/v1/suggestion`
 *   - 逆地址解析：`/ws/geocoder/v1`
 *
 * 覆盖三块容易静默出错的地方：
 *   1. 直辖市「省市同名」的拼接（北京市北京市东城区 → 北京市东城区）；
 *   2. 把完整地址剥成「详细地址」（省市区已经在 region 里了，重复一遍很难看）；
 *   3. **错误不静默**：status 非 0 必须抛，且带上服务端 message 与常见释义。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  joinRegion,
  LbsService,
  stripRegionPrefix,
  toLbsPlace,
  toLbsResolvedAddress,
} from '../src/account/lbs';

/** 真机样本：输入提示「北京南站」的第一条。 */
const SUGGESTION_ROW = {
  id: '12265061831819981024',
  title: '北京南站',
  address: '北京市丰台区永外大街车站路12号',
  category: '基础设施:交通设施:火车站',
  type: 0,
  location: { lat: 39.865011, lng: 116.379007 },
  adcode: 110106,
  province: '北京市',
  city: '北京市',
  district: '丰台区',
  _distance: 5167,
};

/** 真机样本：逆地址解析 (39.90923, 116.397428) 的结果（裁掉无关字段）。 */
const GEOCODER_RESULT = {
  location: { lat: 39.90923, lng: 116.397428 },
  address: '北京市东城区西长安街',
  address_component: {
    nation: '中国',
    province: '北京市',
    city: '北京市',
    district: '东城区',
    street: '西长安街',
    street_number: '',
  },
  address_reference: {
    town: { id: '110101001', title: '东华门街道' },
    landmark_l2: { id: '15103389097764433256', title: '天安门' },
  },
};

describe('LbsService 归一化（纯函数）', () => {
  it('joinRegion：直辖市省市同名只留一段，空段落丢掉', () => {
    expect(joinRegion('北京市', '北京市', '东城区')).toBe('北京市东城区');
    expect(joinRegion('四川省', '成都市', '武侯区')).toBe('四川省成都市武侯区');
    expect(joinRegion('海南省', '省直辖县级行政区划', '')).toBe('海南省省直辖县级行政区划');
    expect(joinRegion(undefined, '深圳市', undefined)).toBe('深圳市');
  });

  it('stripRegionPrefix：剥掉省市区前缀，剥不动就原样返回', () => {
    expect(stripRegionPrefix('北京市丰台区永外大街车站路12号', '北京市丰台区')).toBe(
      '永外大街车站路12号',
    );
    expect(stripRegionPrefix('四川省成都市武侯区天府大道1号', '四川省成都市武侯区')).toBe(
      '天府大道1号',
    );
    // 前缀对不上（地址以地标开头）：宁可长一点，也不削成空的。
    expect(stripRegionPrefix('天安门', '北京市东城区')).toBe('天安门');
    // region 为空：原样返回。
    expect(stripRegionPrefix('某某路1号', '')).toBe('某某路1号');
    expect(stripRegionPrefix('', '北京市')).toBe('');
  });

  it('toLbsPlace：直接用真机样本对齐字段', () => {
    expect(toLbsPlace(SUGGESTION_ROW)).toEqual({
      id: '12265061831819981024',
      title: '北京南站',
      // 「北京市丰台区」进了 region，address 只留街道门牌。
      address: '永外大街车站路12号',
      region: '北京市丰台区',
      latitude: 39.865011,
      longitude: 116.379007,
    });
  });

  it('toLbsResolvedAddress：地标名优先，街道用 street + street_number', () => {
    expect(toLbsResolvedAddress(GEOCODER_RESULT)).toEqual({
      title: '天安门',
      address: '西长安街',
      region: '北京市东城区',
    });
  });

  it('toLbsResolvedAddress：没有地标就退到人性化地址推荐；街道为空就退到剥前缀', () => {
    expect(
      toLbsResolvedAddress({
        address: '北京市海淀区中关村大街1号',
        address_component: { province: '北京市', city: '北京市', district: '海淀区' },
        formatted_addresses: { recommend: '中关村(海淀区)' },
      }),
    ).toEqual({
      title: '中关村(海淀区)',
      address: '中关村大街1号',
      region: '北京市海淀区',
    });
  });

  it('字段缺失 / 类型不对时不炸，给出空值', () => {
    expect(toLbsPlace({})).toEqual({
      id: '',
      title: '',
      address: '',
      region: '',
      latitude: 0,
      longitude: 0,
    });
    expect(toLbsResolvedAddress(undefined)).toEqual({ title: '', address: '', region: '' });
  });
});

describe('LbsService 错误透传（打桩 fetch）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubJson(payload: unknown, init: { ok?: boolean; status?: number } = {}): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => payload,
      })),
    );
  }

  it('status 非 0：抛错并带上服务端 message + 常见释义（这里用实测的 113）', async () => {
    stubJson({ status: 113, message: '此功能未被授权' });
    const svc = new LbsService();
    await expect(svc.suggestPlaces({ keyword: '北京' })).rejects.toThrow(
      /113：此功能未被授权（此功能未被授权/,
    );
  });

  it('HTTP 非 2xx：抛错，不当成空结果', async () => {
    stubJson({}, { ok: false, status: 502 });
    const svc = new LbsService();
    await expect(svc.reverseGeocode({ latitude: 1, longitude: 2 })).rejects.toThrow(/HTTP 502/);
  });

  it('空关键词：直接返回空数组，一个请求都不发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = new LbsService();
    expect(await svc.suggestPlaces({ keyword: '   ' })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求参数：lat 在前、带 page_size、key 在 query 上', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ status: 0, data: [] }) };
      }),
    );
    const svc = new LbsService();
    await svc.suggestPlaces({ keyword: '咖啡', latitude: 39.9, longitude: 116.4, limit: 5 });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/ws/place/v1/suggestion');
    expect(url.searchParams.get('keyword')).toBe('咖啡');
    // 腾讯要 latitude,longitude 的顺序。
    expect(url.searchParams.get('location')).toBe('39.9,116.4');
    expect(url.searchParams.get('page_size')).toBe('5');
    expect(url.searchParams.get('key')).toBeTruthy();
  });

  it('逆地址解析带 poi_options=policy=5（位置共享场景）', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 0, result: GEOCODER_RESULT }),
        };
      }),
    );
    const svc = new LbsService();
    const resolved = await svc.reverseGeocode({ latitude: 39.90923, longitude: 116.397428 });
    expect(new URL(calls[0]!).searchParams.get('poi_options')).toBe('policy=5');
    expect(resolved.title).toBe('天安门');
  });
});
