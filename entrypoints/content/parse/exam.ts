/**
 * 新版考试页（exam-ans / reVersionTestStartNew）的实测驱动与解析。
 * 结构依据 2026-10-13 真实页面快照（tests/fixtures/homework-page.html）。
 */

import type {
  ParsedQuestion,
  Question,
  QuestionOption,
  QuestionType,
} from '../../../shared/types/question';
import { SELECTORS } from './selectors';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ExamQuestionRef {
  qid: string;
  /** 答题卡中的序号（从 0 开始），也是 getTheQuestionByStart 的入参 */
  index: number;
}

export function isExamPage(): boolean {
  return /exam-ans|reVersionTest/i.test(location.href);
}

/** 从答题卡枚举全部题目 ID（按卷面顺序去重） */
export function listQuestionRefs(): ExamQuestionRef[] {
  const refs: ExamQuestionRef[] = [];
  const seen = new Set<string>();
  document.querySelectorAll<HTMLElement>('li[data-asq]').forEach((li) => {
    const qid = li.getAttribute('data-asq') ?? '';
    if (!qid || seen.has(qid)) return;
    seen.add(qid);
    refs.push({ qid, index: refs.length });
  });
  return refs;
}

/** 直接按 DOM 解析"当前显示的这一题"（单题模式用，自己算答题卡位置） */
export function parseCurrentExamQuestionFromDom(): {
  parsed: ParsedQuestion;
  paperIndex: number;
} | null {
  const el = document.querySelector<HTMLElement>(SELECTORS.examQuestionItem);
  if (!el || !el.querySelector('.mark_name')) return null;
  const qid = el.getAttribute('data') ?? '';
  const lis = Array.from(document.querySelectorAll<HTMLElement>('li[data-asq]'));
  const idx = lis.findIndex((li) => li.classList.contains('current'));
  const paperIndex = idx >= 0 ? idx : 0;
  const parsed = parseCurrentExamQuestion({ qid, index: paperIndex }, el);
  return parsed ? { parsed, paperIndex } : null;
}

/**
 * 是否为新版「结构化」答题页 —— 用于**选择解析器与回填器**。
 *
 * ★ 为什么不能只看 URL（2026-10-16 真机探针确认）：
 *   作业页 `mooc2/work/dowork` 用的是**与考试页完全相同**的 DOM 约定 ——
 *   `.questionLi[data]` 容器、`.mark_name` 题干、`.answerBg` + `addChoice` 选项、
 *   `#answer<qid>` 校验域。早期实现按 URL 判定（只认 `exam-ans`），
 *   于是作业页被判成"旧版" → 走 `.TiMu` 选择器 → 而 `.TiMu` 在那页上
 *   是**整个答题区的外层包裹**（只有一个）→ 整卷被当成 1 道题；
 *   又因该容器内原生 input 为 0 → 选项全丢 → 题型 unknown →
 *   「特殊题型暂不支持」→ 表现为"有反应但全部失败"。
 *
 * ⚠️ 这里**只判断 DOM 约定**，不判断"逐题还是整卷" —— 后者由
 *   `detectPageShape()`（看答题卡 `li[data-asq]`）负责。
 *   逐题考试页同样属于本结构，不能因为"有答题卡"就判否。
 */
export function isExamStylePage(): boolean {
  return document.querySelectorAll('.questionLi[data] .mark_name').length > 0;
}

/**
 * 枚举页面上所有可能的题目容器。
 *
 * ★ 必须被 `parseAllExamQuestions` 与 `detectPageShape` **共用同一口径**：
 *   早期两处各写一套（形态判定只数 `.questionLi[data]`，解析还兜底 `.questionLi`），
 *   导致整卷预览页"形态判定 total=0、而解析其实找得到题" →
 *   被误判进逐题模式，报"答题卡里没有找到题目"。
 */
