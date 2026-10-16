/**
 * 作业页结构探针（通过 CDP 连接调试实例，遍历所有 frame 输出诊断报告）
 *
 * 用途：一次性确认作业页「不能正常做题」的真正原因 —— 是选择器不命中、
 *       还是指令被路由到了没有题目的 frame、还是选项结构不是原生 input。
 *
 * 用法：
 *   1) 启动调试实例（自己先登录，并打开一个能看到题目的作业页）：
 *      chrome.exe --remote-debugging-port=9222 --user-data-dir=<项目>/.chrome-profile
 *   2) node tools/probe-homework.mjs            # 默认筛选 URL 含 chaoxing 的标签页
 *      node tools/probe-homework.mjs dowork     # 自定义 URL 关键字
 *
 * 只读：只做查询与求值，不点击、不修改页面。
 */

const PORT = Number(process.env.CDP_PORT || 9222);
const KEYWORD = process.argv[2] || 'chaoxing';

/** 在每个 frame 里执行的探测表达式（返回纯数据） */
const PROBE = `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const WORK_URL_PATTERN = /exam-ans|reVersionTest|\\/work\\/|dowork|mooc-ans/i;

  // 容器候选：agent 已知的所有形态
  const candidates = [
    '.TiMu', '.questionLi', '.questionLi[data]', '.Zy_TItle', '.mark_name', 'li[data-asq]',
  ];
  const counts = {};
  for (const s of candidates) counts[s] = q(s);

  // 首个候选容器的结构样本
  const container =
    document.querySelector('.TiMu') ||
    document.querySelector('.questionLi') ||
    document.querySelector('.mark_name');
  const firstTag = container
    ? container.tagName.toLowerCase() + (container.className ? '.' + String(container.className).split(/\\s+/).slice(0, 3).join('.') : '')
    : null;

  // 选项相关的真实结构（判断是否依赖原生 input）
  const scope = container || document;
  const inputs = Array.from(scope.querySelectorAll('input'));
  const radios = inputs.filter((i) => i.type === 'radio');
  const checks = inputs.filter((i) => i.type === 'checkbox');
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const answerIds = inputs.filter((i) => /^answer/i.test(i.id)).map((i) => i.id);

  return {
    url: location.href,
    isTop: window.top === window,
    urlMatchesWorkPattern: WORK_URL_PATTERN.test(location.href),
    hasTiMu: !!document.querySelector('.TiMu'),
    counts,
    firstContainer: firstTag,
    firstContainerHtml: container ? container.outerHTML.replace(/\\s+/g, ' ').slice(0, 900) : null,
    optionProbe: {
      ulLi: q('ul li'),
      answerBg: q('.answerBg'),
      addChoiceEls: q('[onclick*="addChoice"]'),
      radios: radios.length,
      radiosVisible: radios.filter(visible).length,
      checkboxes: checks.length,
      checkboxesVisible: checks.filter(visible).length,
      textInputs: q('input[type=text]'),
      checkAnswerLike: q('.check_answer, .checkAnswer'),
      labelsOrNakedLi: q('li'),
    },
    answerHiddenIds: answerIds.slice(0, 5),
    iframeCount: q('iframe'),

    /* ── 深度对比：两套解析器各自会得到什么（用于确定该用哪套）── */
    legacyWouldParse: (() => {
      const tiMu = Array.from(document.querySelectorAll('.TiMu'));
      const perTiMu = tiMu.map((el) => ({
        cls: String(el.className).slice(0, 60),
        optionCandidates: el.querySelectorAll('ul li, .answerCard li, li.clearfix').length,
        optionsWithNativeInput: Array.from(
          el.querySelectorAll('ul li, .answerCard li, li.clearfix'),
        ).filter((li) => li.querySelector('input[type=radio], input[type=checkbox]')).length,
        nativeInputs: el.querySelectorAll('input[type=radio], input[type=checkbox]').length,
        stemBlockHit:
          el.querySelector('.Zy_TItle') ? '.Zy_TItle' : el.querySelector('.clearfix') ? '.clearfix' : null,
      }));
      return { tiMuCount: tiMu.length, perTiMu };
    })(),
    examWouldParse: (() => {
      const li = document.querySelector('.questionLi[data]');
      if (!li) return { questionLiDataCount: 0 };
      const stemEl = li.querySelector('.mark_name');
      const badge = stemEl?.querySelector('.colorShallow')?.textContent?.trim() ?? '';
      const opts = Array.from(li.querySelectorAll('.answerBg')).slice(0, 6).map((o) => ({
        data: o.querySelector('.num_option[data]')?.getAttribute('data') ?? o.getAttribute('data') ?? '',
        key: (o.querySelector('.num_option')?.textContent ?? '').trim().slice(0, 4),
        text: (o.querySelector('.answer_p')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        hasAddChoice: /addChoice/.test(o.getAttribute('onclick') ?? o.innerHTML),
      }));
      return {
        questionLiDataCount: document.querySelectorAll('.questionLi[data]').length,
        qid: li.getAttribute('data'),
        badge,
        stem: (stemEl?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        options: opts,
        answerFieldId: 'answer' + li.getAttribute('data'),
      };
    })(),
  };
})()`;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

