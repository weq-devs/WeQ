import { describe, expect, it } from 'vitest';
import { GroupVideoDeliveryQueue } from '../src/main/group_video_delivery';

describe('群视频下行', () => {
  it('只丢拥塞的视频源，从该成员的下一个关键帧恢复', () => {
    const queue = new GroupVideoDeliveryQueue();
    expect(queue.offer(1, false, 20)).toBeUndefined();
    const first = queue.offer(1, true, 20)!;
    const second = queue.offer(1, false, 20)!;
    expect(queue.offer(1, false, 20)).toBeUndefined();
    expect(queue.offer(2, true, 20)).toBeDefined();
    queue.acknowledge(first);
    expect(queue.offer(1, false, 20)).toBeUndefined();
    expect(queue.offer(1, true, 20)).toBeDefined();
    queue.acknowledge(second);
    expect(queue.offer(1, false, 20)).toBeDefined();
  });

  it('限制所有发送中的帧数和字节，未知确认不释放容量', () => {
    const queue = new GroupVideoDeliveryQueue();
    const max = 2 * 1024 * 1024;
    const seq = queue.offer(1, true, max)!;
    expect(queue.offer(2, true, 1)).toBeUndefined();
    queue.acknowledge(seq + 1);
    expect(queue.offer(2, true, 1)).toBeUndefined();
    queue.acknowledge(seq);
    for (let uin = 1; uin <= 16; uin++) expect(queue.offer(uin, true, 1)).toBeDefined();
    expect(queue.offer(17, true, 1)).toBeUndefined();
  });
});
