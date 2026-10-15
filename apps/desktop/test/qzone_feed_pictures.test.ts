/**
 * `projectQzoneFeed` 取图回归测试。
 *
 * 背景：绝大多数说说把真链直接放在 `<img src="https://a1.qpic.cn/psc?...">`，投影器
 * 照常取到。少数说说服务端给的是「占位图 + onload 内联真链」形态 ——
 * `<img src="/ac/b.gif" onload="QZFL.media.reduceImage(1,w,h,{trueSrc:'https:\/\/…'})">`。
 * `/ac/b.gif` 被 `feedImageSource` 的占位过滤挡掉，真链又埋在 JS 字符串字面量里
 * （还带 `\/` 转义），于是整条说说的正文图凭空消失。评论图走 `qzone_interaction.ts`
 * 那套多来源提取器，不受影响，所以现象是「评论有图、正文没图」。
 *
 * 夹具逐字取自 2026-10-16 抓到的真实 `feeds3_html_more` 响应（只裁掉 URL 里过长的
 * 签名字段），用 String.raw 保证 `\/` 原样进入运行时字符串 —— 这正是渲染进程从
 * 后端 `parseJsLiteral` 拿到 html 后的形态。
 */

import { describe, expect, it } from 'vitest';
import { projectQzoneFeed } from '../src/renderer/src/lib/qzone';

/** 占位图形态：真链只在 onload 的 trueSrc 里，且带 `\/` 转义。 */
const PLACEHOLDER_FEED = String.raw`<div class="f-single-content f-wrap"><div class="f-item f-s-i" id="feed_2987539188_311_0_1792079491_0_1"><div class="f-info">解锁成就，凌晨零点的大学校园</div><div class="f-ct "><div class="f-ct-txtimg fui-txtimg fui-imgbox-row-wrap"><div class="txt-box"></div><div class="img-box img-box-row row-two"><a class="img-item " data-cmd="qz_popup" href="https://user.qzone.qq.com/2987539188/311/" data-pickey="f43a12b283f6d06a90130d00,https://m.qpic.cn/psc?/V53RdaNR2cvr1Z08p6XO3mVCJN3TbSFH/TmEUgtj9EK6.7V8ajmQrEDoR*tgjN3h*6Y94oy19yxwj0N4eQi7geEs2zDyj.dX*GSsdnldU*mgulp.sj0g6TYmNbhqMB2fzj1QxbTnYToo!/b" data-width="1080" data-height="1920"><img src="/ac/b.gif" onload="QZFL.media.reduceImage(1,279,279,{trueSrc:'https:\/\/a1.qpic.cn\/psc?\/V53RdaNR2cvr1Z08p6XO3mVCJN3TbSFH\/TmEUgtj9EK6.7V8ajmQrEDoR*tgjN3h*6Y94oy19yxwj0N4eQi7geEs2zDyj.dX*GSsdnldU*mgulp.sj0g6TYmNbhqMB2fzj1QxbTnYToo!\/c&amp;ek=1&amp;kp=1&amp;pt=0&amp;tl=1&amp;vuin=1707889225'",callback:function(img,type,ew,eh,o){var p=img.parentNode;_h=0;_w=0;}})"/></a><a class="img-item " data-cmd="qz_popup" href="https://user.qzone.qq.com/2987539188/311/" data-pickey="f43a12b283f6d06a90130d00,https://r.photo.store.qq.com/psc?/V53RdaNR2cvr1Z08p6XO3mVCJN3TbSFH/TmEUgtj9EK6.7V8ajmQrECxqNCHLKkNumPoFA2VKBqWRrZ5cAq7BHRmxw4uxOM6hqXDtVduwFBKQfivbxPh4VX9b0GnjyHJm2gP1wrdBiRc!/o" data-width="1875" data-height="2500"><img src="/ac/b.gif" onload="QZFL.media.reduceImage(1,279,279,{trueSrc:'https:\/\/a1.qpic.cn\/psc?\/V53RdaNR2cvr1Z08p6XO3mVCJN3TbSFH\/TmEUgtj9EK6.7V8ajmQrECxqNCHLKkNumPoFA2VKBqWRrZ5cAq7BHRmxw4uxOM6hqXDtVduwFBKQfivbxPh4VX9b0GnjyHJm2gP1wrdBiRc!\/c&amp;ek=1&amp;kp=1'})"/></a></div></div></div></div></div>`;