function collectQuestionContainers(): HTMLElement[] {
  const set = new Set<HTMLElement>();
  document
    .querySelectorAll<HTMLElement>(
      `${SELECTORS.examQuestionItem}, .questionLi, ${SELECTORS.questionItem}`,
    )
    .forEach((el) => set.add(el));

  const valid = [...set].filter(
    (el) =>
      el.querySelector('.mark_name') !== null ||
      el.querySelector(SELECTORS.examOptionItem) !== null ||
      el.querySelector('[onclick*="addChoice"]') !== null ||
      el.querySelector('input[type=radio], input[type=checkbox], input[type=text]') !== null,
  );

  // ★ 剔除「包裹型容器」：内部还含其它候选容器的元素只是外层包装，不是单题。
  //   作业页实测：`div.fanyaMarking.TiMu` 包着 8 个 `.questionLi`，
  //   若不剔除，题数会从 8 虚增到 9。
  return valid.filter((el) => !valid.some((other) => other !== el && el.contains(other)));
}

/** 解析页面上**所有**题目容器（整卷浏览/预览页：题目一次性全铺在同一页） */
export function parseAllExamQuestions(): ParsedQuestion[] {
  const els = collectQuestionContainers();
  const seenQid = new Set<string>();
  const out: ParsedQuestion[] = [];
  els.forEach((el, i) => {
    const parsed = parseCurrentExamQuestion(
      { qid: el.getAttribute('data') ?? `idx${i}`, index: i },
      el,
    );
    if (!parsed) return;
    if (seenQid.has(parsed.data.id)) return; // 去掉重复容器（如 .questionLi 与 .TiMu 同时命中）
    seenQid.add(parsed.data.id);
    parsed.data.index = out.length + 1; // 重新编号，避免出现空洞
    out.push(parsed);
  });
  return out;
}

/** 侧栏/答题卡里声明的题目总数（用来和实际解析到的数量比对，发现"漏题"） */
export function countDeclaredQuestions(): number {
  const ids = new Set<string>();
  document
    .querySelectorAll<HTMLElement>('li[data-asq], .topicNumber_list li')
    .forEach((li) => {
      const key = li.getAttribute('data-asq') ?? li.textContent?.trim() ?? '';
      if (key) ids.add(key);
    });
  return ids.size;
}

/**
 * 页面形态判定 + 诊断信息（诊断会显示在浮球上，便于远程定位问题）。
 *
 * 判定顺序很重要 —— 逐题模式是我们的主路径，必须优先保住：
 *  1. 有答题卡 li[data-asq] → 逐题模式（考试答题页的签名结构）
 *  2. 题目容器 > 1 → 整卷铺开（整卷预览页）
 *  3. 只有 1 个容器且无答题卡 → 退化为"就地作答这一题"（整卷路径 N=1）
 */
export function detectPageShape(): { mode: 'paged' | 'whole'; total: number; diag: string } {
  // 与 parseAllExamQuestions 共用容器口径，避免"判定说 0 题、解析却能找到题"
  const containers = collectQuestionContainers().length;
  const cardItems = document.querySelectorAll('li[data-asq]').length;
  const hasNextBtn = !!document.querySelector(
    '.nextDiv a, [onclick*="getTheNextQuestion"]',
  );
  const diag = `容器 ${containers} / 答题卡 ${cardItems} / 下一题按钮 ${hasNextBtn ? '有' : '无'}`;

  if (cardItems > 0) {
    return { mode: 'paged', total: Math.max(cardItems, containers), diag };
  }
  return { mode: 'whole', total: containers, diag };
}

const TYPE_MAP: Record<string, QuestionType> = {
  单选题: 'single',
  多选题: 'multiple',
  判断题: 'judge',
  填空题: 'blank',
  简答题: 'short',
  名词解释: 'short',
  论述题: 'short',
  计算题: 'short',
};

