interface OutgoingJob {
  conversationId: string;
  previous?: string;
  state: 'queued' | 'sending' | 'failed';
  run: () => Promise<void>;
}

/** 只由直接前驱的成功回执放行；失败和手动越过不会放行其他分支。 */
export class OutgoingQueue {
  private jobs = new Map<string, OutgoingJob>();
  private tails = new Map<string, string>();

  add(id: string, conversationId: string, run: () => Promise<void>): void {
    const previous = this.tails.get(conversationId);
    this.jobs.set(id, { conversationId, previous, state: 'queued', run });
    this.tails.set(conversationId, id);
    if (!previous) this.start(id);
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
