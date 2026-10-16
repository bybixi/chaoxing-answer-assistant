import { defineContentScript, browser } from '#imports';
import { detectRole } from './role';
import { startEngine } from './engine';
import { startExamEngine } from './examEngine';
import { startShell } from './ui/floatBall';
import { createRouter } from '../../shared/messaging';
import { isExamPage, isExamStylePage } from './parse/exam';

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

    // ★ 结构化答题页 = 考试页 + 作业页（mooc2/work/dowork）+ 整卷预览页
    //   三者共用同一套 DOM 约定，必须走同一套解析/回填。
    //   早期只按 URL 判定（isExamPage），作业页因此落进旧版引擎 ——
    //   而旧引擎的 .TiMu 选择器会把整卷当成 1 道题（2026-10-16 实测确认）。
    if (isExamPage() || isExamStylePage()) {
      if (isTop) {
        // 逐题考试页需要 SW 编排"逐题跳转"，所以仍启动 examEngine；
        // 作业页/预览页是整卷铺开，由浮球驱动的「就地作答」处理，不需要它。
        if (isExamPage()) startExamEngine();
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
