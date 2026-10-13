import { WORK_URL_PATTERN } from './parse/selectors';

/**
 * 'work'  —— 承载题目、需要干活的 frame
 * 'shell' —— 只放浮球的 frame（**必须是顶层文档**）
 * 'both'  —— 顶层同时是作业页（如直接打开的答题页）
 * 'none'  —— 什么都不做（非顶层的普通 iframe）
 */
export type Role = 'work' | 'shell' | 'both' | 'none';

/**
 * 角色识别（设计文档 §5.1）。
 *
 * 学习通是「顶层壳 + 多个跨域 iframe」结构，内容脚本配合 all_frames 会注入到每个 frame。
 *
 * ⚠️ 历史 bug：早期实现里最后一行是 `return 'shell'`，**没有判断是否顶层**，
 * 结果页面里每个非作业 iframe 都长出一个浮球（同一页面出现两个、三个球，
 * 且各自相对自己 iframe 的视口定位）。
 * 浮球必须只存在于顶层文档：它要相对整个窗口定位，也必须唯一。
 */
export function detectRole(): Role {
  const urlLooksLikeWork = WORK_URL_PATTERN.test(location.href);
  const hasQuestionDom = !!document.querySelector('.TiMu');
  const isWork = urlLooksLikeWork || hasQuestionDom;
  const isTop = window.top === window;

  if (isWork && isTop) return 'both';
  if (isWork) return 'work';
  return isTop ? 'shell' : 'none';
}
