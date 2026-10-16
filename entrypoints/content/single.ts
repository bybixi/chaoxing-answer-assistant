import { sendToBackground } from '../../shared/messaging';
import type { ParsedQuestion, SolveResult } from '../../shared/types/question';
import { isExamStylePage, parseAllExamQuestions, parseCurrentExamQuestionFromDom } from './parse/exam';
import { parseAllQuestions } from './parse';
import { fillExamChoice } from './fill/exam';
import { fillBlanks } from './fill/input';
import { fillUEditor } from './fill/ueditor';
import { fillAnswer } from './fill';

/**
 * 单题模式：只解答"屏幕上当前这一题"，不跳转、不改动其他题。
 *
 * 用途：整卷跑完后有几道留空/失败，手工定位到那一题点一下即可补答，
 * 不必为了补 1 道题把整卷再跑一遍（10+ 次页面跳转 + 重复调模型）。
 *
 * 两道解析路径：
 *  - 新版考试页（逐题渲染）→ 直接解析当前显示的那道题
 *  - 旧版作业页（整卷） → 取视口中心最近的那道题
 */
export async function solveCurrentQuestion(): Promise<{ ok: boolean; message: string }> {
  // ★ 结构判定：作业页（dowork）与考试页共用同一套结构，都走新版解析
  const exam = isExamStylePage();

  let parsed: ParsedQuestion | null = null;
  if (exam) {
    // 整卷铺开的页面上，「当前题」= 视口中心那道，而不是 document 里第一道
    const containers = document.querySelectorAll('.questionLi[data]').length;
    if (containers > 1) {
      const all = parseAllExamQuestions();
      parsed = pickViewportQuestion(all);
    } else {
      parsed = parseCurrentExamQuestionFromDom()?.parsed ?? null;
    }
  } else {
    parsed = pickViewportQuestion(parseAllQuestions());
  }
  if (!parsed) {
    return { ok: false, message: '没找到屏幕上的题目（页面可能还没渲染完）' };
  }
  if (parsed.data.type === 'unknown') {
    return { ok: false, message: '这一题是特殊题型（连线/排序等），暂不支持' };
  }

  // 交给 SW 求解（图片抓取、思考模式、低置信度复核都在那边）
  let res: SolveResult;
  try {
    res = await sendToBackground('SINGLE_SOLVE', { question: parsed.data });
  } catch (err) {
    return { ok: false, message: `求解失败：${(err as Error).message}` };
  }

  if (!res.answer) {
    return { ok: false, message: `本题留空：${res.reason ?? '模型未给出答案'}` };
  }

  const fill = await fillParsed(parsed, res.answer);
  if (!fill.ok) return { ok: false, message: `回填失败：${fill.reason ?? '未知原因'}` };
  return {
    ok: true,
    message: res.note ? `本题已填（${res.note}）` : '本题已填',
  };
}

/** 整卷页 / 整卷浏览页：取视口中心最近、且可见的那道题 */
function pickViewportQuestion(list: ParsedQuestion[]): ParsedQuestion | null {
  if (!list.length) return null;
  const vh = window.innerHeight;
  const center = vh / 2;
  let best: ParsedQuestion | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of list) {
    const r = p.element.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) continue; // 不在屏幕上
    const dist = Math.abs((r.top + r.bottom) / 2 - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best ?? list[0];
}

/** 按题型分派回填（single / wholePage 共用） */
export async function fillParsed(
  parsed: ParsedQuestion,
  answer: NonNullable<SolveResult['answer']>,
) {
  // 旧版页面才有原生 radio/checkbox；结构化页面（含作业页 dowork）走新版回填
  if (!isExamStylePage()) return await fillAnswer(parsed, answer);
  switch (parsed.data.type) {
    case 'single':
    case 'judge':
    case 'multiple':
      return await fillExamChoice(parsed, answer.selections ?? []);
    case 'blank':
      return await fillBlanks(parsed, answer.blanks ?? []);
    case 'short':
      return await fillUEditor(parsed, answer.essay ?? '');
    default:
      return { ok: false, reason: '特殊题型暂不支持' };
  }
}
