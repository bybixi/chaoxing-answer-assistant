import type { ParsedQuestion } from '../../../shared/types/question';
import { setNativeValue } from './nativeEvents';
import type { FillResult } from './radio';

/**
 * 填空：按空位顺序用原生 setter 赋值 + 派发事件，然后**读回校验**。
 * 读回不等于原值 → 说明页面吞了值（受控组件/校验拦截），报告失败。
 */
export async function fillBlanks(
  parsed: ParsedQuestion,
  values: string[],
): Promise<FillResult> {
  const inputs = parsed.blankInputs;
  if (inputs.length === 0) return { ok: false, reason: '页面上找不到填空输入框' };
  if (values.length !== inputs.length) {
    return {
      ok: false,
      reason: `空位数不匹配：页面 ${inputs.length} 个，答案 ${values.length} 个`,
    };
  }

  for (let i = 0; i < inputs.length; i++) {
    inputs[i].scrollIntoView({ block: 'center' });
    inputs[i].focus();
    setNativeValue(inputs[i], values[i]);
  }

  // 读回校验
  const bad: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const actual = inputs[i].value.trim();
    const expected = values[i].trim();
    if (actual !== expected) bad.push(i + 1);
  }
  if (bad.length) return { ok: false, reason: `第 ${bad.join(',')} 空的值未生效（可能被页面逻辑改写）` };
  return { ok: true };
}
