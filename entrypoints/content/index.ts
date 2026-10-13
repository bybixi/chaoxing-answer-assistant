import { defineContentScript, browser } from '#imports';
import { detectRole } from './role';
import { startEngine } from './engine';
import { startExamEngine } from './examEngine';
import { startShell } from './ui/floatBall';
import { createRouter } from '../../shared/messaging';
import { isExamPage } from './parse/exam';

/**
 * 内容脚本入口：学习通是「顶层壳 + 多个跨域 iframe」结构，
 * 这里会在每个 frame 里各实例化一次，先做角色识别（设计文档 §5.1）。
 *
 * 两条驱动路径：
 *  - 新版考试页（exam-ans，逐题渲染）→ examEngine（两遍法）
 *  - 旧版作业页（dowork，整卷）     → engine（原整卷流程）
 */
export default defineContentScript({
  matches: [
    'https://*.chaoxing.com/*',
    'https://*.chaoxing.com.cn/*',
    'https://*.chaoxing.cn/*',
  ],
  allFrames: true, // ★ 必开，否则注入不进作业 iframe
  runAt: 'document_idle',

  main() {
    // 顶层同步注册唯一监听器（work frame 收指令、shell frame 收状态）
    browser.runtime.onMessage.addListener(createRouter());

    const isTop = window.top === window;

    if (isExamPage()) {
      // 考试页的引擎与浮球都只该活在**顶层文档**：
      // 若 exam-ans 页面被嵌进 iframe，再注入一颗浮球就是重复 UI
      if (isTop) {
        startExamEngine();
        startShell();
      }
      return;
    }

    const role = detectRole();
    if (role === 'work' || role === 'both') startEngine();
    if (role === 'shell' || role === 'both') startShell();
    // role === 'none'：非顶层的普通 iframe，静默退出，不注入任何 UI
  },
});
