import type { ParsedQuestion } from '../../../shared/types/question';
import { humanClick, tick } from './nativeEvents';
import type { FillResult } from './radio';
import { isAnswerFieldId } from '../parse/exam';

/** 是否处于"已选中"态：页面自己的 addChoice 会给选中项加 check_answer 类 */
function isMarked(el: HTMLElement): boolean {
  if (el.classList.contains('check_answer')) return true;
  return !!el.querySelector('.check_answer');
}

/**
 * 计算点击计划：把页面的当前选择**对齐**到目标选择。
 *
 * 为什么必须有这一步：页面 addChoice 是 **toggle**（再点一次会取消）。
 * 早期实现"对每个目标无脑点一次"，在两种真实场景下会把答案写错：
 *   1. 重跑 / 用户已手答 → 已选中的目标被点掉；
 *   2. 多选题残留 → 旧选 {A,C}、目标 {B}，点完页面变成 {A,B,C}。
 * 因此必须先取消不在目标内的、再选中目标内未选的。
 *
 * 抽成纯函数是为了可单测（见 tests/fill-exam-plan.spec.ts）。
 */
export function planChoiceClicks(
  currentKeys: string[],
  targetKeys: string[],
): { toClickOff: string[]; toClickOn: string[] } {
  const cur = new Set(currentKeys.map((k) => k.toUpperCase()));
  const tgt = new Set(targetKeys.map((k) => k.toUpperCase()));
  return {
    toClickOff: [...cur].filter((k) => !tgt.has(k)),
    toClickOn: [...tgt].filter((k) => !cur.has(k)),
  };
}

/**
 * 新版考试页的回填（2026-10-13 实测）。
 *
 * 页面机制（读源码确认）：addChoice = 纯 jQuery，toggle check_answer 类 →
 * 把选中项的 data 属性拼进 #answer<qid>。**不检查 isTrusted**。
 *
 * 回填策略（按可靠性排序）：
 *  1. 直调 window.addChoice(选项容器) —— 页面自己的函数，最可靠
 *  2. 合成点击（humanClick）—— 直调不可用时
 * 校验真相源：#answer<qid> 非空且包含所选选项的 pageKey。
 */
export async function fillExamChoice(
  parsed: ParsedQuestion,
  keys: string[],
): Promise<FillResult> {
  const qid = parsed.data.id;
  if (!keys.length) return { ok: false, reason: '没有可回填的选项' };

  // 目标选项：key → 页面元素/pageKey
  const optByKey = new Map<string, { el: HTMLElement; pageKey: string }>();
  for (const key of keys) {
    const opt = parsed.optionInputs.find((o) => o.key === key);
    if (!opt) return { ok: false, reason: `页面上找不到选项 ${key}` };
    optByKey.set(opt.key.toUpperCase(), {
      el: (opt.label ?? opt.input) as HTMLElement,
      pageKey: opt.pageKey,
    });
  }
  const targetUpper = [...optByKey.keys()];

  const readAnswer = () => {
    // 优先按 id 精确查（逐题页：#answer<qid>；注意别误取 #answeredView）
    const byId = isAnswerFieldId(`answer${qid}`)
      ? (document.getElementById(`answer${qid}`) as HTMLInputElement | null)
      : null;
    const el = byId ?? parsed.answerInput;
    return el?.value?.trim() ?? '';
  };

  /** 当前页面上处于选中态的选项 key（协议 key，大写比较） */
  const readMarked = (): string[] =>
    parsed.optionInputs
      .filter((o) => isMarked((o.label ?? o.input) as HTMLElement))
      .map((o) => o.key.toUpperCase());

  const w = window as unknown as { addChoice?: (el: HTMLElement) => void };
  const canDirect = typeof w.addChoice === 'function';
  const hasAnswerField = !!(
    (qid && document.getElementById(`answer${qid}`)) ||
    parsed.answerInput
  );

  const clickOption = async (upperKey: string) => {
    const t = optByKey.get(upperKey);
    if (!t) return;
    if (canDirect) {
      try {
        w.addChoice!(t.el);
      } catch {
        humanClick(t.el);
      }
    } else {
      humanClick(t.el);
    }
    await tick();
  };

  // 第一轮：对齐状态（先取消多余的，再补上缺的）
  const first = planChoiceClicks(readMarked(), targetUpper);
  for (const k of first.toClickOff) await clickOption(k);
  for (const k of first.toClickOn) await clickOption(k);

  /**
   * 校验（真相源优先，选中态兜底）：
   *  - 有答案域且非空：单选/判断要求**完全等于**目标的 pageKey；
   *    多选要求"包含所有目标 pageKey" **且** "没有任何非目标选项仍处于选中态"
   *    —— 后者正是为了拦住 {A,C}→目标{B} 残留成 {A,B,C} 的情况。
   *  - 没有答案域（整卷预览页）：退回选中态校验，同样要求非目标项未被选中。
   */
  const verify = (): FillResult => {
    const value = readAnswer();
    const marked = readMarked();
    const nonTargetMarked = marked.filter((k) => !targetUpper.includes(k));

    if (value && hasAnswerField) {
      const v = value.toUpperCase();
      if (parsed.data.type !== 'multiple') {
        const pk = (optByKey.get(targetUpper[0])?.pageKey ?? '').toUpperCase();
        return v === pk
          ? { ok: true }
          : { ok: false, reason: `answer 值「${value}」与目标 ${pk} 不一致` };
      }
      const missing = targetUpper
        .map((k) => (optByKey.get(k)?.pageKey ?? '').toUpperCase())
        .filter((pk) => !v.includes(pk));
      if (missing.length === 0 && nonTargetMarked.length === 0) return { ok: true };
      return {
        ok: false,
        reason:
          missing.length > 0
            ? `answer 值「${value}」未包含 ${missing.join(',')}，可能未选上`
            : `answer 值「${value}」包含未勾选的选项（页面残留 ${nonTargetMarked.join(',')}）`,
      };
    }

    // 无答案域：以选中态为准
    if (nonTargetMarked.length > 0) {
      return { ok: false, reason: `存在非目标选项仍被选中：${nonTargetMarked.join(',')}` };
    }
    const allMarked = targetUpper.every((k) => marked.includes(k));
    if (allMarked) return { ok: true };
    return {
      ok: false,
      reason: hasAnswerField
        ? `点击后 #answer${qid} 仍为空（addChoice 与合成点击都未生效）`
        : '点击后选项未变为选中态（页面可能不允许在此模式作答）',
    };
  };

  let result = verify();
  if (result.ok) return result;

  // 第二轮：按最新选中态再对齐一次，然后重验
  const second = planChoiceClicks(readMarked(), targetUpper);
  for (const k of second.toClickOff) await clickOption(k);
  for (const k of second.toClickOn) await clickOption(k);

  result = verify();
  return result.ok ? result : result;
}
