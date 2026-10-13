import type { Answer, Question, SolveResult } from './question';

/**
 * 运行状态（SW 持有，跨页面导航存活 —— 新版考试页每切一题就整页刷新，
 * 引擎状态必须放在 SW，内容脚本只是"无状态工人"）
 */
export interface RunState {
  active: boolean;
  phase: 'idle' | 'collect' | 'solve' | 'fill' | 'done' | 'error' | 'stopped';
  /** collect/fill 阶段当前处理到的题号（0 起） */
  cursor: number;
  total: number;
  done: number;
  empty: number;
  failed: number;
  message?: string;
  /** 需要用户知道的逐题说明（留空/失败原因），最新的在前，最多保留几条 */
  notes?: string[];
}

/** SW 下发给内容脚本的一步指令 */
export type WorkCmd =
  | { cmd: 'PARSE'; cursor: number }
  | { cmd: 'FILL'; cursor: number }
  | { cmd: 'IDLE' };

type Req<F, R> = { req: F; res: R };

/**
 * 消息协议 v2（跨导航架构）。
 *
 * 通信拓扑：
 *  - content（每次页面加载）→ SW：WORK_HELLO（报到并领取任务）
 *  - SW → content：WORK_STEP（PARSE 或 FILL）
 *  - content → SW：QUESTION_PARSED / FILL_REQUEST / FILL_RESULT
 *  - SW → 顶层 frame：ENGINE_STATE（浮球展示）
 *  - 浮球 → SW：RUN_CMD（start/stop）、QUERY_STATE
 *  - 旧版作业页（dowork）继续走 CMD_START/ANSWER_ONE 那套
 */
export interface MessageMap {
  WORK_HELLO: Req<void, { ok: true }>;
  ENGINE_STATE: Req<RunState, { ok: true }>;

  RUN_CMD: Req<'start' | 'stop' | 'retry', { ok: true }>;
  WORK_STEP: Req<WorkCmd, { ok: true }>;

  /** PARSE 完成上报；paperIndex=答题卡上的实际位置。SW 返回下一题下标（null = 采集结束） */
  QUESTION_PARSED: Req<{ question: Question; totalInPaper: number; paperIndex: number }, { goto: number | null }>;

  /** 回填取答案；SW 返回答案与下一题下标 */
  FILL_REQUEST: Req<{ qid: string; paperIndex: number }, { answer: Answer | null; reason?: string; goto: number | null }>;
  /** 回填结果上报：filled=已填 / empty=留空 / failed=失败 */
  FILL_RESULT: Req<{ qid: string; kind: 'filled' | 'empty' | 'failed'; reason?: string }, { ok: true }>;

  QUERY_STATE: Req<void, { state: RunState | null }>;

  /** 只解答屏幕上的当前题：不跳转、不动其他题（用于补答留空题） */
  SINGLE_SOLVE: Req<{ question: Question }, SolveResult>;

  /* ── 旧版作业页（dowork，整卷加载）专用 ── */
  ANSWER_ONE: Req<{ question: Question }, SolveResult>;
  CMD_START: Req<void, { ok: true }>;
  CMD_STOP: Req<void, { ok: true }>;
  CMD_RETRY: Req<void, { ok: true }>;
}

export type MessageType = keyof MessageMap;

/** 统一信封，防止其他扩展/页面的消息混入 */
export const ENVELOPE = '__zhida';

export interface Envelope<K extends MessageType = MessageType> {
  [ENVELOPE]: true;
  type: K;
  payload: MessageMap[K]['req'];
}

export type Reply<K extends MessageType> =
  | { ok: true; data: MessageMap[K]['res'] }
  | { ok: false; error: string };
