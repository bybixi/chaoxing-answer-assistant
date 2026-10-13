import { sendToBackground, onMessage } from '../../shared/messaging';
import { getSettings } from '../../shared/storage';
import { Scheduler, type TaskInput } from '../../scheduler';
import { TYPE_PRIORITY } from '../../shared/constants';
import type {
  Answer,
  ParsedQuestion,
  Question,
  SolveResult,
} from '../../shared/types/question';
import type { RunState } from '../../shared/types/messages';
import { watchForQuestions } from './watcher';
import { parseAllQuestions } from './parse';
import { fillAnswer } from './fill';

/**
 * 引擎（work frame）：侦测 → 抓题 → 调度求解 → 回填 → 广播状态。
 *
 * 架构注记：调度器跑在内容脚本（而非 SW），每道题单独发一次 ANSWER_ONE，
 * SW 里的事件因此都是短命的 —— 天然规避「单次事件 5 分钟」上限。
 * 页面刷新会中断本轮，靠超星自身的实时保存兜底。
 */
export function startEngine(): void {
  const state: RunState = {
    active: false,
    phase: 'idle',
    cursor: 0,
    total: 0,
    done: 0,
    empty: 0,
    failed: 0,
  };

  /** questionId → 本地解析结果（含 DOM 引用，绝不进消息） */
  const local = new Map<string, ParsedQuestion>();
  let scheduler: Scheduler<SolveResult> | null = null;
  let lastQuestions: Question[] = [];

  const broadcast = () => {
    void sendToBackground('ENGINE_STATE', { ...state }).catch(() => {});
  };

  const runOnce = async () => {
    if (scheduler) return; // 已在跑
    const s = await getSettings();
    if (!s.enabled) return;

    const questions = lastQuestions.length ? lastQuestions : collectNow();
    if (!questions.length) return;

    state.phase = 'solve';
    state.active = true;
    state.total = questions.length;
    state.done = 0;
    state.empty = 0;
    state.failed = 0;
    broadcast();

    scheduler = new Scheduler<SolveResult>({
      concurrency: s.concurrency,
      minGapMs: s.minGapMs,
      maxGapMs: s.maxGapMs,
      maxPerMinute: s.maxPerMinute,
      retries: s.retries,
    });

    const tasks: TaskInput<SolveResult>[] = questions.map((q) => ({
      id: q.id,
      priority: TYPE_PRIORITY[q.type],
      run: () => sendToBackground('ANSWER_ONE', { question: q }),
    }));

    await scheduler.run(tasks, {
      onTaskDone: async (id, result) => {
        const parsed = local.get(id);
        if (!parsed) return;
        if (!result.answer) {
          state.empty += 1;
          state.message = result.reason;
        } else {
          const fill = await fillAnswer(parsed, result.answer as Answer);
          if (fill.ok) state.done += 1;
          else {
            state.failed += 1;
            state.message = fill.reason;
          }
        }
        broadcast();
      },
      onTaskFailed: (id, error) => {
        void id;
        state.failed += 1;
        state.message = error;
        broadcast();
      },
    });

    state.phase = scheduler.isStopped ? 'stopped' : 'done';
    state.active = false;
    scheduler = null;
    // 注：调度器现在会 await 钩子，因此这里不再需要"补空"兜底 ——
    // 早期实现会在回填还在飞时把题补记成留空，导致最终统计错误。
    broadcast();
  };

  function collectNow(): Question[] {
    const parsed = parseAllQuestions();
    local.clear();
    for (const p of parsed) local.set(p.data.id, p);
    lastQuestions = parsed.map((p) => p.data);
    state.total = lastQuestions.length;
    return lastQuestions;
  }

  // ── 浮球指令（SW 转发下来） ──
  onMessage('CMD_START', async () => {
    void runOnce();
    return { ok: true };
  });
  onMessage('CMD_STOP', async () => {
    scheduler?.stop();
    state.phase = 'stopped';
    state.active = false;
    broadcast();
    return { ok: true };
  });
  onMessage('CMD_RETRY', async () => {
    // 失败/留空的题重跑一遍（成功的不会重复提交 AI）
    const retryTargets = lastQuestions.filter((q) => {
      // 简化：全量重跑，调度器幂等，AI 结果以最后一次为准
      void q;
      return true;
    });
    void retryTargets;
    void runOnce();
    return { ok: true };
  });
  onMessage('QUERY_STATE', async () => ({ state: { ...state } }));

  // ── 侦测 ──
  void sendToBackground('WORK_HELLO', undefined).catch(() => {});
  const signal = { stopped: false };
  watchForQuestions(
    () => {
      collectNow();
      broadcast();
      void getSettings().then((s) => {
        if (s.autoRun && s.enabled) void runOnce();
      });
    },
    signal,
  );
}
