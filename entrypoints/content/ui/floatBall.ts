import { browser, storage } from '#imports';
import { onMessage, sendToBackground } from '../../../shared/messaging';
import type { RunState } from '../../../shared/types/messages';
import { solveCurrentQuestion } from '../single';
import { runWholePage, stopWholePage } from '../wholePage';
import { detectPageShape, isExamPage } from '../parse/exam';

/**
 * 浮球 UI（顶层 frame）。
 *
 * 交互设计：
 *  - **可拖动**：按住球身拖动，松手**吸附到最近一侧边缘**（球心在哪半边就贴哪边），
 *    纵向位置保留并夹在视口内。
 *  - **可隐藏**：收起后缩成**贴边的半透明小角标**，悬停变亮，点一下复原；
 *    面板里也有明确的「收起」按钮，双击球体同样收起。
 *  - **位置持久化**：考试页每切一题就整页刷新，位置/隐藏态必须存 storage，
 *    否则浮球每次都会跳回原点。
 *  - **方向上自适应**：球在左半边→面板朝右开，右半边→朝左开；上方空间不足→改向下开。
 */

interface UiState {
  x: number | null;
  y: number | null;
  hidden: boolean;
}

const DEFAULT_UI: UiState = { x: null, y: null, hidden: false };
const BALL = 52;
const TAB_W = 22;
const TAB_H = 46;
const MARGIN = 16;
const HOST_ID = 'zhida-floatball-host';

/** 防止同一文档里被初始化两次（历史 bug：某些页面出现两个浮球） */
let shellBooted = false;

