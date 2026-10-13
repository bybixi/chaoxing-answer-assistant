import type { Answer, Question } from '../types/question';

export interface ValidateResult {
  ok: boolean;
  reason?: string;
}

const ok: ValidateResult = { ok: true };
const no = (reason: string): ValidateResult => ({ ok: false, reason });

/**
 * 本地答案校验（设计文档 §5.6 第二道关，最关键）。
 *
 * 规则：答案的形状必须与题型、选项集合、空位数严格吻合。
 * 这是「尽量不要打错」的主要防线 —— 格式都不对的答案绝不允许回填。
 */
export function validateAnswer(q: Question, a: Answer | null): ValidateResult {
  if (!a) return no('答案为空');

  switch (q.type) {
    case 'single': {
      if (!a.selections || a.selections.length !== 1)
        return no('单选题必须且只能选一个选项');
      if (!q.options.some((o) => o.key === a.selections![0]))
        return no(`选项 ${a.selections[0]} 不在本题的选项列表中`);
      return ok;
    }

    case 'multiple': {
      if (!a.selections || a.selections.length === 0)
        return no('多选题至少要选一个选项');
      const bad = a.selections.filter((k) => !q.options.some((o) => o.key === k));
      if (bad.length > 0) return no(`选项 ${bad.join(',')} 不在本题的选项列表中`);
      return ok;
    }

    case 'judge': {
      if (!a.selections || a.selections.length !== 1)
        return no('判断题必须且只能选一个（对/错）');
      if (!q.options.some((o) => o.key === a.selections![0]))
        return no('判断题答案只能是「对」或「错」');
      return ok;
    }

    case 'blank': {
      const n = q.blankCount > 0 ? q.blankCount : 1;
      if (!a.blanks || a.blanks.length !== n)
        return no(`本题有 ${n} 个空，你给出了 ${a.blanks?.length ?? 0} 个答案`);
      if (a.blanks.some((b) => !b || !b.trim())) return no('存在空的填空项');
      return ok;
    }

    case 'short': {
      if (!a.essay || a.essay.trim().length < 2) return no('简答题答案过短或为空');
      return ok;
    }

    default:
      return no('未知题型，无法校验');
  }
}

/**
 * 判断两份答案是否等价（用于复核结论比照）。
 * 判断题/单选题看选项集合，填空题看逐空文本，简答题看去空白后的文本。
 */
export function isSameAnswer(a: Answer, b: Answer, type: Question['type']): boolean {
  const norm = (arr?: string[]) =>
    [...(arr ?? [])].map((s) => String(s).trim().toLowerCase()).sort().join('|');
  switch (type) {
    case 'single':
    case 'multiple':
    case 'judge':
      return norm(a.selections) === norm(b.selections);
    case 'blank':
      return norm(a.blanks) === norm(b.blanks);
    case 'short':
      return (a.essay ?? '').replace(/\s+/g, '') === (b.essay ?? '').replace(/\s+/g, '');
    default:
      return false;
  }
}

/**
 * 把模型输出的宽松 JSON 规范化成 Answer。
 * 兼容常见畸形：answers/blanks/essay 字段名漂移、selections 给成字符串、判断题给「正确/错误/√/×」等。
 */
export function normalizeAnswer(
  raw: Record<string, unknown>,
  q: Question,
): Answer {
  const answer: Answer = { questionId: q.id };

  // 缺省 0.5（而不是 1）：模型没给把握度时按"半信半疑"处理，
  // 让 settings.minConfidence 这道关仍然能拦住它 —— 与"宁空不错"一致。
  const conf = Number(raw.confidence ?? raw.score ?? 0.5);
  answer.confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5;

  const sel = (raw.selections ?? raw.selected ?? raw.answer ?? raw.choice) as unknown;
  if (typeof sel === 'string') answer.selections = [sel.trim()];
  else if (Array.isArray(sel)) answer.selections = sel.map((s) => String(s).trim());

  const blanks = (raw.blanks ?? raw.fills ?? raw.answers) as unknown;
  if (Array.isArray(blanks)) answer.blanks = blanks.map((b) => String(b ?? '').trim());
  else if (typeof blanks === 'string' && blanks.trim())
    answer.blanks = blanks.split(/[,，;；]/).map((s) => s.trim());

  const essay = (raw.essay ?? raw.text ?? raw.answerText) as unknown;
  if (typeof essay === 'string') answer.essay = essay;

  // 判断题归一化：把「正确/错误/√/×/T/F/true/false」统一成 对/错
  if (q.type === 'judge' && answer.selections?.length === 1) {
    const s = answer.selections[0];
    if (/^(对|正确|√|T|true|A)$/i.test(s)) answer.selections = ['对'];
    else if (/^(错|错误|×|x|F|false|B)$/i.test(s)) answer.selections = ['错'];
  }

  return answer;
}
