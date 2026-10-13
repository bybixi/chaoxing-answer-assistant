import type { ParsedQuestion } from '../../../shared/types/question';
import { humanClick, tick } from './nativeEvents';
import type { FillResult } from './radio';

/**
 * 多选：把页面的选择**对齐**到目标集合。
 *
 * 两个必须处理的点（原生 checkbox 同样会被用户的上一轮作答影响）：
 *  1. 已在目标里的不要重复点 —— 再点一次会**取消**选中；
 *  2. 不在目标里但当前被选中的要显式取消 —— 否则会残留成"多选了"。
 */
export async function fillCheckbox(
  parsed: ParsedQuestion,
  keys: string[],
): Promise<FillResult> {
  if (!keys.length) return { ok: false, reason: '多选题没有可回填的选项' };

  const target = new Set(keys.map((k) => k.toUpperCase()));
  const isChecked = (o: ParsedQuestion['optionInputs'][number]) =>
    (o.input as HTMLInputElement).checked;

  const failed: string[] = [];

  /** 点一下，必要时退回直接点 input；返回是否达到期望状态 */
  const clickTo = async (
    opt: ParsedQuestion['optionInputs'][number],
    want: boolean,
  ): Promise<boolean> => {
    if (isChecked(opt) === want) return true;
    humanClick((opt.label ?? opt.input) as HTMLElement);
    await tick();
    if (isChecked(opt) !== want) {
      humanClick(opt.input);
      await tick();
    }
    return isChecked(opt) === want;
  };

  // 第一轮：先取消多余的，再补上缺的
  for (const opt of parsed.optionInputs) {
    const inTarget = target.has(opt.key.toUpperCase());
    if (!inTarget && isChecked(opt)) await clickTo(opt, false);
  }
  for (const key of keys) {
    const opt = parsed.optionInputs.find((o) => o.key === key);
    if (!opt) {
      failed.push(key);
      continue;
    }
    if (!(await clickTo(opt, true))) failed.push(key);
  }

  // 读回：核对最终选中集合
  const selected = parsed.optionInputs.filter(isChecked).map((o) => o.key);
  const missing = keys.filter((k) => !selected.includes(k));
  const extra = selected.filter((k) => !target.has(k.toUpperCase()));
  if (missing.length || failed.length || extra.length) {
    const parts: string[] = [];
    if (failed.length || missing.length) {
      parts.push(`未选中: ${[...new Set([...failed, ...missing])].join(',')}`);
    }
    if (extra.length) parts.push(`残留多选: ${extra.join(',')}`);
    return { ok: false, reason: `多选回填不完整（${parts.join(' / ')}）` };
  }
  return { ok: true };
}
