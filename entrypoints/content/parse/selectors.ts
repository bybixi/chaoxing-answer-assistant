/**
 * ★ 选择器与页面结构 —— 2026-10-13 在真实考试页实测更新 ★
 *
 * 实测页面：https://mooc1.chaoxing.com/exam-ans/exam/test/reVersionTestStartNew*（新版考试，逐题渲染）
 * 快照：tests/fixtures/homework-page.html
 *
 * 实测结论：
 *  - 题目容器 .questionLi[data]（data 属性 = 题目ID）
 *  - 题型在隐藏域 #typeName<题目ID>（单选题/多选题/判断题/填空题/简答题）
 *  - 答案在隐藏域 #answer<题目ID>（回填校验的"真相源"）
 *  - 选项是 div（onclick=addChoice），不是原生 radio/checkbox！
 *  - 答题卡 li[data-asq]，onclick=getTheQuestionByStart(index,'0') 逐题切换
 *
 * 旧版作业页（dowork）的结构未实测，保留社区参考值备用。
 */

export const SELECTORS = {
  // ── 新版考试页（实测）──
  examQuestionItem: '.questionLi[data]',
  examStem: '.mark_name',
  examStemTypeBadge: '.colorShallow',
  examOptionList: '.stem_answer',
  examOptionItem: '.answerBg',
  examOptionKey: '.num_option[data]',
  examOptionText: '.answer_p',
  examBlankInput: 'input[type=text]',
  examEditorIframe: 'iframe[id^="ueditor"], iframe[id^="editor"]',

  // ── 旧版作业页（未实测，社区参考值）──
  questionItem: '.TiMu',
  stemBlock: '.Zy_TItle, .fontLabel, .clearfix',
  optionItem: 'ul li, .answerCard li, li.clearfix',
  optionInput: 'input[type=radio], input[type=checkbox]',
  optionText: '.num, .answerBg, span',
  blankInput: 'input[type=text]',
  editor: 'div.edui-editor, script[src*="ueditor"]',
} as const;

/** 判定当前 frame 是否为答题页 */
export const WORK_URL_PATTERN = /exam-ans|reVersionTest|\/work\/|dowork|mooc-ans/i;

/** 从题干前缀识别题型（旧版作业页用） */
export const TYPE_PREFIX: RegExp[] = [
  /【?\(?单选题?\)?】?/,
  /【?\(?多选题?\)?】?/,
  /【?\(?判断题?\)?】?/,
  /【?\(?填空题?\)?】?/,
  /【?\(?简答题?|名词解释|论述题?|计算题?\)?】?/,
];
