#!/usr/bin/env bash

# Linux 开发辅助：创建 v4l2loopback 摄像头，推送动态测试画面并启动 WeQ。
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

CAMERA_LABEL="${WEQ_CAMERA_LABEL:-WeQ Virtual}"
VIDEO_NR="${WEQ_VIRTUAL_CAMERA_NR:-10}"
CAMERA_DEVICE="/dev/video${VIDEO_NR}"
WIDTH="${WEQ_VIRTUAL_CAMERA_WIDTH:-640}"
HEIGHT="${WEQ_VIRTUAL_CAMERA_HEIGHT:-360}"
FPS="${WEQ_VIRTUAL_CAMERA_FPS:-30}"

if [[ "$(uname -s)" != Linux ]]; then
  echo "此脚本仅支持 Linux（需要 v4l2loopback）。" >&2
  exit 1
fi

for command in ffmpeg pnpm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "缺少命令：$command" >&2
    exit 1
  fi
done

if [[ -e "$CAMERA_DEVICE" ]]; then
  DEVICE_NAME="$(cat "/sys/class/video4linux/video${VIDEO_NR}/name" 2>/dev/null || true)"
  if [[ "$DEVICE_NAME" != "$CAMERA_LABEL" ]]; then
    echo "$CAMERA_DEVICE 已被占用（名称：${DEVICE_NAME:-未知}）。" >&2
    echo "请设置 WEQ_VIRTUAL_CAMERA_NR 为另一个未占用的编号后重试。" >&2
    exit 1
  fi
else
  echo "创建虚拟摄像头 $CAMERA_DEVICE（$CAMERA_LABEL）；系统可能会提示输入 sudo 密码。"
  if ! sudo modprobe v4l2loopback \
    devices=1 \
    "video_nr=$VIDEO_NR" \
    "card_label=$CAMERA_LABEL" \
    exclusive_caps=1; then
    echo "加载 v4l2loopback 失败。请确认已安装当前内核对应的 v4l2loopback 模块。" >&2
    exit 1
  fi
fi

if [[ ! -e "$CAMERA_DEVICE" ]]; then
  echo "没有创建出 $CAMERA_DEVICE。v4l2loopback 可能已加载但没有这个设备；请先卸载旧模块，或用 v4l2loopback-ctl 添加设备。" >&2
  exit 1
fi

echo "向 $CAMERA_DEVICE 推送 ${WIDTH}x${HEIGHT}@${FPS} 动态测试画面。"
ffmpeg \
  -hide_banner \
  -loglevel warning \
  -re \
  -f lavfi \
  -i "testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}" \
  -an \
  -pix_fmt yuv420p \
  -f v4l2 \
  "$CAMERA_DEVICE" &
FFMPEG_PID=$!

cleanup() {
  kill "$FFMPEG_PID" 2>/dev/null || true
  wait "$FFMPEG_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1
if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
  echo "ffmpeg 无法向 $CAMERA_DEVICE 输出画面；请检查摄像头格式与权限。" >&2
  exit 1
fi

echo "启动 WeQ，WEQ_CAMERA_LABEL=$CAMERA_LABEL"
cd "$REPO_ROOT"
WEQ_CAMERA_LABEL="$CAMERA_LABEL" pnpm --filter @weq/desktop dev
