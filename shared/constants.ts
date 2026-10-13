import type { QuestionType } from './types/question';

/** 优先级：数字越小越先跑（客观题廉价快速，先跑完让用户早看到大部分结果） */
export const TYPE_PRIORITY: Record<QuestionType, number> = {
  single: 0,
  judge: 0,
  multiple: 1,
  blank: 1,
  short: 2,
  unknown: 3,
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const randInt = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));
