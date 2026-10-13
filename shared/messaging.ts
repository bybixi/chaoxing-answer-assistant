import { browser } from '#imports';
import {
  ENVELOPE,
  type Envelope,
  type MessageMap,
  type MessageType,
  type Reply,
} from './types/messages';

/**
 * 类型化消息层（设计文档 D6）。
 *
 * 铁律（来自 Chrome 官方文档）：
 *  - 所有监听器必须在顶层同步注册
 *  - 异步 sendResponse 必须让监听器 return true
 *  - 整个上下文里每类消息只有一个处理器，避免 sendResponse 争抢
 */

type AnyEnvelope = Envelope<MessageType>;

let seq = 0;

/** content / 任意扩展页 → SW */
export async function sendToBackground<K extends MessageType>(
  type: K,
  payload: MessageMap[K]['req'],
): Promise<MessageMap[K]['res']> {
  const id = ++seq;
  const res = (await browser.runtime.sendMessage({
    [ENVELOPE]: true,
    type,
    payload,
    id,
  } as unknown as AnyEnvelope)) as Reply<K> | undefined;

  if (!res) throw new Error('消息无响应（接收方可能未就绪）');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** SW → 指定 tab 的指定 frame（content script） */
export async function sendToFrame<K extends MessageType>(
  tabId: number,
  frameId: number,
  type: K,
  payload: MessageMap[K]['req'],
): Promise<MessageMap[K]['res']> {
  const id = ++seq;
  const res = (await browser.tabs.sendMessage(
    tabId,
    { [ENVELOPE]: true, type, payload, id } as unknown as AnyEnvelope,
    { frameId },
  )) as Reply<K> | undefined;

  if (!res) throw new Error('消息无响应（目标 frame 可能未注入）');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

type Handler<K extends MessageType> = (
  payload: MessageMap[K]['req'],
  sender: unknown,
) => Promise<MessageMap[K]['res']> | MessageMap[K]['res'];

const registry = new Map<string, Handler<MessageType>>();

/** 注册处理器（每个 (上下文, type) 只能注册一次） */
export function onMessage<K extends MessageType>(type: K, handler: Handler<K>): void {
  if (registry.has(type)) throw new Error(`消息处理器重复注册: ${type}`);
  registry.set(type, handler as unknown as Handler<MessageType>);
}

/**
 * 唯一的顶层监听器工厂。
 * 用法：browser.runtime.onMessage.addListener(createRouter())
 * —— 同步注册、异步处理、恒 return true（保持消息通道）。
 */
export function createRouter(): (
  message: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => boolean {
  return (message, sender, sendResponse) => {
    const msg = message as AnyEnvelope | null;
    if (!msg || msg[ENVELOPE] !== true) return false; // 不是我们的消息，不处理

    const handler = registry.get(msg.type);
    if (!handler) {
      sendResponse({ ok: false, error: `未注册的消息类型: ${msg.type}` });
      return true;
    }

    Promise.resolve(handler(msg.payload, sender))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err as Error)?.message ?? err) }),
      );
    return true; // ★ 异步响应必须 return true
  };
}
