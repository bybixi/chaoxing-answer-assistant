import { sendToBackground, onMessage } from '../../shared/messaging';
import type { Answer, ParsedQuestion, Question } from '../../shared/types/question';
import { isExamPage, listQuestionRefs, parseCurrentExamQuestion } from './parse/exam';
import { fillExamChoice } from './fill/exam';
import { fillBlanks } from './fill/input';
import { fillUEditor } from './fill/ueditor';

/**
 * 新版考试页「无状态工人」（配合 SW 指挥所，见 background.ts）。
 *
 * 关键事实：考试页每切一题就整页跳转（getTheQuestionByStart → location.href=&start=N），
 * 本文件每次页面加载都会重新执行一遍。所以这里**不持有任何跨题状态**：
 *   - 收到 PARSE → 解析当前题 → 上报 → 按 SW 指令切下一题（本页面随之销毁）
 *   - 收到 FILL  → 取答案 → 回填 + 读回校验 → 上报结果 → 切下一题
 * 循环靠「页面刷新 + SW 续命」自然推进。
 */
export function startExamEngine(): void {
  if (!isExamPage()) return;

  /**
   * 防重入：页面加载慢时，SW 的 HELLO 补发与上一步遗留可能双发 PARSE/FILL，
   * 导致双跳转、navCount 虚高、计数错乱。处理中就忽略新指令。
   */
  let busy = false;

  // 报到；若 SW 侧 run 进行中，会立刻收到 WORK_STEP（跨导航续命）
  void sendToBackground('WORK_HELLO', undefined).catch(() => {});

  onMessage('WORK_STEP', async (cmd) => {
    if (busy) return { ok: true };
    busy = true;
    try {
      if (cmd.cmd === 'PARSE') await doParse(cmd.cursor);
      else if (cmd.cmd === 'FILL') await doFill(cmd.cursor);
    } finally {
      // 正常路径下本页面即将被导航销毁；导航失败时才会走到这里，恢复可接受新指令
      busy = false;
    }
    return { ok: true };
  });

  // ── 工具 ──

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** 等当前题渲染完成（刚导航完时 DOM 可能还没就绪） */
  async function currentEl(): Promise<HTMLElement | null> {
    for (let i = 0; i < 30; i++) {
      const el = document.querySelector<HTMLElement>('.questionLi[data]');
      if (el?.querySelector('.mark_name')) return el;
      await sleep(150);
    }
    return null;
  }

  /**
   * 切到答题卡上的第 index 题（调用后整页跳转，本上下文即将销毁）。
   *
   * ⚠️ 只有 li.click() 一条路可走：内容脚本跑在 **isolated world**，
   * `window.getTheQuestionByStart` 是页面 MAIN world 的函数，这里恒为 undefined
   * ——早期代码写了这条"主分支"其实永远不可达，属死代码，已删除。
   *
   * 答题卡缺项时**必须上报**：早期 `li?.click()` 在 li 为 undefined 时是静默无操作，
   * 表现为整卷卡死且没有任何提示。
   */
  async function navigateTo(index: number): Promise<void> {
    const li = document.querySelectorAll<HTMLElement>('li[data-asq]')[index];
    if (!li) {
      await sendToBackground('FILL_RESULT', {
        qid: 'nav_fail',
        kind: 'failed',
        reason: `答题卡上找不到第 ${index + 1} 项，无法切题（当前题未处理）`,
      }).catch(() => {});
      return;
    }
    li.click();
  }

  /** 解析失败也要上报占位题，否则 collect 循环会卡死在 cursor 不动 */
  function placeholder(qid: string, cursor: number): Question {
    return {
      id: qid || `unknown_${cursor}`,
      index: cursor + 1,
      type: 'unknown',
      stem: '',
      imgUrls: [],
      options: [],
      blankCount: 0,
    };
  }

  /** 答题卡上当前题的实际位置（li.current 的下标）—— 不依赖从第 1 题开始 */
  function currentPaperIndex(): number {
    const lis = Array.from(document.querySelectorAll<HTMLElement>('li[data-asq]'));
    const idx = lis.findIndex((li) => li.classList.contains('current'));
    return idx >= 0 ? idx : 0;
  }

  // ── 第一步：解析当前题并上报 ──
  async function doParse(cursor: number): Promise<void> {
    const el = await currentEl();
    const totalInPaper = listQuestionRefs().length;
    const qid = el?.getAttribute('data') ?? '';
    const paperIndex = currentPaperIndex();
    const parsed: ParsedQuestion | null = el ? parseCurrentExamQuestion({ qid, index: paperIndex }, el) : null;

    const res = await sendToBackground('QUESTION_PARSED', {
      question: parsed?.data ?? placeholder(qid, cursor),
      totalInPaper,
      paperIndex,
    }).catch(() => ({ goto: null as number | null }));

    if (res.goto != null) await navigateTo(res.goto);
    // goto == null：采集结束，SW 自己进入 solve 阶段
  }

  // ── 第二步：回填当前题 ──
  async function doFill(cursor: number): Promise<void> {
    const el = await currentEl();
    if (!el) {
      await sendToBackground('FILL_RESULT', { qid: `unknown_${cursor}`, kind: 'failed', reason: '题目容器未渲染' }).catch(() => {});
      return;
    }
    const qid = el.getAttribute('data') ?? '';
    const paperIndex = currentPaperIndex();
    const req = await sendToBackground('FILL_REQUEST', { qid, paperIndex }).catch(() => ({ answer: null as null, reason: '通信失败', goto: null as number | null }));

    if (req.answer) {
      const parsed = parseCurrentExamQuestion({ qid, index: cursor }, el);
      if (parsed) {
        const r = await fillOne(parsed, req.answer as Answer);
        await sendToBackground('FILL_RESULT', { qid, kind: r.ok ? 'filled' : 'failed', reason: r.reason }).catch(() => {});
      } else {
        await sendToBackground('FILL_RESULT', { qid, kind: 'failed', reason: '回填阶段解析失败' }).catch(() => {});
      }
    } else {
      await sendToBackground('FILL_RESULT', { qid, kind: 'empty', reason: req.reason }).catch(() => {});
    }

    if (req.goto != null) await navigateTo(req.goto);
  }

  async function fillOne(parsed: ParsedQuestion, answer: Answer) {
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
        return { ok: false as const, reason: '特殊题型暂不支持，已跳过' };
    }
  }
}
