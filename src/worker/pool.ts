interface WorkerTask<T, R> {
  id: string;
  payload: T;
  execute: (payload: T, slotId: number) => Promise<R>;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
}

export interface WorkerPoolStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  slots: number[];
}

/**
 * WorkerPool manages N concurrent async tasks, each assigned a slot ID.
 * Tasks are queued and executed as workers become available.
 * Rate limiting: if a task fails with rate-limit signal, the pool
 * pauses briefly before retrying.
 */
export class WorkerPool {
  private queue: WorkerTask<unknown, unknown>[] = [];
  private activeSlots = new Set<number>();
  private results = new Map<string, { status: "fulfilled" | "rejected"; value?: unknown; reason?: unknown }>();
  private completed = 0;
  private failed = 0;
  private slotCounter = 0;
  private running = false;

  constructor(
    private concurrency: number,
    private rateLimitDelayMs = 2000,
    private maxRetries = 2,
  ) {}

  getStats(): WorkerPoolStats {
    return {
      queued: this.queue.length,
      running: this.activeSlots.size,
      completed: this.completed,
      failed: this.failed,
      slots: Array.from(this.activeSlots),
    };
  }

  submit<T, R>(id: string, payload: T, execute: (payload: T, slotId: number) => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.queue.push({ id, payload: payload as unknown, execute: execute as unknown as (p: unknown, s: number) => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
      if (!this.running) {
        this.running = true;
        this.processQueue();
      }
    });
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 || this.activeSlots.size > 0) {
      while (this.activeSlots.size < this.concurrency && this.queue.length > 0) {
        const task = this.queue.shift()!;
        const slotId = this.slotCounter++;
        this.activeSlots.add(slotId);
        this.runTask(task, slotId);
      }
      // Wait a bit if no capacity or no tasks, but keep loop alive until all finish
      if (this.activeSlots.size >= this.concurrency || (this.queue.length === 0 && this.activeSlots.size > 0)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    this.running = false;
  }

  private async runTask<T, R>(task: WorkerTask<T, R>, slotId: number, retries = 0): Promise<void> {
    try {
      const result = await task.execute(task.payload as unknown as T, slotId);
      this.results.set(task.id, { status: "fulfilled", value: result });
      this.completed++;
      (task.resolve as (v: R) => void)(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const isRateLimited =
        err.message.includes("429") ||
        err.message.includes("rate limit") ||
        err.message.includes("too many requests");
      if (isRateLimited && retries < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelayMs * (retries + 1)));
        return this.runTask(task, slotId, retries + 1);
      }
      this.results.set(task.id, { status: "rejected", reason: error });
      this.failed++;
      task.reject(error);
    } finally {
      this.activeSlots.delete(slotId);
    }
  }

  async drain(): Promise<void> {
    while (this.running || this.activeSlots.size > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
