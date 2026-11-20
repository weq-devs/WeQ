import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QqArk } from '../src/renderer/src/components/ark/QqArk';
import { MailCardNavigationContext } from '../src/renderer/src/lib/mailNavigation';

const mailId = 'ZC_fixture~opaque';
const webPath = '/list/readtemplate?name=qq_login_jump.html';
const qqPath = '/login/login?qq_target=clientreadmail';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function clickCard(meta: Record<string, string>, navigate: ((id: string) => void) | null) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          MailCardNavigationContext.Provider,
          { value: navigate },
          createElement(QqArk, {
            arkData: {
              app: 'com.tencent.template.public',
              view: 'mail',
              meta: { mail: { subTitle: '合成邮件', ...meta } },
            },
          }),
        ),
      ),
    );
    act(() => host.querySelector<HTMLElement>('[role="button"], [role="link"]')?.click());
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

it.each([
  ['mailUrl', webPath],
  ['mailUrlByCode', qqPath],
])('点击 %s 直接打开对应邮件', async (field, path) => {
  const navigate = vi.fn();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  await clickCard(
    { [field]: `https://wx.mail.qq.com${path}&mailid=ZC_fixture%7Eopaque` },
    navigate,
  );
  expect(navigate).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith(mailId);
  expect(open).not.toHaveBeenCalled();
});

it.each([
  'https://wx.mail.qq.com/list/readtemplate?name=qq_login_jump.html',
  'https://wx.mail.qq.com/list/readtemplate?name=qq_login_jump.html&mailid=a&mailid=b',
  'https://wx.mail.qq.com.example.invalid/list/readtemplate?name=qq_login_jump.html&mailid=a',
  'https://wx.mail.qq.com/other?mailid=a',
])('未识别出 QQ 邮件详情时保留原链接行为', async (url) => {
  const navigate = vi.fn();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  await clickCard({ mailUrl: url }, navigate);
  expect(navigate).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(url, '_blank');
});
