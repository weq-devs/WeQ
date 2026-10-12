import { describe, expect, it, vi } from 'vitest';
import { SharedPrompt } from '../src/common/shared_prompt';

describe('shared prompt leases', () => {
  it('shares a live prompt and releases listeners on completion', async () => {
    const prompt = new SharedPrompt<string | null>(null);
    let answer!: (value: string | null) => void;
    const cleanup = vi.fn();
    const open = vi.fn((settle) => {
      answer = settle;
      return cleanup;
    });
    const first = prompt.request(open),
      second = prompt.request(open);
    answer('synthetic-answer');
    expect(await first).toBe('synthetic-answer');
    expect(await second).toBe('synthetic-answer');
    expect(open).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('does not dismiss another live caller when one account is cancelled', async () => {
    const prompt = new SharedPrompt<string | null>(null);
    const controller = new AbortController();
    let answer!: (value: string | null) => void;
    const cleanup = vi.fn();
    const open = (settle: typeof answer) => {
      answer = settle;
      return cleanup;
    };
    const first = prompt.request(open, controller.signal),
      second = prompt.request(open);
    controller.abort();
    expect(await first).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    answer('synthetic-answer');
    expect(await second).toBe('synthetic-answer');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('dismisses the last cancelled prompt and ignores a late answer on a replacement', async () => {
    const prompt = new SharedPrompt<string | null>(null);
    const controller = new AbortController();
    let oldAnswer!: (value: string | null) => void;
    let newAnswer!: (value: string | null) => void;
    const cleanup = vi.fn();
    const first = prompt.request((settle) => {
      oldAnswer = settle;
      return cleanup;
    }, controller.signal);
    controller.abort();
    expect(await first).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    const second = prompt.request((settle) => {
      newAnswer = settle;
      return () => {};
    });
    oldAnswer('stale');
    newAnswer('current');
    expect(await second).toBe('current');
  });
  it('handles synchronous dismissal and already cancelled callers', async () => {
    const prompt = new SharedPrompt<string | null>(null);
    expect(
      await prompt.request((finish) => {
        finish(null);
        return () => {};
      }),
    ).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn(() => () => {});
    expect(await prompt.request(open, controller.signal)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
