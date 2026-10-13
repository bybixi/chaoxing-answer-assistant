/**
 * 懒渲染催熟：整卷浏览页的题目是**随滚动逐步生成**的，
 * 没滚到的部分 DOM 里根本不存在 —— 直接解析就会"漏题"。
 *
 * 做法：把页面所有主要滚动容器从头滚到底，给页面时间把题目渲染出来，
 * 最后恢复原滚动位置（不打扰用户）。
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Scroller {
  el: HTMLElement | null; // null = window
  max: number;
  saved: number;
}

function collectScrollers(): Scroller[] {
  const out: Scroller[] = [];
  const doc = document.scrollingElement as HTMLElement | null;
  if (doc && doc.scrollHeight > doc.clientHeight + 200) {
    out.push({ el: null, max: doc.scrollHeight - doc.clientHeight, saved: window.scrollY });
  }
  // 主要的内容滚动容器（排除小的内部滚动区）
  const candidates: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>('div, main, section, ul').forEach((el) => {
    if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 400) candidates.push(el);
  });
  candidates
    .sort((a, b) => b.scrollHeight - a.scrollHeight)
    .slice(0, 3)
    .forEach((el) => out.push({ el, max: el.scrollHeight - el.clientHeight, saved: el.scrollTop }));
  return out;
}

/** 全量催熟；返回滚动过的容器数（0 表示页面不需要滚动） */
export async function materializeWholePage(timeBudgetMs = 8000): Promise<number> {
  const scrollers = collectScrollers();
  if (!scrollers.length) return 0;

  const started = Date.now();
  const stepRatio = 0.75; // 每次滚动 0.75 屏，留出重叠避免跳块

  for (const s of scrollers) {
    const viewport = s.el ? s.el.clientHeight : window.innerHeight;
    const step = Math.max(200, viewport * stepRatio);
    for (let y = 0; y <= s.max; y += step) {
      if (Date.now() - started > timeBudgetMs) break;
      if (s.el) s.el.scrollTop = y;
      else window.scrollTo(0, y);
      await sleep(120); // 给渲染/请求留时间
    }
    if (s.el) s.el.scrollTop = s.max;
    else window.scrollTo(0, s.max);
    await sleep(250); // 到底后再等一会儿
  }

  // 恢复原位置
  for (const s of scrollers) {
    if (s.el) s.el.scrollTop = s.saved;
    else window.scrollTo(0, s.saved);
  }
  await sleep(200);
  return scrollers.length;
}
