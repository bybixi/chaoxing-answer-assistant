import { browser } from '#imports';
import { getSettings, saveSettings } from '../../shared/storage';
import type { Settings } from '../../shared/types/settings';

const FIELDS: (keyof Settings)[] = [
  'apiBase',
  'apiKey',
  'model',
  'visionModel',
  'concurrency',
  'minGapMs',
  'maxGapMs',
  'maxPerMinute',
  'retries',
  'minConfidence',
  'validateRetries',
  'thinkingEffort',
];
const CHECKS: (keyof Settings)[] = ['autoRun', 'autoSubmit', 'thinking', 'reviewLowConfidence'];

/** 把设置回填到表单 */
function fillForm(s: Settings): void {
  for (const k of FIELDS) {
    const el = document.getElementById(k) as HTMLInputElement | null;
    if (el) el.value = String(s[k] ?? '');
  }
  for (const k of CHECKS) {
    const el = document.getElementById(k) as HTMLInputElement | null;
    if (el) el.checked = Boolean(s[k]);
  }
}

function toast(msg: string, color = '#059669'): void {
  const el = document.getElementById('saved');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color;
  el.style.opacity = '1';
  setTimeout(() => (el.style.opacity = '0'), 2200);
}

/** 数值字段的有效范围（超出即钳制）—— 早期实现把清空的输入框存成 0，
 *  例如清空"最低置信度"会让"宁空不错"防线直接失效 */
const NUMBER_RANGES: Partial<Record<keyof Settings, { min: number; max: number }>> = {
  concurrency: { min: 1, max: 10 },
  minGapMs: { min: 0, max: 60_000 },
  maxGapMs: { min: 0, max: 60_000 },
  maxPerMinute: { min: 1, max: 600 },
  retries: { min: 0, max: 5 },
  validateRetries: { min: 0, max: 5 },
  minConfidence: { min: 0, max: 1 },
};

let clampedNotice = false;

function collectPatch(): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  clampedNotice = false;

  for (const k of FIELDS) {
    const el = document.getElementById(k) as HTMLInputElement | null;
    if (!el) continue;

    if (el.type !== 'number') {
      patch[k] = el.value.trim();
      continue;
    }
    // ★ 空值跳过（保留旧值），不能存 0
    if (el.value.trim() === '') continue;

    const num = Number(el.value);
    if (!Number.isFinite(num)) continue;

    const range = NUMBER_RANGES[k];
    if (!range) {
      patch[k] = num;
      continue;
    }
    const clamped = Math.min(range.max, Math.max(range.min, num));
    if (clamped !== num) clampedNotice = true;
    patch[k] = clamped;
  }

  // 间隔上下限的相互关系：min > max 时把 min 拉回 max
  if (typeof patch.minGapMs === 'number' && typeof patch.maxGapMs === 'number') {
    if (patch.minGapMs > patch.maxGapMs) {
      patch.minGapMs = patch.maxGapMs;
      clampedNotice = true;
    }
  }

  for (const k of CHECKS) {
    const el = document.getElementById(k) as HTMLInputElement | null;
    if (el) patch[k] = el.checked;
  }
  return patch;
}

async function init(): Promise<void> {
  // 版本号从 manifest 直接读 —— 单一事实来源，永远不会和构建产物漂移
  const verEl = document.getElementById('ver');
  if (verEl) {
    try {
      verEl.textContent = `v${browser.runtime.getManifest().version}`;
    } catch {
      /* 忽略 */
    }
  }

  fillForm(await getSettings());

  document.getElementById('save')?.addEventListener('click', async () => {
    const patch = collectPatch();
    await saveSettings(patch as Partial<Settings>);
    if (clampedNotice) toast('已保存 ✓（部分数值已按有效范围修正）', '#b45309');
    else toast('已保存 ✓');
  });

  // ── 导出配置：换文件夹/换电脑/重装后一秒恢复，不用手填 ──
  document.getElementById('export')?.addEventListener('click', async () => {
    const s = await getSettings();
    const text = JSON.stringify(s);
    const ta = document.getElementById('cfg') as HTMLTextAreaElement | null;
    if (ta) ta.value = text;
    try {
      await navigator.clipboard.writeText(text);
      toast('已导出并复制到剪贴板（含 API Key，勿外发）');
    } catch {
      toast('已导出到下方文本框，请手动复制', '#b45309');
    }
  });

  // ── 导入配置 ──
  document.getElementById('import')?.addEventListener('click', async () => {
    const ta = document.getElementById('cfg') as HTMLTextAreaElement | null;
    const raw = ta?.value.trim() ?? '';
    if (!raw) {
      toast('先把导出的配置粘进文本框', '#b91c1c');
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const saved = await saveSettings(parsed);
      fillForm(saved);
      toast('导入成功 ✓');
    } catch {
      toast('导入失败：不是合法的配置文本', '#b91c1c');
    }
  });
}

void init();
