import { describe, it, expect } from 'vitest';
import { decideReviewOutcome, type ReviewDecisionInput } from '../shared/ai/reviewDecision';

const base: ReviewDecisionInput = {
  candidateValid: true,
  reviewValid: true,
  rconf: 0.8,
  originalConf: 0.4,
  minConfidence: 0.6,
  verdict: 'correct',
  same: true,
};

const input = (over: Partial<ReviewDecisionInput> = {}): ReviewDecisionInput => ({
  ...base,
  ...over,
});

describe('decideReviewOutcome 低置信度复核决策', () => {
  it('复核认可原答案 → 采纳候选', () => {
    const d = decideReviewOutcome(input());
    expect(d.action).toBe('adopt-candidate');
    expect(d.note).toContain('复核确认');
  });

  it('复核认为原答案错了并给出不同答案 → 采纳复核', () => {
    const d = decideReviewOutcome(input({ verdict: 'wrong', same: false, rconf: 0.9 }));
    expect(d.action).toBe('adopt-review');
    expect(d.note).toContain('更正');
  });

  it('复核置信度不足 → 留空', () => {
    const d = decideReviewOutcome(input({ rconf: 0.5 }));
    expect(d.action).toBe('empty');
    expect(d.reason).toContain('置信度仍不足');
  });

  it('verdict 与内容自相矛盾 → 留空', () => {
    // 说 correct 却给了不同答案
    expect(decideReviewOutcome(input({ verdict: 'correct', same: false })).action).toBe('empty');
    // 说 wrong 却给了相同答案
    expect(decideReviewOutcome(input({ verdict: 'wrong', same: true })).action).toBe('empty');
    expect(decideReviewOutcome(input({ verdict: '', same: true })).action).toBe('empty');
  });

  /**
   * ★ 真实病例回归（2026-10-16 作业页实测）
   * 单选第 2 题：原答案置信度 0.10，复核员认可它，但它自己的 selections 给了多个选项
   * → 形状校验不过。旧实现直接留空、完全没看 verdict。
   */
  it('复核输出格式非法但明确认可原答案 → 仍采纳候选（不再被判死）', () => {
    const d = decideReviewOutcome(
      input({ reviewValid: false, verdict: 'correct', rconf: 0.7, originalConf: 0.1 }),
    );
    expect(d.action).toBe('adopt-candidate');
    expect(d.note).toContain('复核输出格式异常');
  });

  it('复核输出格式非法且置信度也不足 → 留空（不冒进）', () => {
    const d = decideReviewOutcome(
      input({ reviewValid: false, verdict: 'correct', rconf: 0.3, originalConf: 0.1 }),
    );
    expect(d.action).toBe('empty');
    expect(d.reason).toContain('复核置信度不足');
  });

  it('复核输出格式非法且未认可原答案 → 留空', () => {
    const d = decideReviewOutcome(
      input({ reviewValid: false, verdict: 'wrong', rconf: 0.9, same: false }),
    );
    expect(d.action).toBe('empty');
    expect(d.reason).toContain('复核答案不合格');
  });

  it('候选本身不合法时，不会因为"复核说 correct"而放行', () => {
    const d = decideReviewOutcome(
      input({ candidateValid: false, reviewValid: false, verdict: 'correct', rconf: 0.9 }),
    );
    expect(d.action).toBe('empty');
  });
});
