import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';
import {
  projectQzoneArchive,
  qzoneArchiveConfig,
  QZONE_ARCHIVE_DEFAULTS,
} from '../src/common/qzone_archive';

const detail = (rawStatus: number | null, text = '空友爱看') => ({
  mediaTypes: [],
  archive: { rawStatus, tag: { text, iconUrl: '', targetUrl: '' } },
  archiveTarget: { feedId: 'native-id', commonEligible: true, mediaKinds: [] },
});
describe('普通说说空友状态', () => {
  it('入口及推开关使用实际能力回包，账号内多个动态共用查询', async () => {
    const service = new WebQueryService(
      { sendPacket: vi.fn(), ptFetchCredentials: vi.fn() },
      { context: { uin: '10001' } } as unknown as AccountSession,
      () => 1,
    );
    const capabilities = vi
      .spyOn(service, 'getQzonePublicCapabilities')
      .mockResolvedValue({ public_qzone_entrance_switch: true, can_upvote: false });
    vi.spyOn(service, 'getQzoneNativeDetail').mockResolvedValue(detail(2));
    const [first, second] = await Promise.all([
      service.getQzoneArchiveState('10002', 'one', 1, '10001'),
      service.getQzoneArchiveState('10003', 'two', 2, '10001'),
    ]);
    expect(first.showUpvote || second.showUpvote).toBe(false);
    expect(first.tag?.text).toBe('空友爱看');
    expect(capabilities).toHaveBeenCalledOnce();
    expect(first.capabilitiesObserved).toBe(true);
  });
  it.each([null, -1, 0, 2, 3, 101, 102, 103, 104, 105, 999])(
    '区分原始状态 %s、本人与他人',
    (status) => {
      const self = projectQzoneArchive(detail(status), true);
      const other = projectQzoneArchive(detail(status), false);
      expect(self.rawStatus).toBe(status);
      expect(self.showUpvote).toBe(status !== null && [2, 101, 102, 103, 104].includes(status));
      expect(self.tag !== null).toBe(status !== null && [2, 101, 102].includes(status));
      expect(self.canContribute).toBe(status !== null && [0, 3, 105].includes(status));
      expect(self.canUncontribute).toBe(status !== null && [101, 102, 103, 104].includes(status));
      expect(other.showUpvote).toBe(self.showUpvote);
      expect(other.canContribute || other.canUncontribute || other.canUnarchive).toBe(false);
    },
  );
  it('配置覆盖分别生效，未知状态不因非零或有推人数获得入口', () => {
    const config = qzoneArchiveConfig({
      show_uncontribute_in_share_panel: [999],
      force_filter_archive_tag: false,
    });
    expect(projectQzoneArchive(detail(999), true, config)).toMatchObject({
      showUpvote: true,
      canUncontribute: true,
    });
    expect(projectQzoneArchive(detail(101), true, config).showUpvote).toBe(false);
    expect(config.showContribute).toEqual(QZONE_ARCHIVE_DEFAULTS.showContribute);
    expect(config.source).toBe('qq-config');
  });
  it('缺少状态、标签文案及投稿条件分别处理', () => {
    expect(projectQzoneArchive({ mediaTypes: [] }, true)).toMatchObject({
      rawStatus: null,
      canContribute: false,
      tag: null,
    });
    expect(projectQzoneArchive(detail(102, ''), true).tag).toBeNull();
    expect(
      projectQzoneArchive({ ...detail(0), archiveTarget: undefined }, true).canContribute,
    ).toBe(false);
    expect(
      projectQzoneArchive(
        { ...detail(0), archiveTarget: { feedId: 'id', commonEligible: false, mediaKinds: [] } },
        true,
      ).canContribute,
    ).toBe(false);
  });
});
