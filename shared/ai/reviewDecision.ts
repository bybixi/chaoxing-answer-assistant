/**
 * 低置信度复核的决策表（纯逻辑，可单测）。
 *
 * 为什么独立成模块：这是「宁空不错」策略的核心判决，边界情况多，
 * 必须有测试锁住；同时 solveQuestion 依赖 `#imports`（storage），无法在 vitest 里加载。
 */

export type ReviewAction =
  /** 采纳最初的候选答案（复核认可它） */
  | 'adopt-candidate'
  /** 采纳复核给出的新答案（复核认为原答案错了） */
  | 'adopt-review'
  /** 留空 */
  | 'empty';

export interface ReviewDecisionInput {
  /** 候选答案本身是否通过校验（进复核前必然为 true，显式传入以便测试） */
  candidateValid: boolean;
  /** 复核输出的**形状**是否合法（validateAnswer 的结果） */
  reviewValid: boolean;
  /** 复核输出的置信度 */
  rconf: number;
  /** 候选答案的原始置信度 */
  originalConf: number;
  /** 置信度阈值（settings.minConfidence） */
  minConfidence: number;
  /** 复核的 verdict 字段，已小写；'correct' | 'wrong' | 其它 */
  verdict: string;
  /** 复核答案与候选答案是否等价 */
  same: boolean;
}

export interface ReviewDecision {
  action: ReviewAction;
  note?: string;
  reason?: string;
}

const pct = (n: number) => n.toFixed(2);

/**
 * 决策表：
 *
 * | 情形 | 处理 |
 * |---|---|
 * | 复核输出形状非法，但 verdict=correct 且候选合法且复核置信度达标 | **采纳候选**（格式异常不牵连内容判断）|
 * | 复核输出形状非法（其它情况） | 留空 |
 * | 复核置信度不足 | 留空 |
 * | verdict=correct 且与原答案一致 | 采纳候选 |
 * | verdict=wrong 且与原答案不同 | 采纳复核答案 |
 * | verdict 与内容自相矛盾（说 correct 却给了不同答案等） | 留空 |
 *
 * ★ 第一行是 2026-10-16 补的：真实病例 —— 单选第 2 题原答案置信度 0.10，
 *   复核员认可它，但自己的 `selections` 给了多个选项 → 形状校验不过 →
 *   旧实现直接留空、**完全没看 verdict**，等于让"复核员的格式错误"把题判死。
 */
export function decideReviewOutcome(input: ReviewDecisionInput): ReviewDecision {
  const { candidateValid, reviewValid, rconf, originalConf, minConfidence, verdict, same } = input;
  const confText = `原${pct(originalConf)}→复核${pct(rconf)}`;

  // ① 复核输出形状非法：先看它是否明确认可候选答案
  if (!reviewValid) {
    if (verdict === 'correct' && candidateValid) {
      if (rconf >= minConfidence) {
        return {
          action: 'adopt-candidate',
          note: `复核确认原答案（复核输出格式异常，已按"确认"处理；${confText}）`,
        };
      }
      return {
        action: 'empty',
        reason: `复核确认原答案但复核置信度不足（${confText}），宁空不错`,
      };
    }
    return {
      action: 'empty',
      reason: `置信度过低(${pct(originalConf)})，复核答案不合格，留空`,
    };
  }

  // ② 复核置信度不足
  if (rconf < minConfidence) {
    return { action: 'empty', reason: `复核后置信度仍不足（${confText}），宁空不错` };
  }

  // ③ 复核认可原答案
  if (verdict === 'correct' && same) {
    return { action: 'adopt-candidate', note: `低置信度经复核确认（${confText}）` };
  }

  // ④ 复核认为原答案错了，并给出不同答案
  if (verdict === 'wrong' && !same) {
    return { action: 'adopt-review', note: `原答案经复核更正（${confText}）` };
  }

  // ⑤ 声明与内容不一致：不冒险
  return { action: 'empty', reason: `复核结论自相矛盾（${confText}），宁空不错` };
}