export function startShell(): void {
  if (shellBooted) return;
  shellBooted = true;
  // 双保险：若文档里已存在浮球宿主（例如内容脚本被重复注入），先清掉
  document.getElementById(HOST_ID)?.remove();

  const uiItem = storage.defineItem<UiState>('local:ui', { fallback: DEFAULT_UI });

  // ────────────────────────── 结构 ──────────────────────────
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'all:initial; position:fixed; z-index:2147483647; opacity:0; transition:opacity .15s;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  // 注意：shadow DOM 里不能靠后代选择器匹配宿主元素（.host-hidden .ball 无效），
  // 形态类必须写成 :host(.xxx) 形式
  style.textContent = `
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }

    .ball { width:${BALL}px; height:${BALL}px; border-radius:16px; background:#2563eb;
      display:flex; align-items:center; justify-content:center; cursor:grab; overflow:hidden;
      box-shadow:0 4px 14px rgba(0,0,0,.25); user-select:none;
      transition:transform .15s, box-shadow .2s; touch-action:none; }
    .ball:active { cursor:grabbing; }
    .ball:hover { transform:scale(1.05); }
    .ball img { width:100%; height:100%; display:block; pointer-events:none; }
    .ball.running { box-shadow:0 0 0 3px rgba(5,150,105,.55), 0 4px 14px rgba(0,0,0,.25); }

    /* 收起后的小角标：贴边、半透明、悬停变亮；贴边侧不做圆角，读起来才像"从边上露出来" */
    .tab { display:none; width:${TAB_W}px; height:${TAB_H}px; overflow:hidden;
      background:rgba(37,99,235,.55); align-items:center; justify-content:center;
      cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.2); opacity:.55;
      transition:opacity .18s, background .18s; }
    .tabInner { display:flex; align-items:center; justify-content:center; gap:1px;
      width:100%; height:100%; color:#fff; font-size:12px; }
    .tab:hover { opacity:1; background:#2563eb; }
    .tab img { width:14px; height:14px; flex:0 0 auto; display:block; opacity:.95; pointer-events:none; }
    .tab .chev { font-size:10px; color:#fff; opacity:.8; line-height:1; pointer-events:none; }
    .tab.running { background:rgba(5,150,105,.6); opacity:.8; }
    :host(.side-right) .tab { border-radius:10px 0 0 10px; }
    :host(.side-left)  .tab { border-radius:0 10px 10px 0; }

    :host(.host-hidden) .ball, :host(.host-hidden) .panel { display:none !important; }
    :host(.host-hidden) .tab { display:flex; }

    .panel { position:absolute; width:268px; background:#fff; color:#1f2937; border-radius:12px;
      box-shadow:0 8px 30px rgba(0,0,0,.18); padding:14px; font-size:13px; display:none; }
    .panel.open { display:block; }
    :host(.side-right) .panel { right:0; left:auto; }
    :host(.side-left) .panel { left:0; right:auto; }
    :host(.panel-up) .panel { bottom:${BALL + 10}px; top:auto; }
    :host(.panel-down) .panel { top:${BALL + 10}px; bottom:auto; }

    .head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
    h4 { margin:0 0 8px; font-size:14px; }
    .collapse { border:0; background:#f3f4f6; color:#6b7280; border-radius:7px;
      padding:3px 8px; font-size:11px; cursor:pointer; white-space:nowrap; font-family:inherit; }
    .collapse:hover { background:#e5e7eb; color:#374151; }
    .row { display:flex; gap:8px; margin-top:8px; }
    .row button { flex:1; border:0; border-radius:8px; padding:7px 0; cursor:pointer;
      font-size:12px; background:#e5e7eb; font-family:inherit; }
    .row button.primary { background:#2563eb; color:#fff; }
    .row button.danger { background:#ef4444; color:#fff; }
    .row button:disabled { opacity:.45; cursor:not-allowed; }
    .stats { display:flex; gap:10px; margin-top:8px; color:#6b7280; flex-wrap:wrap; }
    .msg { margin-top:8px; color:#9ca3af; word-break:break-all; max-height:60px; overflow:auto; }
    .single { margin-top:6px; font-size:12px; word-break:break-all; display:none; }
    .single.on { display:block; }
    .notes { margin-top:8px; border-top:1px solid #f3f4f6; padding-top:6px; color:#b45309;
      font-size:11.5px; line-height:1.5; max-height:88px; overflow:auto; display:none; }
    .notes.on { display:block; }
    .hint { margin-top:8px; color:#c7cad1; font-size:10.5px; }
  `;

  /** 创建图标 img；加载失败时**移除 img 并退化为文字**（避免出现"破图 + 文字"） */
  function iconImg(path: string, fallbackText: string, parent: HTMLElement): void {
    try {
      const img = document.createElement('img');
      // WXT 的 PublicPath 联合类型只覆盖入口 HTML，这里显式绕过
      img.src = browser.runtime.getURL(path as never);
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        if (!parent.textContent) parent.textContent = fallbackText;
      });
      parent.appendChild(img);
    } catch {
      parent.textContent = fallbackText;
    }
  }

  const ball = document.createElement('div');
  ball.className = 'ball';
  iconImg('/icon/48.png', '智答', ball);

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.title = '智答（点击展开）';
  {
    const wrap = document.createElement('span');
    wrap.className = 'tabInner';
    iconImg('/icon/32.png', '智', wrap);
    const chev = document.createElement('span');
    chev.className = 'chev';
    wrap.appendChild(chev);
    tab.appendChild(wrap);
  }

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="head">
      <h4>智答 · 学习通自动答题</h4>
      <button class="collapse" id="zd-hide" title="收起为贴边小角标">收起 ▸</button>
    </div>
    <div class="stats"><span id="zd-total">总 0</span><span id="zd-done">已填 0</span>
    <span id="zd-empty">留空 0</span><span id="zd-fail">失败 0</span></div>
    <div class="msg" id="zd-msg">打开作业页后自动开始</div>
    <div class="notes" id="zd-notes"></div>
    <div class="single" id="zd-single"></div>
    <div class="row"><button class="primary" id="zd-start">开始</button><button class="danger" id="zd-stop">停止</button></div>
    <div class="row"><button id="zd-current">只答当前题</button></div>
    <div class="hint">拖动圆球可移动位置 · 松手自动吸边 · 双击球可收起</div>
  `;

  shadow.append(style, ball, panel, tab);
  document.documentElement.appendChild(host);

  // ────────────────────────── 状态与布局 ──────────────────────────
  const pos = { x: 0, y: 0 };
  let hidden = false;
  let open = false;

  const clampY = (y: number) =>
    Math.min(Math.max(y, MARGIN), Math.max(MARGIN, window.innerHeight - BALL - MARGIN));

  function layout(): void {
    const vw = window.innerWidth;
    const sideLeft = pos.x + BALL / 2 < vw / 2;
    host.classList.toggle('side-left', sideLeft);
    host.classList.toggle('side-right', !sideLeft);
    host.classList.toggle('host-hidden', hidden);

    // 上方空间不足则面板向下开
    const needUp = BALL + 10 + 320;
    const canUp = pos.y > needUp;
    host.classList.toggle('panel-up', canUp);
    host.classList.toggle('panel-down', !canUp);

    if (hidden) {
      // 收起态：小角标贴在对应侧边缘
      const y = Math.min(
        Math.max(pos.y, MARGIN),
        Math.max(MARGIN, window.innerHeight - TAB_H - MARGIN),
      );
      host.style.left = `${sideLeft ? 0 : vw - TAB_W}px`;
      host.style.top = `${y}px`;
      host.style.width = `${TAB_W}px`;
      host.style.height = `${TAB_H}px`;
      // 箭头朝屏幕内侧，提示"可以拉出来"
      const chev = tab.querySelector('.chev');
      if (chev) chev.textContent = sideLeft ? '›' : '‹';    } else {
      pos.y = clampY(pos.y);
      pos.x = Math.min(Math.max(pos.x, MARGIN), Math.max(MARGIN, vw - BALL - MARGIN));
      host.style.left = `${pos.x}px`;
      host.style.top = `${pos.y}px`;
      host.style.width = `${BALL}px`;
      host.style.height = `${BALL}px`;
    }
  }

  function setPos(x: number, y: number): void {
    pos.x = x;
    pos.y = y;
    layout();
  }

  /** 松手吸附：贴到最近的一侧边缘，纵向保留 */
  function snapToEdge(): void {
    const sideLeft = pos.x + BALL / 2 < window.innerWidth / 2;
    pos.x = sideLeft ? MARGIN : window.innerWidth - BALL - MARGIN;
    layout();
    void persist();
  }

  async function persist(): Promise<void> {
    try {
      await uiItem.setValue({ x: pos.x, y: pos.y, hidden });
    } catch {
      /* 存储失败不影响使用 */
    }
  }

  // ────────────────────────── 拖动 / 点击 ──────────────────────────
  let drag: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;

  ball.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    try {
      ball.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  });

  ball.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return; // 拖动阈值：小抖动仍算点击
    drag.moved = true;
    if (open) togglePanel(false); // 拖动时收起面板，避免遮挡
    setPos(drag.ox + dx, drag.oy + dy);
  });

  function endDrag(e: PointerEvent): void {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    try {
      ball.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (moved) snapToEdge();
    else togglePanel();
  }
  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', endDrag);

  // 双击球体直接收起
  ball.addEventListener('dblclick', () => setHidden(true));

  function togglePanel(next?: boolean): void {
    open = next ?? !open;
    panel.classList.toggle('open', open);
  }

  function setHidden(next: boolean): void {
    hidden = next;
    if (hidden) togglePanel(false);
    layout();
    void persist();
  }

  tab.addEventListener('click', () => setHidden(false));
  shadow.querySelector('#zd-hide')!.addEventListener('click', () => setHidden(true));

  window.addEventListener('resize', () => layout());

  // ────────────────────────── 渲染 ──────────────────────────
  const setText = (id: string, t: string) => {
    const el = shadow.querySelector(`#${id}`);
    if (el) el.textContent = t;
  };

  const PHASE_LABEL: Record<RunState['phase'], string> = {
    idle: '就绪，点击「开始」',
    collect: '遍历整卷中…',
    solve: 'AI 并发求解中…',
    fill: '逐题回填中…',
    done: '本轮完成',
    stopped: '已停止',
    error: '出错',
  };

  const render = (s: RunState | null) => {
    if (!s) return;
    setText('zd-total', `总 ${s.total}`);
    setText('zd-done', `已填 ${s.done}`);
    setText('zd-empty', `留空 ${s.empty}`);
    setText('zd-fail', `失败 ${s.failed}`);
    setText('zd-msg', s.message || PHASE_LABEL[s.phase]);

    const notesEl = shadow.querySelector('#zd-notes') as HTMLElement | null;
    if (notesEl) {
      const notes = s.notes ?? [];
      notesEl.textContent = notes.join('\n');
      notesEl.classList.toggle('on', notes.length > 0);
    }

    const busy = s.active && (s.phase === 'collect' || s.phase === 'solve' || s.phase === 'fill');
    ball.classList.toggle('running', busy);
    tab.classList.toggle('running', busy); // 收起状态也能看出正在跑
    // 运行中禁用「开始」：早期实现允许重复点击，会重置状态把正在跑的流程腰斩（钱已花）
    const startBtn = shadow.querySelector('#zd-start') as HTMLButtonElement | null;
    if (startBtn) startBtn.disabled = busy;
    if (busy && !open && !hidden) {
      open = true;
      panel.classList.add('open');
    }
  };

  // ────────────────────────── 事件接线 ──────────────────────────
  shadow.querySelector('#zd-start')!.addEventListener('click', () => {
    const shape = detectPageShape();
    const box = shadow.querySelector('#zd-single') as HTMLElement;
    // 把判定依据显示出来：万一又跑偏，截图就能直接定位
    box.textContent = `检测：${shape.diag} → ${shape.mode === 'whole' ? '就地作答模式' : '逐题模式'}`;
    box.style.color = '#6b7280';
    box.classList.add('on');

    if (shape.mode === 'whole' && shape.total > 0) {
      void runWholePage();
      return;
    }
    if (shape.total === 0 && window.top === window && isExamPage()) {
      box.textContent += ' —— 没检测到题目，请确认页面已加载完成';
      box.style.color = '#b45309';
      return;
    }
    void sendToBackground('RUN_CMD', 'start');
  });

  shadow.querySelector('#zd-stop')!.addEventListener('click', () => {
    stopWholePage();
    void sendToBackground('RUN_CMD', 'stop');
  });

  const singleBtn = shadow.querySelector('#zd-current') as HTMLButtonElement;
  const singleMsg = shadow.querySelector('#zd-single') as HTMLElement;
  singleBtn.addEventListener('click', async () => {
    singleBtn.disabled = true;
    singleMsg.textContent = '正在求解本题…';
    singleMsg.style.color = '#6b7280';
    singleMsg.classList.add('on');
    try {
      const r = await solveCurrentQuestion();
      singleMsg.textContent = r.message;
      singleMsg.style.color = r.ok ? '#059669' : '#b45309';
    } catch (err) {
      singleMsg.textContent = `出错了：${(err as Error).message}`;
      singleMsg.style.color = '#b91c1c';
    } finally {
      singleBtn.disabled = false;
    }
  });

  onMessage('ENGINE_STATE', async (state) => {
    render(state);
    return { ok: true };
  });

  // ────────────────────────── 初始化 ──────────────────────────
  void (async () => {
    let saved: UiState = DEFAULT_UI;
    try {
      saved = await uiItem.getValue();
    } catch {
      /* 忽略，用默认位置 */
    }
    hidden = Boolean(saved.hidden);
    pos.x = typeof saved.x === 'number' ? saved.x : window.innerWidth - BALL - MARGIN;
    pos.y = typeof saved.y === 'number' ? saved.y : window.innerHeight - BALL - MARGIN;
    layout();
    host.style.opacity = '1'; // 位置算好后再显示，避免看到"跳一下"
    void sendToBackground('QUERY_STATE', undefined)
      .then((r) => render((r as { state: RunState | null }).state))
      .catch(() => {});
  })();
}