/**
 * 题型判定（三重来源，逐级兜底）——整卷预览页没有 data 属性、也就查不到
 * #typeName<qid> 隐藏域，所以绝不能只依赖它。
 *  1. 题干上的题型徽标，如「(单选题, 16.0 分)」  ← 两种页面都有，最可靠
 *  2. 隐藏域 #typeName<qid>
 *  3. 结构推断（checkbox / 文本框 / 富文本 / 两个对错选项）
 */
function resolveType(el: HTMLElement, qid: string, badgeText: string): QuestionType {
  const fromBadge = matchTypeText(badgeText);
  if (fromBadge) return fromBadge;

  const hidden = (el.querySelector(`#typeName${qid}`) as HTMLInputElement | null)?.value ?? '';
  if (TYPE_MAP[hidden]) return TYPE_MAP[hidden];

  // 结构推断
  if (el.querySelector('input[type=checkbox]')) return 'multiple';
  const visibleTextInputs = Array.from(
    el.querySelectorAll<HTMLInputElement>('input[type=text]'),
  ).filter((i) => !i.id.startsWith('answer') && i.offsetParent !== null);
  if (visibleTextInputs.length > 0) return 'blank';
  if (el.querySelector('textarea') || el.querySelector('iframe[id^="ueditor"]')) return 'short';
  const optCount = el.querySelectorAll(SELECTORS.examOptionItem).length;
  if (optCount === 2 && /(对|错|正确|错误)/.test(el.textContent ?? '')) return 'judge';
  if (optCount >= 2) return 'single';
  return 'unknown';
}

export function matchTypeText(text: string): QuestionType | null {
  if (/多\s*选/.test(text)) return 'multiple';
  if (/判\s*断/.test(text)) return 'judge';
  if (/填\s*空/.test(text)) return 'blank';
  if (/简\s*答|名词解释|论述|计算题/.test(text)) return 'short';
  if (/单\s*选/.test(text)) return 'single';
  return null;
}

function extractImgs(el: HTMLElement): string[] {
  const urls: string[] = [];
  el.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? img.getAttribute('data-original') ?? '';
    if (src.startsWith('http') || src.startsWith('//') || src.startsWith('data:image')) {
      urls.push(src.startsWith('//') ? `https:${src}` : src);
    }
  });
  return [...new Set(urls)];
}

/**
 * 定位某道题的答案隐藏域。
 *
 * ⚠️ 踩过的坑：不能用 `input[id^="answer"]` 直接取第一个 —— 页面里还有
 * `#answeredView`（是否已作答的状态标志，值恒为 0），会被误命中，
 * 导致校验读到 0 而误判"未选上"。所以必须要求 id 形如 answer<数字/字母>。
 */
export function isAnswerFieldId(id: string): boolean {
  return /^answer[0-9A-Za-z_]*\d/.test(id);
}

function findAnswerInput(el: HTMLElement, qid: string): HTMLInputElement | null {
  if (qid) {
    const exact =
      el.querySelector<HTMLInputElement>(`input[id="answer${qid}"]`) ??
      (document.getElementById(`answer${qid}`) as HTMLInputElement | null);
    if (exact) return exact;
  }
  return (
    [...el.querySelectorAll<HTMLInputElement>('input')].find((i) =>
      isAnswerFieldId(i.id),
    ) ?? null
  );
}

