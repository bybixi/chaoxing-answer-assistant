/**
 * 题目与答案的纯数据结构。
 *
 * 重要约定：这些对象会通过 chrome.runtime 消息传递，
 * 因此**绝对不能包含 DOM 节点**（消息要求可 structured-clone）。
 * 内容脚本在本地维护 questionId → 页面元素 的映射。
 */

export type QuestionType =
  | 'single'   // 单选
  | 'multiple' // 多选
  | 'judge'    // 判断
  | 'blank'    // 填空
  | 'short'    // 简答
  | 'unknown'; // 连线/排序/完形填空等特殊题型，首版降级处理

export const TYPE_LABEL: Record<QuestionType, string> = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  blank: '填空题',
  short: '简答题',
  unknown: '其他题型',
};

export interface QuestionOption {
  /** 选项标识：A / B / C / D，判断题为「对」「错」 */
  key: string;
  /** 选项文本（图片选项时为空） */
  text: string;
  /** 选项内图片 */
  imgUrls: string[];
}

/** 纯数据题目（可安全跨消息传输） */
export interface Question {
  id: string;
  /** 卷面题号 */
  index: number;
  type: QuestionType;
  stem: string;
  /** 题干中的图片 */
  imgUrls: string[];
  options: QuestionOption[];
  /** 填空题空位数 */
  blankCount: number;
}

/** 纯数据答案 */
export interface Answer {
  questionId: string;
  /** 单选/多选/判断：命中的选项 key 列表 */
  selections?: string[];
  /** 填空：按空位顺序 */
  blanks?: string[];
  /** 简答 */
  essay?: string;
  /** 模型自报的把握度 0~1 */
  confidence?: number;
}

/** 求解结果（SW 返回给内容脚本） */
export interface SolveResult {
  /** null = 不填（留空） */
  answer: Answer | null;
  reason?: string;
  /** 需要告知用户的补充说明（如"低置信度已复核确认"），会显示在浮球的原因列表里 */
  note?: string;
}

/** 解析后的本地题目（含元素引用，只在内容脚本内存中存在） */
export interface ParsedQuestion {
  data: Question;
  element: HTMLElement;
  /**
   * 每个选项的可点击元素与标识。
   * key 是我们协议里的标识（判断题统一为「对/错」）；
   * pageKey 是页面上真实的 data 属性值（考试页可能是 A/B）。
   */
  optionInputs: {
    key: string;
    pageKey: string;
    input: HTMLElement;
    label: HTMLElement | null;
  }[];
  /** 填空题的输入框（按空位顺序） */
  blankInputs: HTMLInputElement[];
  /** 简答题的 UEditor 编辑器 id（若可探测） */
  editorId: string | null;
  /** 该题的答案隐藏域（整卷预览页可能没有全局 id 可查，所以直接留引用） */
  answerInput: HTMLInputElement | null;
}
