import { afterEach, expect, it } from 'vitest';
import { createMobileRootTransition } from '../src/renderer/src/lib/mobileRootTransition';

let host: HTMLDivElement;
afterEach(() => host?.remove());
function fixture() {
  host = document.createElement('div');
  document.body.append(host);
  Object.defineProperty(host, 'clientWidth', { value: 400 });
  host.innerHTML = `
    <div class="app-shell"><aside class="sidebar"><header>消息</header><div class="sidebar-body">
      <div data-mobile-sidebar-page="messages">消息列表</div>
      <div hidden style="display:none" data-mobile-sidebar-page="contacts"><input id="private-id" value="旧值">联系人列表</div>
    </div></aside></div>
    <div hidden data-mobile-root-preview="contacts"><aside class="sidebar"><header>联系人</header><div class="sidebar-body"></div></aside></div>
    <div hidden data-mobile-root-preview="qzone"><main class="chat-main"><header>QQ 空间</header></main></div>`;
  host.querySelector('input')!.value = '当前值';
}
it('半程已经显示目标页，源页和目标页连续相邻，副本不参与交互', () => {
  fixture();
  const transition = createMobileRootTransition(host, 'messages', 'contacts', false)!;
  transition.move(-150);
  const outgoing = host.querySelector<HTMLElement>('[data-mobile-transition-page="messages"]')!;
  const incoming = host.querySelector<HTMLElement>('[data-mobile-transition-page="contacts"]')!;
  expect(outgoing.style.transform).toBe('translate3d(-150px,0,0)');
  expect(incoming.style.transform).toBe('translate3d(250px,0,0)');
  expect(incoming.textContent).toContain('联系人列表');
  expect(incoming.querySelector('[data-mobile-sidebar-page]')?.hasAttribute('hidden')).toBe(false);
  expect(incoming.querySelector('input')?.value).toBe('当前值');
  expect(incoming.querySelector('[id]')).toBeNull();
  expect(host.querySelector<HTMLElement>('.weq-mobile-transition')!.inert).toBe(true);
  transition.destroy();
  expect(host.querySelector('.weq-mobile-transition')).toBeNull();
  expect(host.querySelector('#private-id')).not.toBeNull();
});

it('取消后目标页退回边缘；提交后目标页到位且仍留待实际页面绘制', async () => {
  fixture();
  const transition = createMobileRootTransition(host, 'messages', 'contacts', false)!;
  await transition.finish(-150, false);
  const incoming = host.querySelector<HTMLElement>('[data-mobile-transition-page="contacts"]')!;
  expect(incoming.style.transform).toBe('translate3d(400px,0,0)');
  await transition.finish(-150, true);
  expect(incoming.style.transform).toBe('translate3d(0px,0,0)');
  expect(incoming.isConnected).toBe(true);
  transition.destroy();
});

it('减少动态效果时使用两页交叉淡变，不作横向移动', async () => {
  fixture();
  const transition = createMobileRootTransition(host, 'messages', 'qzone', true)!;
  transition.move(-200);
  const incoming = host.querySelector<HTMLElement>('[data-mobile-transition-page="qzone"]')!;
  expect(incoming.style.opacity).toBe('0.5');
  expect(incoming.style.transform).toBe('');
  await transition.finish(-200, true);
  expect(incoming.style.opacity).toBe('1');
  transition.destroy();
});