export function parseCurrentExamQuestion(
  ref: ExamQuestionRef,
  el: HTMLElement,
): ParsedQuestion | null {
  // 题目 ID：容器 data 属性 → 答案隐藏域 id → 合成（整卷预览页可能两者都没有）
  const seedAnswer = findAnswerInput(el, '');
  let qid = el.getAttribute('data') ?? '';
  if (!qid && seedAnswer?.id) qid = seedAnswer.id.replace(/^answer/, '');
  if (!qid) qid = `idx${ref.index}`;
  const answerInput = findAnswerInput(el, qid);

  // 题干：.mark_name 去掉题号前缀；题型徽标要**先读出来**再删
  let stem = '';
  let badgeTextRef = '';
  const stemEl = el.querySelector(SELECTORS.examStem);
  if (stemEl) {
    // 题目标识**只**从题型徽标 / 分组标题里读，绝不用整段题干 ——
    // 否则题干里出现"判断""单选"这类词就会误判题型
    let badgeText = stemEl.querySelector(SELECTORS.examStemTypeBadge)?.textContent ?? '';
    if (!badgeText) {
      const tit =
        el.querySelector('.type_tit') ??
        el.previousElementSibling?.querySelector('.type_tit') ??
        null;
      badgeText = tit?.textContent ?? '';
    }
    badgeTextRef = badgeText;

    const clone = stemEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(SELECTORS.examStemTypeBadge).forEach((s) => s.remove());
    stem = (clone.textContent ?? '')
      .replace(/^\s*\d+\s*[.、．]?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 整卷铺开时题干可能只是一个 div，兜底取容器文本前 300 字
  if (!stem) {
    stem = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  const type = resolveType(el, qid, badgeTextRef);

  // 选项：div.answerBg，key 在 span[data]，文本在 .answer_p
  // 整卷预览页可能是另一套类名 → 退一步用「绑定了 addChoice 的元素」作为选项
  let optEls = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.examOptionItem));
  if (optEls.length === 0) {
    optEls = Array.from(el.querySelectorAll<HTMLElement>('[onclick*="addChoice"]'));
  }

  const optionInputs: ParsedQuestion['optionInputs'] = [];
  const options: QuestionOption[] = [];
  optEls.forEach((optEl, i) => {
    const keySpan = optEl.querySelector<HTMLElement>(SELECTORS.examOptionKey) ?? optEl;
    const keyText = (keySpan.textContent ?? '').trim();
    let pageKey = (keySpan.getAttribute('data') ?? '').trim();
    if (!pageKey && /^[A-Za-z]$/.test(keyText)) pageKey = keyText.toUpperCase();
    if (!pageKey && /^(对|错|正确|错误|√|×)$/.test(keyText)) pageKey = keyText;
    if (!pageKey) pageKey = String.fromCharCode(65 + i); // 最后的兜底：按顺序给字母

    let text = (optEl.querySelector(SELECTORS.examOptionText)?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) text = (optEl.textContent ?? '').replace(/\s+/g, ' ').trim();

    // 判断题：我们协议里统一用「对/错」，映射页面可能的 A/B/对/错
    let key = pageKey;
    if (type === 'judge') {
      if (/^(对|正确|√)/.test(text) || /^A$/i.test(pageKey) || pageKey === '正确') key = '对';
      else if (/^(错|错误|×)/.test(text) || /^B$/i.test(pageKey)) key = '错';
    }

    optionInputs.push({ key, pageKey, input: keySpan, label: optEl });
    options.push({ key, text, imgUrls: extractImgs(optEl) });
  });

  // 填空：可见的文本输入框（排除隐藏的 answer/system 域）
  const blankInputs =
    type === 'blank'
      ? Array.from(el.querySelectorAll<HTMLInputElement>(SELECTORS.examBlankInput)).filter(
          (inp) =>
            !inp.id.startsWith('answer') &&
            !inp.name.startsWith('answer') &&
            inp.offsetParent !== null,
        )
      : [];

  // 简答：UEditor 的 iframe id
  let editorId: string | null = null;
  if (type === 'short') {
    const iframe = el.querySelector<HTMLIFrameElement>(SELECTORS.examEditorIframe);
    if (iframe) editorId = iframe.id;
  }

  const question: Question = {
    id: qid,
    index: ref.index + 1,
    type,
    stem,
    imgUrls: extractImgs((stemEl as HTMLElement) ?? el),
    options,
    blankCount: type === 'blank' ? Math.max(1, blankInputs.length) : 0,
  };

  return { data: question, element: el, optionInputs, blankInputs, editorId, answerInput };
}
