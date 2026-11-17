import { afterEach, expect, it } from 'vitest';
import { createMobileBackPreview } from '../src/renderer/src/lib/mobileBackPreview';

let host: HTMLDivElement;
afterEach(() => host?.remove());

it('二级设置拖动时只复制标题与分类目录，收尾恢复宿主原样', () => {
  host = document.createElement('div');
  host.innerHTML = `<section class="weq-mobile-settings" data-mobile-category="true">
    <header class="weq-mobile-settings-header"><button>返回</button><strong>常规</strong></header>
    <nav class="weq-settings-nav"><h2 id="title">设置</h2><button>常规</button><button>基础功能</button></nav>
    <div class="weq-settings-content"><input value="草稿"><video></video></div>
  </section>`;
  document.body.append(host);
  const target = host.firstElementChild as HTMLElement;
  const destroy = createMobileBackPreview(target)!;
  const preview = host.querySelector<HTMLElement>('[data-mobile-back-preview]')!;
  expect(preview.inert).toBe(true);
  expect(preview.getAttribute('aria-hidden')).toBe('true');
  expect(preview.hasAttribute('data-mobile-category')).toBe(false);
  expect(preview.querySelector('header strong')?.textContent).toBe('设置');
  expect(preview.querySelector('nav')?.textContent).toContain('基础功能');
  expect(preview.querySelector('input, video, [id]')).toBeNull();
  expect(target.querySelector('input')?.value).toBe('草稿');
  destroy();
  expect(host.children).toHaveLength(1);
  expect(host.style.position).toBe('');
  expect(createMobileBackPreview(host)).toBeUndefined();
});
