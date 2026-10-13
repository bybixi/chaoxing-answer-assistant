import type { Answer, ParsedQuestion } from '../../../shared/types/question';
import { fillRadio, type FillResult } from './radio';
import { fillCheckbox } from './checkbox';
import { fillBlanks } from './input';
import { fillUEditor } from './ueditor';

/**
 * 回填分派器（设计文档 D3：按题型白名单分派，每种题型独立实现 + 独立失败原因）。
 */
export async function fillAnswer(
  parsed: ParsedQuestion,
  answer: Answer,
): Promise<FillResult> {
  try {
    switch (parsed.data.type) {
      case 'single':
      case 'judge':
        return await fillRadio(parsed, answer.selections ?? []);
      case 'multiple':
        return await fillCheckbox(parsed, answer.selections ?? []);
      case 'blank':
        return await fillBlanks(parsed, answer.blanks ?? []);
      case 'short':
        return await fillUEditor(parsed, answer.essay ?? '');
      default:
        return { ok: false, reason: '特殊题型暂不支持自动回填，已跳过' };
    }
  } catch (err) {
    return { ok: false, reason: `回填异常: ${(err as Error).message}` };
  }
}
