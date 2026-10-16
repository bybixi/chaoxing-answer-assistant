/**
 * 修复清单逐条核验（源码级证据）。
 *
 * 用途：不靠"我记得改了"，而是逐条在源码里找固定标记，输出 PASS/FAIL。
 * 跑法：node tools/audit-fixes.mjs
 *
 * 说明：只查源码（非压缩产物），因此中文可原样匹配；
 *      压缩产物里的中文会被转义成大写 \uXXXX（见 tools/_verify-bundle.mjs）。
 */
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const S = {
  client: read('shared/ai/client.ts'),
  request: read('shared/ai/request.ts'),
  validate: read('shared/ai/validate.ts'),
  prompt: read('shared/ai/prompt.ts'),
  imageFetch: read('shared/imageFetch.ts'),
  bg: read('entrypoints/background.ts'),
  sched: read('scheduler/index.ts'),
  examFill: read('entrypoints/content/fill/exam.ts'),
  examEngine: read('entrypoints/content/examEngine.ts'),
  engine: read('entrypoints/content/engine.ts'),
  wholePage: read('entrypoints/content/wholePage.ts'),
  parseExam: read('entrypoints/content/parse/exam.ts'),
  parseLegacy: read('entrypoints/content/parse/index.ts'),
  watcher: read('entrypoints/content/watcher.ts'),
  contentIndex: read('entrypoints/content/index.ts'),
  optionsMain: read('entrypoints/options/main.ts'),
  ueditor: read('entrypoints/content/fill/ueditor.ts'),
  pkg: read('package.json'),
  wxt: read('wxt.config.ts'),
};

/** [编号, 级别, 描述, 源码, 必须出现的标记（数组=全部命中）, 备注] */
const CHECKS = [
  // ── P0 高危 ──
  ['H1', '高', '多选题状态对齐（先去多余再补缺）', S.examFill,
    ['planChoiceClicks', 'toClickOff', 'toClickOn'], '决策逻辑有单测；页面交互需真机'],
  ['H1', '高', '多选校验：非目标项必须未选中', S.examFill, ['存在非目标选项仍被选中']],
  ['H1', '高', '单选/判断：answer 与目标完全相等', S.examFill, ['与目标', '不一致']],
  ['H2', '高', 'AI 请求超时', S.client, ['AbortSignal.timeout', 'AI_TIMEOUT_MS']],
  ['H3', '高', '退避重试封装', S.request, ['requestWithRetry', 'isRetryableError']],
  ['H3', '高', '求解与复核都走重试', S.client, ['requestWithRetry('], '两处调用'],

  // ── P1 中危 ──
  ['M1', '中', 'run 绑定 tabId', S.bg, ['tabId: number | null', 'run.tabId = tabId']],
  ['M1', '中', '运行期回包按 tab 过滤', S.bg, ['非本轮标签页']],
  ['M1', '中', 'HELLO 只认本轮 tab', S.bg, ['tabId === run.tabId']],
  ['M2', '中', '运行中忽略 start', S.bg, ['if (run.active) return { ok: true }']],
  ['M2', '中', '浮球开始按钮防重入', read('entrypoints/content/ui/floatBall.ts'), ['startBtn.disabled = busy']],
  ['M5', '中', '就地作答停止真正停调度器', S.wholePage, ['activeScheduler', 'activeScheduler?.stop()']],
  ['M6', '中', '容器口径统一', S.parseExam, ['collectQuestionContainers'], '两处共用'],
  ['M7', '中', '选项图片送模型', S.client, ['MAX_IMAGES_PER_QUESTION', '选项'], '行为需真机'],
  ['M7', '中', '提示词指明附图', S.prompt, ['见附图：选项']],
  ['M8', '中', '设置页数值钳制', S.optionsMain, ['NUMBER_RANGES', 'clampedNotice']],
  ['M8', '中', '空值跳过（不存 0）', S.optionsMain, ["el.value.trim() === ''"]],
  ['M4', '中', 'WORK_STEP 防重入', S.examEngine, ['let busy = false']],
  ['M3', '中', '导航死代码已清理', S.examEngine, ['只有 li.click() 一条路可走']],
  ['M3', '中', '导航缺项上报失败', S.examEngine, ['答题卡上找不到第']],

  // ── P2 中危 ──
  ['M9', '中', '调度器 await 钩子', S.sched, ['safeAwait', 'await safeAwait(() => hooks.onTaskDone']],
  ['M9', '中', 'engine 去掉错误的补空逻辑', S.engine, ['不再需要"补空"兜底']],
  ['M10', '中', '侦测器可重新触发', S.watcher, ['settled = false']],
  ['M11', '中', 'SW 状态持久化', S.bg, ['session:run', 'PersistedRun', 'persistRun']],
  ['M11', '中', '恢复完成前不判续跑', S.bg, ['await restorePromise']],

  // ── P3 低危 ──
  ['L1', '低', 'confidence 缺省 0.5', S.validate, ['?? 0.5']],
  ['L2', '低', 'joinUrl 认 /vN 结尾', S.client, ['/\\/v\\d+$/']],
  ['L3', '低', '图片大小上限', S.imageFetch, ['MAX_IMAGE_BYTES']],
  ['L3', '低', '图片类型嗅探', S.imageFetch, ['sniffImageType']],
  ['L5', '低', '考试页分支限定顶层', S.contentIndex, ['window.top === window']],
  ['L6', '低', 'package.json 版本同步', S.pkg, ['"version": "1.0.13"']],
  ['L6', '低', 'manifest 版本', S.wxt, ["version: '1.0.13'"]],
  ['L8', '低', 'legacy 稳定题目 id', S.parseLegacy, ['stableId']],
  ['L9', '低', 'stop 后不再发请求', S.sched, ['record.status = \'skipped\'']],

  // ── 需真机确认 / 本轮补修 ──
  ['M12', '中', 'UEditor 二级路径补同步事件', S.ueditor,
    ['keyup', 'textarea[id^="ueditor"]', '尚未在真实作业页验证过'], '本轮自审发现遗漏后补修；行为需真机'],
];

