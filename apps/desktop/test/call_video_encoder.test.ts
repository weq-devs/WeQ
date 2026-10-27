// @vitest-environment node
/**
 * `NativeVideoEncoder` 的**换档与尺寸对齐**。
 *
 * 这里钉住屏幕共享最容易踩的两个坑：
 *
 * 1. **切换采集源必须重开编码器。** native 的 t265 是进程级单例，`openVideoEncoder`
 *    打开之后改不了分辨率 / 码率 —— 唯一的办法是 `closeVideoEncoder` + 重新打开。
 * 2. **编码尺寸必须与采集端一致。** 共享一块 21:9 或 4:3 的屏幕时，渲染层会按源
 *    宽高比推出一个非 16:9 的尺寸；编码器不跟着改，`pushFrame` 的平面长度校验就
 *    过不去，帧被**静默丢掉**（没有报错，只是对方什么都看不到）。
 *
 * 用假 native 绑定代替真 `t265`：不需要 QQ 客户端，也不碰真实编码器。
 */

import { describe, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { NativeVideoEncoder } from '../src/main/call_video_encoder';
import { CAMERA_PROFILE, SCREEN_PROFILE } from '../src/shared/call_video_profile';

/** 记录每次 open 的参数，并让 encodeVideoFrame 返回一个固定的小帧。 */
function fakeNative() {
  const opened: Array<{ width: number; height: number; fps: number; kbps: number }> = [];
  const calls = { close: 0, encode: 0, open: 0 };
  const nt = {
    openVideoEncoder: vi.fn(
      async (
        _dir: string,
        width?: number | null,
        height?: number | null,
        fps?: number | null,
        kbps?: number | null,
      ) => {
        calls.open++;
        opened.push({
          width: width ?? 0,
          height: height ?? 0,
          fps: fps ?? 0,
          kbps: kbps ?? 0,
        });
      },
    ),
    closeVideoEncoder: vi.fn(() => {
      calls.close++;
    }),
    encodeVideoFrame: vi.fn(() => {
      calls.encode++;
      return { data: Buffer.from([0, 0, 0, 1, 0x26, 0x01]), keyframe: true };
    }),
  } as unknown as NtHelperBinding;
  return { nt, opened, calls };
}

const MODULES = '/nonexistent/avsdk';

describe('NativeVideoEncoder 换档', () => {
  it('默认档位与摄像头档位一致', () => {
    const { nt } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    expect(encoder.info()).toMatchObject({
      width: CAMERA_PROFILE.width,
      height: CAMERA_PROFILE.height,
      fps: CAMERA_PROFILE.fps,
      bitrateKbps: CAMERA_PROFILE.bitrateKbps,
    });
  });

  it('切到屏幕共享时按新档位重开编码器', async () => {
    const { nt, opened, calls } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    expect(opened[0]).toMatchObject({ width: 480, height: 270, fps: 12, kbps: 300 });

    const profile = await encoder.setSource('screen');
    // 先关再开：t265 打开后不能改参数。
    expect(calls.close).toBe(1);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatchObject({
      width: SCREEN_PROFILE.width,
      height: SCREEN_PROFILE.height,
      fps: SCREEN_PROFILE.fps,
      kbps: SCREEN_PROFILE.bitrateKbps,
    });
    expect(profile).toMatchObject({ width: 960, height: 540, bitrateKbps: 1200 });
    expect(encoder.currentSource).toBe('screen');
  });

  it('切回摄像头时档位还原', async () => {
    const { nt, opened } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    await encoder.setSource('screen');
    await encoder.setSource('camera');
    expect(opened).toHaveLength(3);
    expect(opened[2]).toMatchObject({ width: 480, height: 270, kbps: 300 });
    expect(encoder.currentSource).toBe('camera');
  });

  it('切到同一采集源是空操作（不白重开一次编码器）', async () => {
    const { nt, opened, calls } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    await encoder.setSource('camera');
    expect(opened).toHaveLength(1);
    expect(calls.close).toBe(0);
  });

  it('换采集源会清空待编队列（旧尺寸的帧不能再送进去）', async () => {
    const { nt } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    // 推一帧当前摄像头档位合法的 I420。
    const y = new Uint8Array(CAMERA_PROFILE.width * CAMERA_PROFILE.height);
    const u = new Uint8Array((CAMERA_PROFILE.width / 2) * (CAMERA_PROFILE.height / 2));
    const v = new Uint8Array((CAMERA_PROFILE.width / 2) * (CAMERA_PROFILE.height / 2));
    encoder.pushFrame({ y, u, v });
    expect(encoder.pending).toBe(1);

    await encoder.setSource('screen');
    // 队列在 close() 里被清空：那些帧是旧分辨率的，送给新编码器只会越界。
    expect(encoder.pending).toBe(0);
  });
});

describe('NativeVideoEncoder 尺寸对齐', () => {
  it('resize 会按新尺寸重开编码器', async () => {
    const { nt, opened } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    await encoder.resize(1280, 540);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatchObject({ width: 1280, height: 540 });
    expect(encoder.info()).toMatchObject({ width: 1280, height: 540 });
  });

  it('resize 把奇数尺寸对齐到偶数', async () => {
    const { nt } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    await encoder.resize(1365, 767);
    // I420 的色度平面按 2×2 采样，奇数宽高会越界。
    expect(encoder.info().width % 2).toBe(0);
    expect(encoder.info().height % 2).toBe(0);
  });

  it('尺寸没变时 resize 是空操作', async () => {
    const { nt, opened } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    await encoder.resize(CAMERA_PROFILE.width, CAMERA_PROFILE.height);
    expect(opened).toHaveLength(1);
  });

  it('非法尺寸（0 / 负数）直接忽略，不动编码器', async () => {
    const { nt, opened } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();
    await encoder.resize(0, 0);
    await encoder.resize(-10, 720);
    expect(opened).toHaveLength(1);
    expect(encoder.info()).toMatchObject({
      width: CAMERA_PROFILE.width,
      height: CAMERA_PROFILE.height,
    });
  });

  it('尺寸对不上的帧被丢弃，对得上的才进队列', async () => {
    const { nt, calls } = fakeNative();
    const encoder = new NativeVideoEncoder(nt, MODULES);
    await encoder.open();

    // 当前档位的一帧：合法。
    const cw = CAMERA_PROFILE.width;
    const ch = CAMERA_PROFILE.height;
    encoder.pushFrame({
      y: new Uint8Array(cw * ch),
      u: new Uint8Array((cw / 2) * (ch / 2)),
      v: new Uint8Array((cw / 2) * (ch / 2)),
    });
    // 共享档位的一帧：与当前编码尺寸不符，丢。
    const sw = SCREEN_PROFILE.width;
    const sh = SCREEN_PROFILE.height;
    encoder.pushFrame({
      y: new Uint8Array(sw * sh),
      u: new Uint8Array((sw / 2) * (sh / 2)),
      v: new Uint8Array((sw / 2) * (sh / 2)),
    });
    expect(encoder.pending).toBe(1);

    await encoder.next();
    expect(calls.encode).toBe(1);
  });
});
