import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectDevelopmentDetails,
  DEVELOPMENT_SCAN_LIMITS,
  type DiagnosticAnimation,
  type DiagnosticElement,
} from '../src/preload/development_diagnostics';
import {
  DEVELOPMENT_DIAGNOSTIC_VERSION,
  DEVELOPMENT_SURFACES,
  normalizeDevelopmentDetails,
} from '../src/shared/renderer_diagnostics';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const sample = (animations: DiagnosticAnimation[] | undefined = []) =>
  normalizeDevelopmentDetails(collectDevelopmentDetails(document, animations));

describe('开发内存诊断的页面与动画归属', () => {
  it('首页部件、动画、视频帧和样式表独立计数，缺失视频质量不冒充零', () => {
    document.body.innerHTML =
      '<section class="weq-chathome"><img class="weq-orb-widget"><img class="weq-flake"><span class="weq-tag"></span><video class="weq-chathome-backdrop-media"></video></section>';
    const video = document.querySelector('video')!;
    Object.defineProperties(video, {
      videoWidth: { value: 320 },
      videoHeight: { value: 240 },
      readyState: { value: 4 },
      getVideoPlaybackQuality: {
        value: () => ({ totalVideoFrames: 50, droppedVideoFrames: 2 }),
        configurable: true,
      },
    });
    const result = sample(
      ['weq-flake-fall-alt', 'weq-tag-float', 'weq-orb-breathe', 'weq-chathome-caret-blink'].map(
        (animationName) => ({ animationName, playState: 'running', effect: { target: video } }),
      ),
    );
    expect(result).toMatchObject({
      surfaces: { home: { mounted: 1 } },
      components: {
        homeWidgets: { count: 1 },
        homeFlakes: { count: 1 },
        homeTags: { count: 1 },
        homeBackdrops: { count: 1 },
      },
      media: {
        videoPixels: 76800,
        videoFrames: 50,
        droppedVideoFrames: 2,
        sampledVideoQuality: 1,
        readyVideos: 1,
      },
      styles: { inaccessibleSheets: 0 },
      animationDetails: {
        byKind: {
          homeTag: { running: 1 },
          homeFlake: { running: 1 },
          homeOrb: { running: 1 },
          homeCaret: { running: 1 },
        },
        bySurface: { home: { count: 4 } },
      },
    });
    Object.defineProperty(video, 'getVideoPlaybackQuality', { value: undefined });
    expect(sample().media).toMatchObject({
      videoFrames: null,
      droppedVideoFrames: null,
      sampledVideoQuality: 0,
    });
  });

  it('样式表计数有上限，跨域拒读记录缺测数，数值投影不透传正文', () => {
    const blocked = {
      get cssRules(): { length: number } {
        throw new Error('private-css');
      },
    };
    const sheets = Array.from({ length: DEVELOPMENT_SCAN_LIMITS.styles + 2 }, (_, i) =>
      i === 0 ? blocked : { cssRules: { length: 3 } },
    );
    const result = normalizeDevelopmentDetails(
      collectDevelopmentDetails({ querySelectorAll: () => [], styleSheets: sheets }, []),
    );
    expect(result.styles).toMatchObject({
      sheets: sheets.length,
      sampledSheets: DEVELOPMENT_SCAN_LIMITS.styles,
      omittedSheets: 2,
      inaccessibleSheets: 1,
      rules: (DEVELOPMENT_SCAN_LIMITS.styles - 1) * 3,
    });
    expect(JSON.stringify(result)).not.toContain('private-css');
  });
  it('只输出白名单页面；同时保留显示页面与隐藏页面的挂载规模', () => {
    document.body.innerHTML = `<div data-weq-diagnostic-view="export">
      <div class="weq-export-tool"><span class="weq-exp-card">private message</span></div>
      <div hidden data-retained-panel><div class="message-scroll"><div class="message-line" data-uin="secret-account"></div></div></div>
    </div>`;
    const root = document.querySelector('.weq-export-tool')!;
    Object.defineProperty(root, 'getClientRects', { value: () => ({ length: 1 }) });
    const result = sample();
    expect(result).toMatchObject({
      schemaVersion: DEVELOPMENT_DIAGNOSTIC_VERSION,
      mainView: 'export',
      surfaces: {
        export: { mounted: 1, rendered: 1, descendantElements: 1 },
        chat: { mounted: 1, rendered: 0, descendantElements: 1 },
      },
      components: {
        messageRows: { count: 1, hiddenByAttribute: 1 },
        exportCards: { count: 1, hiddenByAttribute: 0 },
        retainedPanels: { count: 1, hiddenByAttribute: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|data-uin/);
    document
      .querySelector('[data-weq-diagnostic-view]')!
      .setAttribute('data-weq-diagnostic-view', 'private-account');
    expect(sample().mainView).toBeNull();
  });

  it('按最近页面归属动画，动态装扮编号、未知名称和目标属性不会进入结果', () => {
    document.body.innerHTML =
      '<div class="weq-export-tool"><div class="message-scroll"><span id="target"></span></div><div hidden><span id="hidden"></span></div></div>';
    const target = document.querySelector('#target')!;
    const hidden = document.querySelector('#hidden')!;
    const detached = document.createElement('div');
    const result = sample([
      {
        playState: 'running',
        animationName: 'weq-bubbleframe-912345',
        effect: { target, pseudoElement: '::after' },
      },
      { playState: 'paused', animationName: 'weq-widgetframe-912345', effect: { target } },
      { playState: 'finished', animationName: 'weq-fontfx-912345-1', effect: { target } },
      { playState: 'running', animationName: 'weq-exp-skel-shimmer', effect: { target: hidden } },
      { playState: 'running', animationName: 'weq-exp-spin', effect: { target: detached } },
      { playState: 'idle', animationName: 'secret-user-url', effect: null },
      { playState: 'private-state', effect: { target: {} } },
    ]);
    expect(result.animationDetails).toMatchObject({
      sampled: 7,
      omitted: 0,
      hiddenTargets: 1,
      detachedTargets: 1,
      unknownTargets: 2,
      pseudoTargets: 1,
      states: { running: 3, paused: 1, finished: 1, idle: 1, other: 1 },
      byKind: {
        bubbleFrames: { count: 1, running: 1 },
        widgetFrames: { count: 1, running: 0 },
        fontFrames: { count: 1, running: 0 },
        shimmer: { count: 1, running: 1 },
        spinner: { count: 1, running: 1 },
        other: { count: 2, running: 0 },
      },
      bySurface: {
        chat: { count: 3, running: 1 },
        export: { count: 1, running: 1 },
        other: { count: 3, running: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/912345|secret|private-state|target|::after/);
    expect(Object.keys(result.animationDetails.bySurface)).toEqual([...DEVELOPMENT_SURFACES]);
  });

  it('图片只统计状态和自然像素，视频/canvas 只统计数量和状态，不读取 src 或帧内容', () => {
    document.body.innerHTML =
      '<img><img><img><video></video><canvas width="20" height="30"></canvas><webview></webview>';
    const images = document.querySelectorAll('img');
    for (let i = 0; i < images.length; i++) {
      Object.defineProperties(images[i]!, {
        complete: { value: i !== 1 },
        naturalWidth: { value: i === 0 ? 100 : 0 },
        naturalHeight: { value: i === 0 ? 200 : 0 },
        src: {
          get() {
            throw new Error('不得读取地址');
          },
        },
      });
    }
    Object.defineProperties(document.querySelector('video')!, {
      paused: { value: false },
      ended: { value: false },
    });
    expect(sample().media).toMatchObject({
      images: 3,
      sampledImages: 3,
      completeImages: 1,
      pendingImages: 1,
      emptyCompleteImages: 1,
      naturalPixels: 20000,
      maxNaturalPixels: 20000,
      videos: 1,
      playingVideos: 1,
      canvases: 1,
      canvasPixels: 600,
      frames: 1,
    });
  });

  it('扫描上限包含页面、组件、媒体和动画，保留遗漏数而不伪装完整统计', () => {
    const count = Math.max(...Object.values(DEVELOPMENT_SCAN_LIMITS)) + 9;
    const node = document.createElement('div');
    const closest = vi.spyOn(node, 'closest');
    const rects = vi.spyOn(node, 'getClientRects');
    const descendants = vi.spyOn(node, 'getElementsByTagName');
    const nodes = Array.from({ length: count }, () => node);
    const result = normalizeDevelopmentDetails(
      collectDevelopmentDetails(
        { querySelectorAll: () => nodes },
        Array.from({ length: count }, () => ({ playState: 'running' })),
      ),
    );
    expect(result.surfaces.chat).toMatchObject({
      mounted: count,
      sampled: DEVELOPMENT_SCAN_LIMITS.roots,
      omitted: count - DEVELOPMENT_SCAN_LIMITS.roots,
    });
    expect(result.components.messageRows).toMatchObject({
      count,
      sampled: DEVELOPMENT_SCAN_LIMITS.components,
      omitted: count - DEVELOPMENT_SCAN_LIMITS.components,
    });
    expect(result.media).toMatchObject({
      images: count,
      sampledImages: DEVELOPMENT_SCAN_LIMITS.media,
      omittedImages: count - DEVELOPMENT_SCAN_LIMITS.media,
    });
    expect(result.animationDetails).toMatchObject({
      sampled: DEVELOPMENT_SCAN_LIMITS.animations,
      omitted: count - DEVELOPMENT_SCAN_LIMITS.animations,
    });
    expect(rects).toHaveBeenCalledTimes(
      (DEVELOPMENT_SURFACES.length - 1) * DEVELOPMENT_SCAN_LIMITS.roots,
    );
    expect(descendants).toHaveBeenCalledTimes(rects.mock.calls.length);
    expect(closest.mock.calls.length).toBeLessThan(count * 10);
  });

  it('缺失 API 和异常查询不冒充零，正常空文档则确实记零', () => {
    const unavailable = normalizeDevelopmentDetails(
      collectDevelopmentDetails(undefined, undefined),
    );
    expect(unavailable.surfaces.chat?.mounted).toBeNull();
    expect(unavailable.components.messageRows?.count).toBeNull();
    expect(unavailable.media.images).toBeNull();
    expect(unavailable.animationDetails.sampled).toBeNull();
    const empty = sample();
    expect(empty.surfaces.chat?.mounted).toBe(0);
    expect(empty.media.images).toBe(0);
    expect(empty.animationDetails.sampled).toBe(0);
    expect(
      normalizeDevelopmentDetails(
        collectDevelopmentDetails(
          {
            querySelectorAll() {
              throw new Error('private-url');
            },
          },
          [],
        ),
      ).media.images,
    ).toBeNull();
  });

  it('目标异常不丢失其它动画；下次调用从零计数，不保留旧节点或累计值', () => {
    const target = {
      matches: () => false,
      closest() {
        throw new Error('private-target');
      },
    } as unknown as DiagnosticElement;
    const result = sample([{ playState: 'running', effect: { target } }, { playState: 'paused' }]);
    expect(result.animationDetails).toMatchObject({
      sampled: 2,
      unknownTargets: 2,
      states: { running: 1, paused: 1 },
    });
    expect(sample().animationDetails).toMatchObject({
      sampled: 0,
      unknownTargets: 0,
      states: { running: 0, paused: 0 },
    });
  });

  it('主进程投影拒绝任意类别和名称，并将坏数字留为未知', () => {
    const result = normalizeDevelopmentDetails({
      mainView: 'private-name',
      token: 'secret',
      sampleDurationMs: Infinity,
      surfaces: {
        private: { mounted: 3 },
        chat: { mounted: -1, title: 'secret', descendantElements: 12 },
      },
      components: { messageRows: { count: 4, names: ['secret'] } },
      animationDetails: {
        byKind: { secret: { count: 1 }, shimmer: { count: 3, running: NaN } },
        bySurface: { private: { count: 5 } },
      },
      media: { images: 2, src: 'secret' },
    });
    expect(result).toMatchObject({
      mainView: null,
      sampleDurationMs: null,
      surfaces: { chat: { mounted: null, descendantElements: 12 } },
      components: { messageRows: { count: 4 } },
      animationDetails: { byKind: { shimmer: { count: 3, running: null } } },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|token|names|title/);
  });
});
