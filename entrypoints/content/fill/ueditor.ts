import type { ParsedQuestion } from '../../../shared/types/question';
import { setNativeValue } from './nativeEvents';
import type { FillResult } from './radio';

/**
 * 简答题 = UEditor 富文本（学习通特有，设计文档 §2.4）。
 * 直接给 textarea.value 赋值完全无效 —— UEditor 早已把输入区换成了 iframe。
 *
 * 三级降级：
 *  1. UE.getEditor(id).setContent()          —— 全局 UE 对象可用时最干净
 *  2. 直接写编辑器 iframe 的 body.innerHTML   —— 编辑器实例拿不到时
 *  3. TODO: chrome.debugger → CDP Input.insertText（需 settings.debuggerFallback，
 *     且 debugger 与 DevTools 互斥，实现时再补）
 */
export async function fillUEditor(
  parsed: ParsedQuestion,
  text: string,
): Promise<FillResult> {
  // ── 第一级：全局 UE 对象 ──
  const w = window as unknown as {
    UE?: { getEditor?: (id: string) => UEditorInstance | undefined; instances?: Record<string, UEditorInstance> };
  };
  type UEditorInstance = {
    setContent: (html: string) => void;
    getContent?: () => string;
    ready?: boolean;
  };

  const trySet = (ed: UEditorInstance | undefined): boolean => {
    if (!ed || typeof ed.setContent !== 'function') return false;
    try {
      ed.setContent(text);
      const readBack = typeof ed.getContent === 'function' ? (ed.getContent() ?? '') : '';
      return readBack.replace(/<[^>]*>/g, '').trim().length > 0;
    } catch {
      return false;
    }
  };

  // 1a. 用解析阶段探测到的 id
  if (parsed.editorId && w.UE?.getEditor) {
    if (trySet(w.UE.getEditor(parsed.editorId))) return { ok: true };
  }
  // 1b. 遍历所有已注册的 UEditor 实例（按容器就近原则太复杂，先取第一个空实例）
  if (w.UE?.instances) {
    for (const id of Object.keys(w.UE.instances)) {
      if (trySet(w.UE.instances[id])) return { ok: true };
    }
  }

  // ── 第二级：直接写编辑器 iframe 的 body ──
  const iframe = parsed.element.querySelector<HTMLIFrameElement>(
    'iframe.edui-editor-iframeholder iframe, iframe[id^="ueditor"], iframe[id^="editor"], iframe',
  );
  if (iframe) {
    try {
      const doc = iframe.contentDocument;
      if (doc?.body) {
        const html = `<p>${escapeHtml(text)}</p>`;
        doc.body.innerHTML = html;

        // ★ UEditor 只在特定事件下才把 iframe 内容同步回它的底层 textarea，
        //   而提交时读的是那个 textarea —— 只派发 input 有可能"看着填上、提交为空"。
        //   因此补 keyup/change/blur（blur 是最常触发同步的时机），
        //   并直接把底层 textarea 一起写上，作为双保险。
        for (const type of ['input', 'keyup', 'change', 'blur']) {
          doc.body.dispatchEvent(new Event(type, { bubbles: true }));
        }
        iframe.dispatchEvent(new Event('change', { bubbles: true }));

        const mirror = parsed.element.querySelector<HTMLTextAreaElement>(
          'textarea[id^="ueditor"], textarea.edui-default, textarea[name^="ueditor"]',
        );
        if (mirror) setNativeValue(mirror, html);

        const readBack = (doc.body.textContent ?? '').trim();
        if (readBack.includes(text.trim().slice(0, 20))) {
          return mirror
            ? { ok: true, reason: undefined }
            : {
                ok: true,
                reason: '已写入编辑器，但未找到底层 textarea 同步（提交前请肉眼确认）',
              };
        }
      }
    } catch {
      /* 跨域 iframe 拿不到 contentDocument，继续往下 */
    }
  }

  return {
    ok: false,
    reason: 'UEditor 回填失败（未找到可用的编辑器实例；该路径尚未在真实作业页验证过）',
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '</p><p>');
}
