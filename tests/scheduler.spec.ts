import { describe, it, expect } from 'vitest';
import { Scheduler, Semaphore, withRetry, isRetryableError } from '../scheduler/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Scheduler 并发上限', () => {
  it('同时进行的任务数不超过 concurrency', async () => {
    let current = 0;
    let peak = 0;

    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      priority: 0,
      run: async () => {
        current++;
        peak = Math.max(peak, current);
        await sleep(40);
        current--;
        return i;
      },
    }));

    const s = new Scheduler<number>({ concurrency: 2, minGapMs: 0, maxGapMs: 0, maxPerMinute: 9999, retries: 0 });
    const results = await s.run(tasks);

    expect(peak).toBeLessThanOrEqual(2);
    expect(results.size).toBe(10);
    expect([...results.values()].every((r) => r.status === 'done')).toBe(true);
  });

  it('按优先级顺序处理（优先级小的先入池）', async () => {
    const order: string[] = [];
    const tasks = [
      { id: 'low', priority: 9, run: async () => void order.push('low') },
      { id: 'high', priority: 0, run: async () => void order.push('high') },
      { id: 'mid', priority: 5, run: async () => void order.push('mid') },
    ];
    const s = new Scheduler<void>({ concurrency: 1, minGapMs: 0, maxGapMs: 0, maxPerMinute: 9999, retries: 0 });
    await s.run(tasks);
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('stop() 后剩余任务被标记为 skipped', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      priority: 0,
      run: async () => {
        await sleep(60);
        return i;
      },
    }));
    const s = new Scheduler<number>({ concurrency: 1, minGapMs: 0, maxGapMs: 0, maxPerMinute: 9999, retries: 0 });
    const p = s.run(tasks);
    setTimeout(() => s.stop(), 80); // 前两个跑完后停掉
    const results = await p;
    const skipped = [...results.values()].filter((r) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
  });
});

describe('withRetry 退避', () => {
  it('可重试错误按次数重试直到成功', async () => {
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('HTTP 429 too many requests');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 5, shouldRetry: isRetryableError },
    );
    expect(v).toBe('ok');
    expect(calls).toBe(3);
  });

  it('不可重试错误立即抛出', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('HTTP 401 unauthorized');
        },
        { retries: 3, baseDelayMs: 5, shouldRetry: isRetryableError },
      ),
    ).rejects.toThrow('401');
    expect(calls).toBe(1);
  });
});

describe('Semaphore', () => {
  it('超过上限的 acquire 会排队', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    let secondResolved = false;
    const p = sem.acquire().then((rel) => {
      secondResolved = true;
      return rel;
    });
    await sleep(20);
    expect(secondResolved).toBe(false);
    first();
    const rel2 = await p;
    expect(secondResolved).toBe(true);
    rel2();
  });
});
