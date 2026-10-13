/**
 * 整卷侦测（设计文档 §4.1 第①步）。
 *
 * 学习通作业可能异步渲染，用 MutationObserver + DOM 稳定检测，
 * 而不是抢跑 document_start（那会撞上 DOM 未构建的坑）。
 */

import { SELECTORS } from './parse/selectors';

const DEBOUNCE_MS = 600;
const STABLE_MS = 1200;

export function watchForQuestions(
  onStable: (count: number) => void,
  signal: { stopped: boolean },
): void {
  let debounceTimer: number | undefined;
  let stableTimer: number | undefined;
  let lastCount = -1;
  let settled = false;

  const countQuestions = () => document.querySelectorAll(SELECTORS.questionItem).length;

  const scheduleCheck = () => {
    if (signal.stopped) return;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      const count = countQuestions();
      if (count === 0) return;

      // 数量变化了，重新等待稳定
      if (count !== lastCount) {
        lastCount = count;
        settled = false;
      }

      window.clearTimeout(stableTimer);
      // 连续 STABLE_MS 没有新变化 → 视为整卷加载完毕
      stableTimer = window.setTimeout(() => {
        if (signal.stopped || settled) return;
        settled = true;
        onStable(countQuestions());
      }, STABLE_MS);
    }, DEBOUNCE_MS);
  };

  const observer = new MutationObserver(() => {
    // ★ settled 之后不能就此装死：SPA 里换一份作业时 DOM 会整体替换，
    //   此时必须重新侦测，否则新作业永远不会被处理（此前 observer 回调直接 return）。
    if (settled) {
      const count = countQuestions();
      if (count > 0 && count !== lastCount) {
        settled = false;
        lastCount = count;
      } else {
        return;
      }
    }
    scheduleCheck();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  scheduleCheck(); // 页面已加载完成的情况
}