/** 常规形态：真链直接在 src 上（约 96% 的主路径，用于防回归）。 */
const PLAIN_IMG =
  '<img src="https://a1.qpic.cn/psc?/V13PG7Ax27zaH6/bqQfVz5yrrGYSXMvKr.cq&amp;ek=1&amp;kp=1"/>';

const plainFeed = (img: string): string =>
  `<div class="f-single-content f-wrap"><div class="f-item f-s-i" id="feed_3088951402_311_0_1792085940_0_1"><div class="f-info">普通说说</div><div class="f-ct "><div class="img-box img-box-row row-two"><a class="img-item " href="https://user.qzone.qq.com/3088951402/311/">${img}</a></div></div></div></div>`;

describe('Qzone feed body pictures', () => {
  it('recovers the real URL from an onload trueSrc placeholder', () => {
    const body = projectQzoneFeed(PLACEHOLDER_FEED);
    expect(body.images).toHaveLength(2);
    expect(body.images[0]).toBe(
      'https://a1.qpic.cn/psc?/V53RdaNR2cvr1Z08p6XO3mVCJN3TbSFH/TmEUgtj9EK6.7V8ajmQrEDoR*tgjN3h*6Y94oy19yxwj0N4eQi7geEs2zDyj.dX*GSsdnldU*mgulp.sj0g6TYmNbhqMB2fzj1QxbTnYToo!/c&ek=1&kp=1&pt=0&tl=1&vuin=1707889225',
    );
    expect(body.images[1]).toBe(
      'https://a1.qpic.cn/psc?/V53RdaNR2cvr1Z08p6XO3mVCJN3TbSFH/TmEUgtj9EK6.7V8ajmQrECxqNCHLKkNumPoFA2VKBqWRrZ5cAq7BHRmxw4uxOM6hqXDtVduwFBKQfivbxPh4VX9b0GnjyHJm2gP1wrdBiRc!/c&ek=1&kp=1',
    );
    // `\/` 必须已还原：残留的反斜杠会破坏 URL。
    expect(body.images.join('')).not.toContain('\\');
    expect(body.text).toBe('解锁成就，凌晨零点的大学校园');
  });

  it('keeps the ordinary src form working', () => {
    expect(projectQzoneFeed(plainFeed(PLAIN_IMG)).images).toEqual([
      'https://a1.qpic.cn/psc?/V13PG7Ax27zaH6/bqQfVz5yrrGYSXMvKr.cq&ek=1&kp=1',
    ]);
  });

  it('decodes \\x and \\u escapes the way a JS string literal would', () => {
    const encoded = String.raw`<img src="/ac/b.gif" onload="QZFL.media.reduceImage(1,1,1,{trueSrc:'https:\x2f\x2fa1.qpic.cn\u002fpsc\u003f\/V13PG7Ax27zaH6\/x\/c',callback:function(){}})"/>`;
    expect(projectQzoneFeed(plainFeed(encoded)).images).toEqual([
      'https://a1.qpic.cn/psc?/V13PG7Ax27zaH6/x/c',
    ]);
  });

  it('drops an onload without a usable target instead of inventing one', () => {
    const encoded = '<img src="/ac/b.gif" onload="QZFL.media.reduceImage(1,1,1,{})"/>';
    expect(projectQzoneFeed(plainFeed(encoded)).images).toEqual([]);
  });

  it('rejects a non-qq target smuggled into trueSrc', () => {
    const encoded = String.raw`<img src="/ac/b.gif" onload="QZFL.media.reduceImage(1,1,1,{trueSrc:'https:\/\/evil.example.com\/x.png'})"/>`;
    expect(projectQzoneFeed(plainFeed(encoded)).images).toEqual([]);
  });
});
