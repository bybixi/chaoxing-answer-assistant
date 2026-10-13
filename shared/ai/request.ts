import { isRetryableError, withRetry } from '../../scheduler';

/**
 * AI 请求的退避重试封装。
 *
 * 为什么必须独立成模块：`solveQuestion` 直接 import 了 WXT 的 `#imports`（storage），
 * 在 vitest 里无法加载；把重试语义抽到这里，就能用纯逻辑单测覆盖
 * （见 tests/request.spec.ts）。
 *
 * 背景（真实缺陷）：早期实现把 HTTP 错误在 solveQuestion 里直接吞成
 * `answer:null`，而调度器的 withRetry 只对 **throw** 生效 —— 于是一次 429 限流
 * 就永久留空该题，`settings.retries` 完全没起作用。
 */
export async function requestWithRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  baseDelayMs = 1000,
): Promise<T> {
  return withRetry(fn, {
    retries: Math.max(0, retries),
    baseDelayMs,
    shouldRetry: isRetryableError,
  });
}

/** 单次 AI 请求的超时上限：思考模式单题可达 60s+，给足余量 */
export const AI_TIMEOUT_MS = 120_000;