function flatFrames(node, out = []) {
  out.push(node.frame);
  for (const child of node.childFrames ?? []) flatFrames(child, out);
  return out;
}

const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null);
if (!listRes) {
  console.error(`✗ 连不上 127.0.0.1:${PORT}，请先启动调试实例（见文件头注释）`);
  process.exit(1);
}
const targets = (await listRes.json()).filter((t) => t.type === 'page' && t.url.includes(KEYWORD));
if (targets.length === 0) {
  console.error(`✗ 没有 URL 含「${KEYWORD}」的标签页。请先在该窗口里打开作业页，或用参数指定关键字。`);
  process.exit(1);
}

for (const target of targets) {
  console.log(`\n${'='.repeat(78)}\n页面: ${target.url.slice(0, 140)}\n${'='.repeat(78)}`);
  const { send, close } = await cdp(target.webSocketDebuggerUrl);
  try {
    const tree = await send('Page.getFrameTree');
    const frames = flatFrames(tree.frameTree);
    console.log(`共 ${frames.length} 个 frame\n`);

    let idx = 0;
    for (const frame of frames) {
      idx += 1;
      let ctxId;
      try {
        const r = await send('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: 'zhida-probe',
        });
        ctxId = r.executionContextId;
      } catch (err) {
        console.log(`── frame #${idx} 无法求值（${err.message.slice(0, 60)}）`);
        console.log(`   ${frame.url.slice(0, 120)}\n`);
        continue;
      }
      const res = await send('Runtime.evaluate', {
        contextId: ctxId,
        expression: PROBE,
        returnByValue: true,
      });
      const d = res?.result?.value;
      if (!d) {
        console.log(`── frame #${idx} 求值无结果\n`);
        continue;
      }
      const hit = d.counts['.TiMu'] > 0 ? '★容器命中' : '（无 .TiMu）';
      console.log(`── frame #${idx} ${d.isTop ? '[顶层]' : '[iframe]'} ${hit}`);
      console.log(`   URL: ${d.url.slice(0, 130)}`);
      console.log(`   URL 命中 WORK_URL_PATTERN: ${d.urlMatchesWorkPattern ? '是' : '否 ← 若为否，engine 不会启动'}`);
      console.log(
        `   容器计数: ` +
          Object.entries(d.counts)
            .map(([k, v]) => `${k}=${v}`)
            .join('  '),
      );
      console.log(`   首个容器: ${d.firstContainer ?? '（未找到任何候选容器）'}`);
      const o = d.optionProbe;
      console.log(
        `   选项探测: ul-li=${o.ulLi}  .answerBg=${o.answerBg}  addChoice元素=${o.addChoiceEls}` +
          `  radio=${o.radios}(可见${o.radiosVisible})  checkbox=${o.checkboxes}(可见${o.checkboxesVisible})` +
          `  文本框=${o.textInputs}  选中态类=${o.checkAnswerLike}`,
      );
      console.log(`   answer 域: ${d.answerHiddenIds.length ? d.answerHiddenIds.join(', ') : '（无）'}`);
      console.log(`   内嵌 iframe 数: ${d.iframeCount}`);

      // 两套解析器的对比（决定该走哪条路）
      const L = d.legacyWouldParse;
      if (L) {
        console.log(`   ── 旧版解析器（.TiMu）会得到: ${L.tiMuCount} 道"题"`);
        for (const t of L.perTiMu.slice(0, 3)) {
          console.log(
            `      · ${t.cls}｜选项候选=${t.optionCandidates}｜其中含原生input的=${t.optionsWithNativeInput}` +
              `｜原生input总数=${t.nativeInputs}｜题干块命中=${t.stemBlockHit ?? '无'}`,
          );
        }
      }
      const E = d.examWouldParse;
      if (E) {
        console.log(`   ── 考试页解析器（.questionLi[data]）会得到: ${E.questionLiDataCount} 道题`);
        if (E.qid) {
          console.log(`      首题 qid=${E.qid}｜题型徽标="${E.badge}"｜题干="${E.stem}"`);
          console.log(`      answer 域应为 #${E.answerFieldId}`);
          for (const o of E.options ?? []) {
            console.log(`      选项 data=${o.data} key=${o.key} addChoice=${o.hasAddChoice} 文本="${o.text}"`);
          }
        }
      }
      if (d.firstContainerHtml) {
        console.log(`   容器 HTML 样本:\n     ${d.firstContainerHtml.slice(0, 600)}`);
      }
      console.log('');
    }
  } finally {
    close();
  }
}

console.log('提示：把上面整段输出发回，即可确定命中问题清单里的哪一条。');
