import { browser, storage } from '#imports';
import { defineBackground } from '#imports';
import { createRouter, onMessage, sendToFrame } from '../shared/messaging';
import { solveQuestion } from '../shared/ai/client';
import { Scheduler } from '../scheduler';
import { TYPE_PRIORITY } from '../shared/constants';
import { getSettings } from '../shared/storage';
import type {
  RunState,
  WorkCmd,
} from '../shared/types/messages';
import type { Question, SolveResult } from '../shared/types/question';

/**
 * Service Worker 入口 = 考试页运行的"指挥所"。
 *
 * 为什么指挥所必须在这里：新版考试页每切一题就整页跳转（getTheQuestionByStart
 * → submitForm → location.href = ...&start=N），内容脚本随文档销毁。
 * SW 不受页面导航影响，由它持有全部运行状态并驱动三段式流程：
 *
 *   collect（逐题采集）→ solve（并发求解）→ fill（逐题回填）
 *
 * 铁律：所有 onMessage 监听器顶层同步注册（SW 内只有一个 runtime.onMessage 监听器）。
 */
/** 需要跨 SW 重启存活的最小状态（Map 不能直接存，序列化成数组） */
interface PersistedRun {
  state: RunState;
  tabId: number | null;
  order: string[];
  navCount: number;
  fillCount: number;
  questions: Question[];
  answers: [string, SolveResult][];
}

