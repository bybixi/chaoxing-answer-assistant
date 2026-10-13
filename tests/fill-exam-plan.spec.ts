import { describe, it, expect } from 'vitest';
import { planChoiceClicks } from '../entrypoints/content/fill/exam';

/**
 * 多选题回填的点击计划（真实事故回归测试）
 *
 * 页面 addChoice 是 toggle（再点一次取消）。旧实现"对每个目标无脑点一次"，
 * 在重跑/已手答场景会写错答案：
 *   旧选 {A,C} + 目标 {B} → 点 B 后页面变成 {A,B,C}，而子串校验竟然放行。
 * 正解：先取消不在目标里的，再选中缺的。
 */
describe('planChoiceClicks 选择对齐', () => {
  it('空页面 → 全部要点上，无需取消', () => {
    expect(planChoiceClicks([], ['A'])).toEqual({ toClickOff: [], toClickOn: ['A'] });
    expect(planChoiceClicks([], ['A', 'C'])).toEqual({ toClickOff: [], toClickOn: ['A', 'C'] });
  });

  it('已选出多余项 → 既要取消也要补选（本事故的核心场景）', () => {
    // 旧选 {A,C}、目标 {B}：必须先把 A、C 点掉，再点 B
    expect(planChoiceClicks(['A', 'C'], ['B'])).toEqual({
      toClickOff: ['A', 'C'],
      toClickOn: ['B'],
    });
  });

  it('部分重叠 → 只动差异项', () => {
    expect(planChoiceClicks(['A', 'C'], ['A', 'D'])).toEqual({
      toClickOff: ['C'],
      toClickOn: ['D'],
    });
  });

  it('已与目标一致 → 一个都不点（重跑同一份卷不该把答案点掉）', () => {
    expect(planChoiceClicks(['B'], ['B'])).toEqual({ toClickOff: [], toClickOn: [] });
    expect(planChoiceClicks(['A', 'D'], ['D', 'A'])).toEqual({
      toClickOff: [],
      toClickOn: [],
    });
  });

  it('大小写不敏感（页面 key 与协议 key 大小写可能不一致）', () => {
    expect(planChoiceClicks(['a'], ['A'])).toEqual({ toClickOff: [], toClickOn: [] });
    expect(planChoiceClicks(['a'], ['B'])).toEqual({ toClickOff: ['A'], toClickOn: ['B'] });
  });

  it('不产生重复点击', () => {
    expect(planChoiceClicks(['A', 'a'], ['A'])).toEqual({ toClickOff: [], toClickOn: [] });
  });
});
