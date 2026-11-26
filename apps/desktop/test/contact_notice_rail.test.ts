import './support/development-features.stub';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { useUnreadMarkers } from '../src/renderer/src/lib/unreadMarkers';

afterEach(() => vi.unstubAllGlobals());

it('联系人导航可关闭转发，联系人页仍显示原有通知角标', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  let markers: ReturnType<typeof useUnreadMarkers> | undefined;
  const epoch = 'contact-notice-rail-fixture';
  function ReadMarkers() {
    markers = useUnreadMarkers();
    return null;
  }
  try {
    act(() => root.render(createElement(ReadMarkers)));
    const update = (revision: number, requests: boolean, navigation: boolean) =>
      act(() =>
        acceptPreferences(
          {
            epoch,
            revision,
            records: {},
            values: { showContactRequestBadge: requests, showContactNavigationBadge: navigation },
          },
          false,
        ),
      );
    update(1, true, true);
    expect(markers).toMatchObject({ requests: true, contactNavigation: true });
    update(2, true, false);
    expect(markers).toMatchObject({ requests: true, contactNavigation: false });
    update(3, false, true);
    expect(markers).toMatchObject({ requests: false, contactNavigation: false });
  } finally {
    act(() => root.unmount());
    acceptPreferences({ epoch, revision: 4, records: {}, values: {} }, false);
  }
});

it('联系人入口显示通知红点而非数字，查看清除后移除', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = vi.fn();
  const render = (contactBadgeCount: number) =>
    act(() =>
      root.render(
        createElement(AppRail, {
          user: {
            id: 'u_self',
            username: 'u_self',
            identityLabel: 'QQ',
            identityValue: '10001',
            displayName: '自己',
            avatarUrl: null,
          },
          view: 'messages',
          onViewChange: noop,
          onOpenSettings: noop,
          onOpenCollection: noop,
          onOpenDressUp: noop,
          onOpenProfile: noop,
          onOpenAbout: noop,
          onOpenInvite: noop,
          onOpenWonderfulTools: noop,
          onOpenAntiRecall: noop,
          onOpenDbRepair: noop,
          onOpenQzoneAlbum: noop,
          contactBadgeCount,
        }),
      ),
    );
  try {
    render(2);
    const dot = host.querySelector('[aria-label="有新的好友或群通知"]');
    expect(dot?.classList.contains('rail-badge-dot')).toBe(true);
    expect(dot?.textContent).toBe('');
    render(0);
    expect(host.querySelector('[aria-label="有新的好友或群通知"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
