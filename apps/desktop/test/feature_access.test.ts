import { findFeature } from '@weq/service/feature-catalog';
import { describeFeatureAccess } from '../src/shared/feature_access';
import { resolveWorkspaceFeature } from '../src/renderer/src/lib/workspaceFeature';
import { describe, expect, it } from 'vitest';

describe('功能入口和业务条件', () => {
  const album = findFeature('groups.albums')!;
  it('已选群允许打开相册，读取新列表使用已有在线状态', () => {
    const facts = { entryKnown: true, context: { account: 'ready', group: 'ready' } } as const;
    expect(describeFeatureAccess(album, facts)).toEqual({
      entry: { status: 'available' },
      operation: { status: 'unknown' },
    });
    expect(describeFeatureAccess(album, { ...facts, qqOnline: true }).operation.status).toBe(
      'available',
    );
    expect(describeFeatureAccess(album, { ...facts, qqOnline: false })).toEqual({
      entry: { status: 'available' },
      operation: { status: 'unavailable', reason: 'album-list' },
    });
  });

  it('上下文缺失与切换来源后的迟到入口分开处理', () => {
    expect(resolveWorkspaceFeature({ id: 'groups.albums' }, 'a:db1', 'a:db1')).toEqual({
      status: 'needs-context',
      missing: ['group'],
    });
    const request = { id: 'groups.albums', group: { code: '12345678', name: '原群' } } as const;
    expect(resolveWorkspaceFeature(request, 'a:db1', 'a:db2')).toEqual({
      status: 'unavailable',
      reason: 'stale-context',
    });
    expect(resolveWorkspaceFeature(request, 'a:db1', 'a:db1')).toEqual({ status: 'available' });
  });

  it('群文件入口必须属于当前数据源的指定群，目录不推断文件管理权限', () => {
    const request = { id: 'groups.files', group: { code: '12345678', name: '原群' } } as const;
    expect(resolveWorkspaceFeature(request, 'a:db1', 'a:db1').status).toBe('available');
    expect(resolveWorkspaceFeature(request, 'a:db1', 'a:db2').status).toBe('unavailable');
    const manage = findFeature('groups.files.manage')!;
    expect(
      describeFeatureAccess(manage, {
        entryKnown: true,
        context: { account: 'ready', group: 'ready' },
      }).operation.status,
    ).toBe('unknown');
  });

  it('本地消息导航、已有图片和默认模型各自使用自己的事实', () => {
    const message = { conversation: 'u_peer', msgId: '123' };
    expect(resolveWorkspaceFeature({ id: 'messages.locate', message }, 'a:db', 'a:db')).toEqual({
      status: 'available',
    });
    expect(resolveWorkspaceFeature({ id: 'messages.locate' }, 'a:db', 'a:db')).toMatchObject({
      status: 'needs-context',
      missing: ['message'],
    });
    const image = findFeature('messages.image.preview')!;
    const facts = { qqOnline: false, context: { account: 'ready', message: 'ready' } } as const;
    expect(describeFeatureAccess(image, { ...facts, imageCached: true }).operation.status).toBe(
      'available',
    );
    expect(describeFeatureAccess(image, { ...facts, imageCached: false }).operation.status).toBe(
      'unknown',
    );
    const model = findFeature('setting:llm-default-model')!;
    expect(
      describeFeatureAccess(model, { entryKnown: true, defaultChatModelReady: false }),
    ).toEqual({
      entry: { status: 'available' },
      operation: { status: 'unavailable', reason: 'default-chat-model' },
    });
  });

  it('设备仅电脑可用项及本人资料权限保持各自的约束', () => {
    const startup = findFeature('setting:startup-enabled')!;
    expect(
      describeFeatureAccess(startup, { client: 'remote', entryKnown: true }).entry.status,
    ).toBe('unsupported');
    const edit = findFeature('contacts.self-profile.edit')!;
    expect(
      describeFeatureAccess(edit, {
        entryKnown: true,
        context: { account: 'ready' },
        profileWriteReady: false,
      }),
    ).toEqual({
      entry: { status: 'available' },
      operation: { status: 'unavailable', reason: 'profile-write' },
    });
  });
});
