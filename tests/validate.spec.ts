import { describe, it, expect } from 'vitest';
import { validateAnswer, normalizeAnswer } from '../shared/ai/validate';
import type { Question } from '../shared/types/question';

const q = (over: Partial<Question>): Question => ({
  id: 'q1',
  index: 1,
  type: 'single',
  stem: '1+1=?',
  imgUrls: [],
  options: [
    { key: 'A', text: '1', imgUrls: [] },
    { key: 'B', text: '2', imgUrls: [] },
    { key: 'C', text: '3', imgUrls: [] },
  ],
  blankCount: 0,
  ...over,
});

describe('validateAnswer 本地校验（准确率第二道关）', () => {
  it('单选：命中选项集合内的唯一 key 才通过', () => {
    expect(validateAnswer(q({}), { questionId: 'q1', selections: ['B'] }).ok).toBe(true);
    expect(validateAnswer(q({}), { questionId: 'q1', selections: ['D'] }).ok).toBe(false);
    expect(validateAnswer(q({}), { questionId: 'q1', selections: ['A', 'B'] }).ok).toBe(false);
    expect(validateAnswer(q({}), { questionId: 'q1', selections: [] }).ok).toBe(false);
  });

  it('多选：必须是非空子集', () => {
    const m = q({ type: 'multiple' });
    expect(validateAnswer(m, { questionId: 'q1', selections: ['A', 'C'] }).ok).toBe(true);
    expect(validateAnswer(m, { questionId: 'q1', selections: [] }).ok).toBe(false);
    expect(validateAnswer(m, { questionId: 'q1', selections: ['A', 'Z'] }).ok).toBe(false);
  });

  it('判断：只接受 对/错', () => {
    const j = q({ type: 'judge', options: [{ key: '对', text: '对', imgUrls: [] }, { key: '错', text: '错', imgUrls: [] }] });
    expect(validateAnswer(j, { questionId: 'q1', selections: ['对'] }).ok).toBe(true);
    expect(validateAnswer(j, { questionId: 'q1', selections: ['正确'] }).ok).toBe(false);
  });

  it('填空：空位数量必须完全一致', () => {
    const b = q({ type: 'blank', blankCount: 2 });
    expect(validateAnswer(b, { questionId: 'q1', blanks: ['x', 'y'] }).ok).toBe(true);
    expect(validateAnswer(b, { questionId: 'q1', blanks: ['x'] }).ok).toBe(false);
    expect(validateAnswer(b, { questionId: 'q1', blanks: ['x', ''] }).ok).toBe(false);
  });

  it('简答：非空即可', () => {
    const s = q({ type: 'short' });
    expect(validateAnswer(s, { questionId: 'q1', essay: '答案是……' }).ok).toBe(true);
    expect(validateAnswer(s, { questionId: 'q1', essay: '  ' }).ok).toBe(false);
  });
});

describe('normalizeAnswer 畸形输出归一化', () => {
  it('字符串 selections → 数组', () => {
    const a = normalizeAnswer({ selections: 'B', confidence: 0.9 }, q({}));
    expect(a.selections).toEqual(['B']);
  });

  it('判断题「正确/错误/√/×」归一化为 对/错', () => {
    const j = q({ type: 'judge', options: [{ key: '对', text: '对', imgUrls: [] }, { key: '错', text: '错', imgUrls: [] }] });
    expect(normalizeAnswer({ selections: ['正确'] }, j).selections).toEqual(['对']);
    expect(normalizeAnswer({ selections: ['×'] }, j).selections).toEqual(['错']);
    expect(normalizeAnswer({ selections: ['F'] }, j).selections).toEqual(['错']);
  });

  it('字符串 blanks 按中英文逗号分号拆分', () => {
    const a = normalizeAnswer({ blanks: '甲，乙;丙' }, q({ type: 'blank', blankCount: 3 }));
    expect(a.blanks).toEqual(['甲', '乙', '丙']);
  });

  it('confidence 越界会被夹回 0~1', () => {
    expect(normalizeAnswer({ selections: ['A'], confidence: 5 }, q({})).confidence).toBe(1);
    expect(normalizeAnswer({ selections: ['A'], confidence: -1 }, q({})).confidence).toBe(0);
  });
});
