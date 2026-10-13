import type { ParsedQuestion, Question, QuestionType } from '../../../shared/types/question';
import { SELECTORS, TYPE_PREFIX } from './selectors';

/**
 * 整卷解析：DOM → 纯数据 Question[]（设计文档 §4.1 第②步）。
 * DOM 元素只留在本地 ParsedQuestion 里，**绝不**放进消息。
 */

const TYPE_KEYS: QuestionType[] = ['single', 'multiple', 'judge', 'blank', 'short'];

function detectType(text: string): QuestionType {
  for (let i = 0; i < TYPE_PREFIX.length; i++) {
    if (TYPE_PREFIX[i].test(text)) return TYPE_KEYS[i];
  }
  // 兜底：按结构猜 —— 有 radio 单个 → 判断/单选；有 checkbox → 多选；有文本框 → 填空
  const root = text;
  void root;
  return 'unknown';
}

function detectTypeFromInputs(el: HTMLElement): QuestionType {
  const checkboxes = el.querySelectorAll('input[type=checkbox]').length;
  if (checkboxes > 0) return 'multiple';
  const texts = el.querySelectorAll(SELECTORS.blankInput).length;
  if (texts > 0) return 'blank';
  const radios = el.querySelectorAll('input[type=radio]').length;
  if (radios === 2) return 'judge';
  if (radios > 0) return 'single';
  return 'unknown';
}

/** 稳定题目 id：同一道题在多次解析中必须得到同一个 id。
 *  早期用 `Date.now()` 后缀 → 侦测器重新收集后 id 全变，in-flight 任务的
 *  local 映射查不到 → 静默不回填。这里改用题干内容哈希。 */
function stableId(stem: string, idx: number): string {
  let h = 5381;
  const s = stem.slice(0, 120);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `q${idx}_${(h >>> 0).toString(36)}`;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function extractImages(el: HTMLElement): string[] {
  const urls: string[] = [];
  el.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('http') || src.startsWith('//') || src.startsWith('data:image')) {
      urls.push(src.startsWith('//') ? `https:${src}` : src);
    }
  });
  return [...new Set(urls)];
}

/** 从题干前缀里抠出选项字母（A. / A、 / A： 等） */
function parseOptionKey(text: string): { key: string; text: string } | null {
  const m = text.match(/^\s*([A-Za-z])\s*[.、．:：)]\s*([\s\S]*)$/);
  if (m) return { key: m[1].toUpperCase(), text: cleanText(m[2]) };
  // 判断题通常没有字母前缀，用「对/错」文本本身当 key
  if (/^(对|正确|√)$/.test(text)) return { key: '对', text };
  if (/^(错|错误|×)$/.test(text)) return { key: '错', text };
  return null;
}

export function parseAllQuestions(): ParsedQuestion[] {
  const items = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.questionItem),
  );
  const parsed: ParsedQuestion[] = [];

  items.forEach((el, idx) => {
    const rawTypeText = el.querySelector(SELECTORS.stemBlock)?.textContent ?? '';
    let type = detectType(rawTypeText);
    if (type === 'unknown') type = detectTypeFromInputs(el);

    const stemEl = el.querySelector(SELECTORS.stemBlock);
    const stem = cleanText(stemEl?.textContent ?? el.textContent?.slice(0, 500) ?? '');

    // ── 选项 ──
    const optionInputs: ParsedQuestion['optionInputs'] = [];
    const optionEls = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.optionItem));
    optionEls.forEach((li) => {
      const input = li.querySelector<HTMLInputElement>(SELECTORS.optionInput);
      if (!input) return;
      const textEl = li.querySelector<HTMLElement>(SELECTORS.optionText);
      const rawText = cleanText(textEl?.textContent ?? li.textContent ?? '');
      const kv = parseOptionKey(rawText);
      optionInputs.push({
        key: kv?.key ?? String.fromCharCode(65 + optionInputs.length),
        pageKey: kv?.key ?? String.fromCharCode(65 + optionInputs.length),
        input,
        label: (li.querySelector('label') as HTMLElement | null) ?? li,
      });
    });

    // ── 填空 ──
    const blankInputs = Array.from(
      el.querySelectorAll<HTMLInputElement>(SELECTORS.blankInput),
    );

    // ── UEditor（简答题）──
    let editorId: string | null = null;
    const edEl = el.querySelector<HTMLElement>(SELECTORS.editor);
    if (edEl?.id) editorId = edEl.id;
    // UEditor 常见命名：ueditor_0 / editor_xxx；也尝试从 iframe id 反推
    if (!editorId) {
      const iframe = el.querySelector<HTMLIFrameElement>('iframe[id^="ueditor"], iframe[id^="editor"]');
      if (iframe) editorId = iframe.id.replace(/^ueditor_/, 'ueditor_');
    }

    const question: Question = {
      id: stableId(stem, idx),
      index: idx + 1,
      type,
      stem,
      imgUrls: extractImages(el),
      options: optionInputs.map((o) => ({
        key: o.key,
        text: '',
        imgUrls: extractImages(o.label ?? el),
      })),
      blankCount: blankInputs.length,
    };
    // 选项文本二次提取（带 key 的）
    optionEls.forEach((li, i) => {
      if (!question.options[i]) return;
      const textEl = li.querySelector<HTMLElement>(SELECTORS.optionText);
      const rawText = cleanText(textEl?.textContent ?? li.textContent ?? '');
      const kv = parseOptionKey(rawText);
      question.options[i].text = kv?.text ?? rawText;
    });

    parsed.push({ data: question, element: el, optionInputs, blankInputs, editorId, answerInput: null });
  });

  return parsed;
}
