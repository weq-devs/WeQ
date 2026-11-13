interface OutgoingJob {
  conversationId: string;
  previous?: string;
  state: 'queued' | 'sending' | 'failed';
  run: () => Promise<void>;
}

/** 旧队列只由直接前驱成功放行；失败后新提交的消息可越过阻塞，独立接续发送。 */
export class OutgoingQueue {
  private jobs = new Map<string, OutgoingJob>();
  private tails = new Map<string, string>();

  add(id: string, conversationId: string, run: () => Promise<void>): void {
    const previous = this.tails.get(conversationId);
    let predecessor = previous ? this.jobs.get(previous) : undefined;
    while (predecessor?.state === 'queued')
      predecessor = predecessor.previous ? this.jobs.get(predecessor.previous) : undefined;
    this.jobs.set(id, { conversationId, previous, state: 'queued', run });
    this.tails.set(conversationId, id);
    if (!previous || predecessor?.state === 'failed') this.start(id);
  }

  start(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.state === 'sending') return;
    job.state = 'sending';
    void job.run().then(
      () => {
        if (this.jobs.get(id) !== job) return;
        this.jobs.delete(id);
        if (this.tails.get(job.conversationId) === id) this.tails.delete(job.conversationId);
        for (const [nextId, next] of this.jobs)
          if (next.previous === id && next.state === 'queued') this.start(nextId);
      },
      () => {
        if (this.jobs.get(id) === job) job.state = 'failed';
      },
    );
  }

  clear(): void {
    this.jobs.clear();
    this.tails.clear();
  }

  retain(ids: ReadonlySet<string>): void {
    for (const [id, job] of this.jobs) {
      if (ids.has(id) || job.state === 'sending') continue;
      this.jobs.delete(id);
      if (this.tails.get(job.conversationId) === id) this.tails.delete(job.conversationId);
    }
  }
}
