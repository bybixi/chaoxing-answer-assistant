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

  // ── 旧版作业页（**仅适用于真正的旧版页面**）──
  //
  // ⚠️ 2026-10-16 真机实测更正：作业页 `mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork`
  //    用的是**新版结构**（`.questionLi[data]` + `.mark_name` + `.answerBg`/`addChoice`
  //    + `#answer<qid>`），与考试页同一套约定 —— 请走 `parse/exam.ts`，
  //    由 `isExamStylePage()` 自动识别，不要用下面这组选择器。
  //    实测：该页面 `.TiMu` 只有 1 个且是**整个答题区的外层包裹**（内含 8 道题），
  //    原生 input 为 0 → 用这组选择器会把整卷当成 1 道题并全部失败。
  //    下面这批值仍属**未在真机校准**的社区参考值，仅供真正的旧版页面使用。
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
