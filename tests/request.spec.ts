import { describe, it, expect, vi } from 'vitest';
import { requestWithRetry } from '../shared/ai/request';

/**
 * AI 请求的退避重试（真实缺陷回归测试）
 *
 * 旧实现把 HTTP 错误在 solveQuestion 里吞成 answer:null，而调度器的 withRetry
 * 只对 throw 生效 → 一次 429 就永久留空，settings.retries 形同虚设。
 * 现在 solveQuestion 走 requestWithRetry，这里锁住语义。
 */
describe('requestWithRetry', () => {
  it('瞬时错误（429）会自动重试，第二次成功则返回结果', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('HTTP 429 Too Many Requests');
      return 'ok';
    });

    const value = await requestWithRetry(fn, 2, 1); // baseDelay=1ms，测试不等真退避
    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('连续失败到超过重试次数 → 抛出（由上层转成"请求失败"留空）', async () => {
    const fn = vi.fn(async () => {
      throw new Error('HTTP 503 Service Unavailable');
    });

    await expect(requestWithRetry(fn, 2, 1)).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
  });

  it('不可重试的错误（401 鉴权）立刻抛出，不做无谓重试', async () => {
    const fn = vi.fn(async () => {
      throw new Error('HTTP 401 Unauthorized');
    });

    await expect(requestWithRetry(fn, 3, 1)).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('超时类错误（timeout/aborted）算可重试', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('TimeoutError: signal timed out');
      return 'ok';
    });

    await expect(requestWithRetry(fn, 1, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries=0 时一次定生死（不额外调用）', async () => {
    const fn = vi.fn(async () => {
      throw new Error('HTTP 500');
    });
    await expect(requestWithRetry(fn, 0, 1)).rejects.toThrow('500');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
