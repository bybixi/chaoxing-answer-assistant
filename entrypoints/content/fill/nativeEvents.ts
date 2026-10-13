/**
 * 回填的底层工具（设计文档 §5.7）。
 *
 * 核心坑：React/Vue 受控组件 —— 直接 el.value = x 不触发框架 onChange，
 * 表现为"看着填上了，提交时是空的"。必须用原生 setter + 派发事件。
 */

export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 拟人化点击：滚动到视口 → 补全指针事件序列 → click()。
 * 注意：合成事件的 isTrusted 仍是 false；若平台据此拒绝，
 * 需要走 chrome.debugger 的 CDP 真实输入（见 ueditor.ts / 设计文档 §4.2）。
 */
export function humanClick(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = el.getBoundingClientRect();
  const opts: MouseEventInit & PointerEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 60));
