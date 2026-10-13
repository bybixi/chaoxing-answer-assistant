import type { ParsedQuestion } from '../../../shared/types/question';
import { humanClick, tick } from './nativeEvents';

export interface FillResult {
  ok: boolean;
  reason?: string;
}

const okR: FillResult = { ok: true };
const noR = (reason: string): FillResult => ({ ok: false, reason });

/**
 * 单选/判断：点 label（而不是直接设 checked），
 * 这样页面自身的事件链会正常触发；点完读回校验。
 */
export async function fillRadio(
  parsed: ParsedQuestion,
  keys: string[],
): Promise<FillResult> {
  if (keys.length !== 1) return noR('单选/判断题只能选一个');
  const opt = parsed.optionInputs.find((o) => o.key === keys[0]);
  if (!opt) return noR(`找不到选项 ${keys[0]} 对应的输入框`);

  const target = (opt.label ?? opt.input) as HTMLElement;
  humanClick(target);
  await tick();

  const inputEl = opt.input as HTMLInputElement;
  if (!inputEl.checked) {
    // 有些页面 label 点击不传导，直接点 input 再试一次
    humanClick(opt.input);
    await tick();
    if (!inputEl.checked) return noR('点击后 radio 未选中');
  }
  return okR;
}