/**
 * 清单内**明示不修**的两条（有明确理由），单独列出，不计入通过率 ——
 * 避免用"故意写假的匹配串"来凑数。
 */
const EXEMPT = [
  [
    'L7',
    '真正的旧版页面选择器仍未校准 —— 2026-10-16 已确认 dowork 属**新版结构**并改走 parse/exam.ts（见 isExamStylePage）；' +
      '剩下只有真·旧版形态未验证，缺真实样本',
  ],
  ['L10', 'API Key 明文存 chrome.storage.local —— 扩展的常规做法，已知并接受的风险，说明文档已警示'],
];

let pass = 0;
const failed = [];
for (const [id, level, desc, src, needles, note] of CHECKS) {
  const missing = needles.filter((n) => !src.includes(n));
  const ok = missing.length === 0;
  if (ok) pass += 1;
  else failed.push({ id, desc, missing });
  const tag = ok ? '✓' : '✗';
  const why = missing.length ? `  缺: ${missing.map((m) => JSON.stringify(m)).join(', ')}` : '';
  const nt = note ? `  — ${note}` : '';
  console.log(`${tag} [${level}][${id}] ${desc}${nt}${why}`);
}
console.log(`\n合计 ${pass}/${CHECKS.length} 条核验通过`);
if (failed.length) {
  console.log('\n未通过明细:');
  for (const f of failed) console.log(`  - [${f.id}] ${f.desc}`);
}
if (EXEMPT.length) {
  console.log(`\n另有 ${EXEMPT.length} 条为清单内"明示不修"（不计入通过率）:`);
  for (const [id, why] of EXEMPT) console.log(`  ⊘ [${id}] ${why}`);
}
