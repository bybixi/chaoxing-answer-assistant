import { describe, it, expect } from 'vitest';
import { isAnswerFieldId, matchTypeText } from '../entrypoints/content/parse/exam';

/**
 * 题型文本识别（整卷预览页专用路径 —— 那里没有 #typeName<qid> 隐藏域，
 * 只能从题干徽标 / 分组标题里读题型；识别不出来就会全部被判"未知题型"而留空）
 *
 * 用例取自真实页面快照（tests/fixtures/homework-page.html）。
 */
describe('matchTypeText 题型识别', () => {
  it('识别题干徽标（两种页面形态都有）', () => {
    expect(matchTypeText('(单选题, 16.0 分)')).toBe('single');
    expect(matchTypeText('(多选题, 10.0 分)')).toBe('multiple');
    expect(matchTypeText('(判断题, 5.0 分)')).toBe('judge');
    expect(matchTypeText('(填空题, 4.0 分)')).toBe('blank');
    expect(matchTypeText('(简答题, 10.0 分)')).toBe('short');
    expect(matchTypeText('(名词解释, 4.0 分)')).toBe('short');
  });

  it('识别分组标题', () => {
    expect(matchTypeText('一、 单选题 （共 5 题，80.0 分）')).toBe('single');
    expect(matchTypeText('二、 判断题 （20.0 分）')).toBe('judge');
    expect(matchTypeText('三、 多选题 （共 3 题，30.0 分）')).toBe('multiple');
  });

  it('容忍空格与全角括号', () => {
    expect(matchTypeText('（ 单 选 题 ， 10 分 ）')).toBe('single');
  });

  it('纯分值文本不误判', () => {
    expect(matchTypeText('共 5 题，80.0 分')).toBeNull();
    expect(matchTypeText('16.0')).toBeNull();
    expect(matchTypeText('')).toBeNull();
  });

  it('不把题干里的普通词当题型（调用方只传徽标，不传题干）', () => {
    // 说明：本函数是纯文本匹配，若把整段题干喂进来就会误判 ——
    // 所以 parseCurrentExamQuestion 只传徽标/分组标题，不传 stem。
    expect(matchTypeText('请计算下列各题的结果')).toBeNull(); // 只认"计算题"，不认"计算"
    expect(matchTypeText('已知P(A)=0.3，求P(B)')).toBeNull();
    expect(matchTypeText('计算题, 10.0 分')).toBe('short');
  });
});

/**
 * 答案隐藏域识别（真实事故回归测试）
 *
 * 页面里同时存在：
 *   <input type="hidden" id="answeredView" value="0">        ← 是否已作答的状态标志
 *   <input type="hidden" id="answer884853494" value="">       ← 真正的答案域
 * 用 `input[id^="answer"]` 取第一个会命中 answeredView，
 * 导致校验读到 "0" 而误判"未选上"（实测表现为 8 题全部回填失败）。
 */
describe('isAnswerFieldId 答案域识别', () => {
  it('命中真正的答案域', () => {
    expect(isAnswerFieldId('answer884853494')).toBe(true);
    expect(isAnswerFieldId('answer884853500')).toBe(true);
  });

  it('排除状态标志 answeredView（本次事故的根因）', () => {
    expect(isAnswerFieldId('answeredView')).toBe(false);
    expect(isAnswerFieldId('answer')).toBe(false);
    expect(isAnswerFieldId('answers')).toBe(false);
  });

  it('排除其它同前缀字段', () => {
    expect(isAnswerFieldId('answerSheet')).toBe(false); // 无数字
    expect(isAnswerFieldId('answerCard')).toBe(false);
    expect(isAnswerFieldId('')).toBe(false);
  });
});
