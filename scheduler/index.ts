/**
 * 并发调度器（设计文档 §5.4，用户点名要求的功能）。
 *
 * ★ 这是纯逻辑模块：不 import 任何 chrome/DOM API，
 *   因此可以被 vitest 完整单测，也可以跑在 content script 里。
 */

import { sleep, randInt } from '../shared/constants';

export interface SchedulerOptions {
  /** 并发数 1~10 */
  concurrency: number;
  /** 每个任务开始前随机抖动等待区间 ms（避免节奏规律被识别） */
  minGapMs: number;
  maxGapMs: number;
  /** 每分钟最多请求数（滑动窗口限流） */
  maxPerMinute: number;
  /** 网络/限流类错误的退避重试次数 */
  retries: number;
}

export interface TaskInput<T> {
  id: string;
  /** 数字越小越先跑 */
  priority: number;
  run: () => Promise<T>;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskRecord<T> {
  id: string;
  status: TaskStatus;
  value?: T;
  error?: string;
}

export interface SchedulerHooks<T> {
  /** 允许返回 Promise：调度器会等它落地再继续（否则"完成"会先于回填广播出去） */
  onTaskDone?: (id: string, value: T) => void | Promise<void>;
  onTaskFailed?: (id: string, error: string) => void | Promise<void>;
  /** 任意计数变化时回调，用于浮球进度 */
  onProgress?: (snapshot: {
    done: number;
    failed: number;
    total: number;
  }) => void;
}

/** 钩子异常不能让整轮调度崩掉 —— 吞掉并告警 */
async function safeAwait(fn: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.warn('[scheduler] 钩子执行异常（已忽略）:', err);
  }
}

export class Scheduler<T> {
  private stopped = false;
  private readonly semaphore: Semaphore;
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: SchedulerOptions) {
    this.semaphore = new Semaphore(Math.max(1, Math.min(10, opts.concurrency)));
    this.limiter = new RateLimiter(Math.max(1, opts.maxPerMinute));
  }

  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async run(
    tasks: TaskInput<T>[],
    hooks: SchedulerHooks<T> = {},
  ): Promise<Map<string, TaskRecord<T>>> {
    this.stopped = false;
    const results = new Map<string, TaskRecord<T>>();
    for (const t of tasks)
      results.set(t.id, { id: t.id, status: 'pending' });

    // 优先级排序：数字小的先跑（客观题优先，设计文档 §5.4）
    const sorted = [...tasks].sort((a, b) => a.priority - b.priority);
    let cursor = 0;
    const inFlight = new Set<Promise<void>>();

    // 驱动协程：不断把任务推入并发池
    const driver = (async () => {
      while (!this.stopped && cursor < sorted.length) {
        const task = sorted[cursor++];
        await this.semaphore.acquire();
        if (this.stopped) {
          this.semaphore.release();
          results.get(task.id)!.status = 'skipped';
          continue;
        }
        const p = this.execute(task, results, hooks).finally(() => {
          inFlight.delete(p);
          this.semaphore.release();
        });
        inFlight.add(p);
      }
    })();

    await driver;
    await Promise.all(inFlight);

    // 被停止吞掉的任务标记为 skipped
    for (const r of results.values())
      if (r.status === 'pending') r.status = 'skipped';

    return results;
  }

  private async execute(
    task: TaskInput<T>,
    results: Map<string, TaskRecord<T>>,
    hooks: SchedulerHooks<T>,
  ): Promise<void> {
    const record = results.get(task.id)!;
    record.status = 'running';

    try {
      // 0. 被 stop 后不再发起新请求（否则已进入抖动等待的任务醒来仍会打出去）
      if (this.stopped) {
        record.status = 'skipped';
        return;
      }

      // 1. 随机抖动间隔
      const gap = randInt(this.opts.minGapMs, Math.max(this.opts.minGapMs, this.opts.maxGapMs));
      await sleep(gap);
      if (this.stopped) {
        record.status = 'skipped';
        return;
      }

      // 2. 滑动窗口限流
      await this.limiter.acquire();

      // 3. 指数退避重试（仅网络/限流类错误）
      const value = await withRetry(task.run, {
        retries: this.opts.retries,
        baseDelayMs: 1000,
        shouldRetry: isRetryableError,
      });

      record.status = 'done';
      record.value = value;
      // ★ await：钩子里通常是异步回填，不等它会导致"已完成"提前广播、统计错账
      await safeAwait(() => hooks.onTaskDone?.(task.id, value));
    } catch (err) {
      record.status = 'failed';
      record.error = String((err as Error)?.message ?? err);
      await safeAwait(() => hooks.onTaskFailed?.(task.id, record.error!));
    }
    hooks.onProgress?.({
      done: countBy(results, 'done'),
      failed: countBy(results, 'failed'),
      total: results.size,
    });
  }
}

// ─────────────────────────── 内部构件 ───────────────────────────

/** 计数信号量：限制同时在途的任务数 */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** 滑动窗口限流器 */
export class RateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.maxPerWindow) {
        this.stamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.stamps[0]) + 10;
      await sleep(Math.min(waitMs, 2000));
    }
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitterMs?: number;
  shouldRetry: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/** 指数退避重试：1s → 2s → 4s …（各加随机抖动） */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !opts.shouldRetry(err)) throw err;
      const delay =
        Math.min(opts.maxDelayMs ?? 8000, opts.baseDelayMs * 2 ** attempt) +
        Math.random() * (opts.jitterMs ?? 250);
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/** 429 / 5xx / 网络类错误才重试；4xx（鉴权、参数错）重试也没用 */
export function isRetryableError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (/network|fetch|timeout|aborted|ECONN|Failed to fetch/i.test(msg)) return true;
  return false;
}

function countBy<T>(
  map: Map<string, TaskRecord<T>>,
  status: TaskStatus,
): number {
  let n = 0;
  for (const r of map.values()) if (r.status === status) n++;
  return n;
}