export default defineBackground(() => {
  /**
   * SW 空闲 30 秒即被回收 —— 只放内存里的话，慢请求期间（思考模式很容易触发）
   * 整轮运行会凭空消失，页面那边只看到"不动了"，没有任何提示。
   * 用 session 区持久化：SW 重启可恢复，浏览器关闭自动清空（符合语义）。
   */
  const runItem = storage.defineItem<PersistedRun | null>('session:run', {
    fallback: null,
  });

  // tabId → frameId（内容脚本每次加载都 WORK_HELLO 报到）
  const workFrames = new Map<number, number>();

  // ────────────────── 运行状态（SW 内存，导航免疫） ──────────────────
  const run: RunState & {
    order: string[];
    navCount: number;
    fillCount: number;
    /** 本轮运行绑定的标签页：多标签页时防止互相抢指令 */
    tabId: number | null;
  } = {
    active: false,
    phase: 'idle',
    cursor: 0,
    total: 0,
    done: 0,
    empty: 0,
    failed: 0,
    message: '',
    notes: [],
    order: [],
    navCount: 0,
    fillCount: 0,
    tabId: null,
  };

  /**
   * 最近报到的 tab（用于非运行期的广播，例如单题模式的原因提示）。
   * 运行期一律用 run.tabId —— 否则另一个标签页报到会把指令带偏。
   */
  let activeTabId: number | null = null;

  const addNote = (note: string) => {
    run.notes = [note, ...(run.notes ?? [])].slice(0, 6);
  };
  const questions = new Map<string, Question>();
  const answers = new Map<string, SolveResult>();
  let scheduler: Scheduler<SolveResult> | null = null;

  /** 广播目标：运行期只认 run.tabId，否则用最近报到的 tab */
  const targetTabId = (): number | null => (run.active ? run.tabId : activeTabId);

  const snapshot = (): RunState => ({
    active: run.active,
    phase: run.phase,
    cursor: run.cursor,
    total: run.total,
    done: run.done,
    empty: run.empty,
    failed: run.failed,
    message: run.message,
    notes: run.notes ?? [],
  });

  /** 把当前运行状态写入 session 区（失败不影响运行，只是失去续命能力） */
  const persistRun = () => {
    void runItem
      .setValue({
        state: snapshot(),
        tabId: run.tabId,
        order: run.order,
        navCount: run.navCount,
        fillCount: run.fillCount,
        questions: [...questions.values()],
        answers: [...answers.entries()],
      })
      .catch(() => { /* 忽略 */ });
  };

  const broadcast = async () => {
    persistRun(); // 每次状态变化顺带持久化
    const tabId = targetTabId();
    if (tabId == null) return;
    await browser.tabs
      .sendMessage(
        tabId,
        { __zhida: true, type: 'ENGINE_STATE', payload: snapshot() },
        { frameId: 0 },
      )
      .catch(() => { /* 目标页可能正在导航，忽略；下个页面加载会 QUERY_STATE */ });
  };

  /** 给工人下发一步指令；页面若正巧在导航会发送失败，等它重新 WORK_HELLO 再派 */
  const sendWork = async (cmd: WorkCmd) => {
    const tabId = run.tabId;
    if (tabId == null) return;
    await sendToFrame(tabId, 0, 'WORK_STEP', cmd).catch(() => { /* 导航中，等 HELLO */ });
  };

  const startRun = async (tabId: number | null) => {
    questions.clear();
    answers.clear();
    run.active = true;
    run.tabId = tabId; // ★ 绑定发起者，其它标签页的 HELLO/回包一律不参与本轮
    run.phase = 'collect';
    run.cursor = 0;
    run.total = 0;
    run.done = 0;
    run.empty = 0;
    run.failed = 0;
    run.order = [];
    run.navCount = 0;
    run.fillCount = 0;
    run.notes = [];
    run.message = '开始遍历整卷…';
    await broadcast();
    await sendWork({ cmd: 'PARSE', cursor: 0 });
  };

  const stopRun = async () => {
    run.active = false;
    run.phase = 'stopped';
    run.message = '已停止';
    scheduler?.stop();
    scheduler = null;
    await broadcast(); // 注意：此时 active 已 false，广播回落到 activeTabId
    run.tabId = null;
  };

  /** 全部采集完成后：并发求解 → 进入回填阶段 */
  const solveAll = async () => {
    run.phase = 'solve';
    run.message = `并发求解中（${questions.size} 题）…`;
    await broadcast();

    const s = await getSettings();
    scheduler = new Scheduler<SolveResult>({
      concurrency: s.concurrency,
      minGapMs: s.minGapMs,
      maxGapMs: s.maxGapMs,
      maxPerMinute: s.maxPerMinute,
      retries: s.retries,
    });

    const list = run.order.map((qid) => questions.get(qid)!).filter(Boolean);
    const realTasks = list.map((q) => ({
      id: q.id,
      priority: TYPE_PRIORITY[q.type],
      run: () => solveQuestion(q),
    }));

    await scheduler.run(realTasks, {
      onTaskDone: (id, result) => {
        answers.set(id, result);
        const q = questions.get(id);
        if (!result.answer) {
          addNote(`第${q?.index ?? '?'}题留空：${result.reason ?? '无答案'}`);
        } else if (result.note) {
          addNote(`第${q?.index ?? '?'}题：${result.note}`);
        }
      },
      onTaskFailed: (id, error) => {
        answers.set(id, { answer: null, reason: error });
        const q = questions.get(id);
        addNote(`第${q?.index ?? '?'}题求解失败：${error}`);
        run.failed += 1;
        run.message = error;
      },
    });
    scheduler = null;

    if (!run.active) return; // 期间被 stop
    run.phase = 'fill';
    run.cursor = 0;
    run.failed = 0;
    run.message = '开始逐题回填…';
    await broadcast();
    await sendWork({ cmd: 'FILL', cursor: 0 });
  };

  // ────────────────── 消息处理 ──────────────────

  /**
   * SW 重启续命：把上次持久化的运行状态读回来。
   * 监听器仍是**同步注册**（铁律），恢复是异步的 —— 因此 HELLO 会 await 这个 promise，
   * 避免"页面报到时状态还没恢复 → 看到 active=false 就不续跑"的竞态。
   */
  const restorePromise = (async () => {
    try {
      const saved = await runItem.getValue();
      if (!saved?.state?.active) return;
      questions.clear();
      answers.clear();
      for (const q of saved.questions ?? []) questions.set(q.id, q);
      for (const [k, v] of saved.answers ?? []) answers.set(k, v);
      Object.assign(run, saved.state, {
        tabId: saved.tabId,
        order: saved.order ?? [],
        navCount: saved.navCount ?? 0,
        fillCount: saved.fillCount ?? 0,
      });
      run.message = `${run.message ?? ''}（SW 重启后已恢复）`.trim();
    } catch {
      /* 读不到就当没有历史状态 */
    }
  })();

  onMessage('WORK_HELLO', async (_payload, sender) => {
    await restorePromise; // 等状态恢复完成再判断要不要续跑
    const s = sender as { tab?: { id?: number }; frameId?: number };
    const tabId = s.tab?.id ?? null;
    if (tabId != null) {
      workFrames.set(tabId, s.frameId ?? 0);
      activeTabId = tabId;
    }
    // 跨导航续命：**只认本轮绑定的标签页**，否则另一个学习通标签页会把流程带偏
    if (run.active && run.tabId != null && tabId === run.tabId) {
      if (run.phase === 'collect') await sendWork({ cmd: 'PARSE', cursor: run.cursor });
      else if (run.phase === 'fill') await sendWork({ cmd: 'FILL', cursor: run.cursor });
    }
    return { ok: true };
  });

  onMessage('ENGINE_STATE', async (state, sender) => {
    // 内容脚本 → 顶层 frame 的转发（旧版作业页路径用）
    const s = sender as { tab?: { id?: number } };
    if (s.tab?.id != null) {
      await browser.tabs
        .sendMessage(s.tab.id, { __zhida: true, type: 'ENGINE_STATE', payload: state }, { frameId: 0 })
        .catch(() => {});
    }
    return { ok: true };
  });

  onMessage('RUN_CMD', async (cmd, sender) => {
    const tabId = (sender as { tab?: { id?: number } }).tab?.id ?? null;
    if (cmd === 'stop') {
      await stopRun();
      return { ok: true };
    }
    // start / retry：运行中直接忽略 —— 早期实现会重置状态，把正在跑的流程腰斩（钱已花）
    if (run.active) return { ok: true };
    await startRun(tabId);
    return { ok: true };
  });

  onMessage('QUERY_STATE', async () => ({ state: snapshot() }));

  // 单题模式：只解这一道，不改动其他题的作答，也不做任何页面跳转
  onMessage('SINGLE_SOLVE', async ({ question }) => {
    const result = await solveQuestion(question);
    if (result.note) addNote(`第${question.index}题：${result.note}`);
    else if (!result.answer) addNote(`第${question.index}题留空：${result.reason ?? '无答案'}`);
    else addNote(`第${question.index}题已单题作答`);
    await broadcast();
    return result;
  });

  onMessage('QUESTION_PARSED', async ({ question, totalInPaper, paperIndex }, sender) => {
    if (!run.active || run.phase !== 'collect') return { goto: null };
    // 非本轮标签页的回包一律忽略（多标签页隔离）
    if ((sender as { tab?: { id?: number } }).tab?.id !== run.tabId) return { goto: null };
    run.total = Math.max(run.total, totalInPaper);
    run.cursor = paperIndex;
    if (!questions.has(question.id)) {
      questions.set(question.id, question);
      run.order[paperIndex] = question.id;
    }
    run.navCount += 1;
    run.message = `遍历整卷（${questions.size}/${run.total}）…`;
    await broadcast();

    // 采满 → 求解；导航次数超限（解析反复失败）→ 带着已采的强制进入求解
    if (questions.size >= run.total || run.navCount > run.total * 2 + 4) {
      if (questions.size < run.total) {
        run.message = `有 ${run.total - questions.size} 题始终解析失败，跳过`;
      }
      void solveAll();
      return { goto: null };
    }
    // 从当前位置向后走，走到卷尾就绕回第 1 题补采（用户可能不从第 1 题开始）
    const next = paperIndex + 1 < run.total ? paperIndex + 1 : 0;
    return { goto: next };
  });

  onMessage('FILL_REQUEST', async ({ qid, paperIndex }, sender) => {
    if ((sender as { tab?: { id?: number } }).tab?.id !== run.tabId) {
      return { answer: null, reason: '非本轮标签页，已忽略', goto: null };
    }
    const result = answers.get(qid) ?? { answer: null, reason: '无求解结果' };
    run.cursor = paperIndex;
    // ★ 模运算绕回：回填可能从卷中任何一题开始，必须走完整圈；
    //   终止条件是 fillCount >= total（在 FILL_RESULT 里计数），不是走到卷尾
    const goto = run.total > 0 ? (paperIndex + 1) % run.total : null;
    return { answer: result.answer, reason: result.reason, goto };
  });

  onMessage('FILL_RESULT', async ({ kind, reason }, sender) => {
    if (!run.active || run.phase !== 'fill') return { ok: true };
    if ((sender as { tab?: { id?: number } }).tab?.id !== run.tabId) return { ok: true };
    run.fillCount += 1;
    if (kind === 'filled') run.done += 1;
    else if (kind === 'empty') run.empty += 1;
    else {
      run.failed += 1;
      if (reason) {
        run.message = reason;
        addNote(`第${run.cursor + 1}题回填失败：${reason}`);
      }
    }
    await broadcast();
    if (run.fillCount >= run.total) {
      run.active = false;
      run.phase = 'done';
      run.message = `完成：已填 ${run.done}，留空 ${run.empty}，失败 ${run.failed}`;
      await broadcast();
      run.tabId = null; // 本轮结束，解除绑定
    }
    return { ok: true };
  });

  /* ── 旧版作业页（dowork）路径 ── */

  onMessage('ANSWER_ONE', async ({ question }) => {
    return await solveQuestion(question);
  });

  const forwardLegacy = async (
    tabId: number | undefined,
    type: 'CMD_START' | 'CMD_STOP' | 'CMD_RETRY',
  ): Promise<{ ok: true }> => {
    if (tabId == null) return { ok: true };
    const frameId = workFrames.get(tabId);
    if (frameId == null) return { ok: true };
    await sendToFrame(tabId, frameId, type, undefined);
    return { ok: true };
  };

  onMessage('CMD_START', async (_p, sender) =>
    forwardLegacy((sender as { tab?: { id?: number } }).tab?.id, 'CMD_START'),
  );
  onMessage('CMD_STOP', async (_p, sender) =>
    forwardLegacy((sender as { tab?: { id?: number } }).tab?.id, 'CMD_STOP'),
  );
  onMessage('CMD_RETRY', async (_p, sender) =>
    forwardLegacy((sender as { tab?: { id?: number } }).tab?.id, 'CMD_RETRY'),
  );

  // ★ 顶层同步注册唯一监听器；异步响应必须 return true
  browser.runtime.onMessage.addListener(createRouter());

  // 工具栏图标：没有 popup，点一下直接打开设置页
  browser.action?.onClicked?.addListener(() => {
    void browser.runtime.openOptionsPage();
  });
});
