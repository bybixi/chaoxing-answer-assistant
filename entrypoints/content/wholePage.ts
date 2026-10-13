import { sendToBackground } from '../../shared/messaging';
import { Scheduler } from '../../scheduler';
import { TYPE_PRIORITY } from '../../shared/constants';
import { getSettings } from '../../shared/storage';
import type { RunState } from '../../shared/types/messages';
import type { ParsedQuestion, SolveResult } from '../../shared/types/question';
import { isExamPage, parseAllExamQuestions, countDeclaredQuestions } from './parse/exam';
import { parseAllQuestions } from './parse';
import { fillParsed } from './single';
import { materializeWholePage } from './materialize';

/**
 * 「整卷铺开」模式：题目全部渲染在同一个页面上（学习通「整卷预览/浏览」），
 * 没有答题卡、不能逐题跳转 —— 那就**就地作答**，一道题都不需要跳转。
 *
 * 这条路径同时兼容：
 *  - 新版考试的整卷预览页（多个 .questionLi[data] 并存）
 *  - 旧版作业页的整卷渲染（多个 .TiMu 并存）
 *
 * 状态广播复用 ENGINE_STATE，经 SW 转发给浮球，界面与逐题模式完全一致。
 */

let cancelled = false;
let running = false;
/** 当前正在跑的调度器：停止时必须真正 stop 掉，否则剩余任务会继续发请求（继续花钱） */
let activeScheduler: Scheduler<SolveResult> | null = null;

export function stopWholePage(): void {
  cancelled = true;
  activeScheduler?.stop();
}

/** 是否已有整卷任务在跑（防止连点「开始」把计数器冲掉，看起来像卡住） */
export function isWholePageRunning(): boolean {
  return running;
}

export async function runWholePage(): Promise<void> {
  if (running) return; // 连点保护
  running = true;
  cancelled = false;
  try {
    await runWholePageInner();
  } finally {
    running = false;
    activeScheduler = null;
  }
}

async function runWholePageInner(): Promise<void> {

  const exam = isExamPage();

  // ★ 先滚动催熟：整卷页的题目多为懒渲染，没滚到的部分 DOM 里不存在，
  //   直接解析就会"漏题"（实测同一份卷子不同时候能解析到 8 / 10 题不等）
  await broadcast({
    active: true,
    phase: 'solve',
    cursor: 0,
    total: 0,
    done: 0,
    empty: 0,
    failed: 0,
    message: '正在滚动加载整卷题目…',
    notes: [],
  });
  await materializeWholePage();

  const list: ParsedQuestion[] = exam ? parseAllExamQuestions() : parseAllQuestions();
  const declared = exam ? countDeclaredQuestions() : 0;

  if (!list.length) {
    await broadcast({
      active: false,
      phase: 'error',
      cursor: 0,
      total: 0,
      done: 0,
      empty: 0,
      failed: 0,
      message: '整卷模式：页面上没解析到题目（页面结构可能变了）',
      notes: [],
    });
    return;
  }

  const state: RunState = {
    active: true,
    phase: 'solve',
    cursor: 0,
    total: list.length,
    done: 0,
    empty: 0,
    failed: 0,
    message: `就地作答：解析到 ${list.length} 题，正在并发求解…`,
    notes: [],
  };
  // 解析到的数量少于侧栏声明 → 明确报出来（这就是"漏题"）
  if (declared > list.length) {
    state.notes = [
      `⚠️ 疑似漏题：只解析到 ${list.length} 题，侧栏显示共 ${declared} 题（可能是懒渲染未加载完）`,
    ];
  }

  const push = async (opts?: { message?: string; note?: string }) => {
    if (opts?.message) state.message = opts.message;
    if (opts?.note) state.notes = [opts.note, ...(state.notes ?? [])].slice(0, 6);
    state.cursor = state.done + state.empty + state.failed;
    await broadcast({ ...state, notes: [...(state.notes ?? [])] });
  };
  await push();

  const s = await getSettings();
  if (!s.enabled) {
    state.active = false;
    state.phase = 'stopped';
    await push({ message: '插件已暂停（设置里可开启）' });
    return;
  }

  const scheduler = new Scheduler<SolveResult>({
    concurrency: s.concurrency,
    minGapMs: s.minGapMs,
    maxGapMs: s.maxGapMs,
    maxPerMinute: s.maxPerMinute,
    retries: s.retries,
  });
  activeScheduler = scheduler; // 记到模块级，stopWholePage() 才能停掉它

  const byId = new Map(list.map((p) => [p.data.id, p]));
  const tasks = list.map((p) => ({
    id: p.data.id,
    priority: TYPE_PRIORITY[p.data.type],
    // 单题求解：SW 负责抓图 + 思考模式作答 + 低置信度复核
    run: () => sendToBackground('SINGLE_SOLVE', { question: p.data }),
  }));

  await scheduler.run(tasks, {
    onTaskDone: async (id, res) => {
      // ★ 钩子内任何异常都必须自己吞掉并计数，否则计数永远停在 0，界面看起来像卡死
      try {
        const p = byId.get(id);
        if (!p || cancelled) return;
        if (!res?.answer) {
          state.empty += 1;
          await push({ note: `第${p.data.index}题留空：${res?.reason ?? '模型未给出答案'}` });
          return;
        }
        const fill = await fillParsed(p, res.answer);
        if (fill.ok) {
          state.done += 1;
          await push({ note: res.note ? `第${p.data.index}题：${res.note}` : undefined });
        } else {
          state.failed += 1;
          await push({ note: `第${p.data.index}题回填失败：${fill.reason ?? '未知原因'}` });
        }
      } catch (err) {
        state.failed += 1;
        await push({
          note: `第${byId.get(id)?.data.index ?? '?'}题处理异常：${(err as Error).message}`,
        });
      }
    },
    onTaskFailed: async (id, err) => {
      try {
        const p = byId.get(id);
        state.failed += 1;
        await push({ note: `第${p?.data.index ?? '?'}题求解失败：${err}` });
      } catch {
        /* 忽略：保证不因钩子异常中断统计 */
      }
    },
  });

  state.active = false;
  state.phase = cancelled ? 'stopped' : 'done';
  await push({
    message: cancelled
      ? `已停止：已填 ${state.done}，留空 ${state.empty}，失败 ${state.failed}`
      : `就地作答完成：已填 ${state.done}，留空 ${state.empty}，失败 ${state.failed}` +
        (declared > list.length ? `（仅覆盖 ${list.length}/${declared} 题）` : ''),
  });
}

/** 经 SW 转发给顶层 frame 的浮球（与逐题模式共用同一套界面） */
async function broadcast(state: RunState): Promise<void> {
  await sendToBackground('ENGINE_STATE', state).catch(() => { /* 无接收方时忽略 */ });
}
