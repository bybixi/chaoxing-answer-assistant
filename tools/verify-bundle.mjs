/** 产物核验（文件方式，避免 shell 传中文被编码破坏） */
import { readFileSync, readdirSync } from 'node:fs';

const bg = readFileSync('.output/chrome-mv3/background.js', 'utf8');
const ct = readFileSync('.output/chrome-mv3/content-scripts/content.js', 'utf8');
const optFile = readdirSync('.output/chrome-mv3/chunks').find((f) => f.startsWith('options'));
const opt = readFileSync(`.output/chrome-mv3/chunks/${optFile}`, 'utf8');

/**
 * 字符串在产物里可能有两种形态：原样，或非 ASCII 被 esbuild 转义成 \uXXXX。
 * ⚠️ esbuild 用**大写**十六进制（如 \u5BF9），小写匹配会全部漏掉 —— 踩过这个坑。
 */
function form(src, text) {
  if (src.includes(text)) return '原样';
  const variants = [
    (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
    (c) => '\\u' + c.charCodeAt(0).toString(16).toLowerCase().padStart(4, '0'),
  ];
  for (const [i, enc] of variants.entries()) {
    const name = i === 0 ? '大写转义' : '小写转义';
    const escAll = [...text].map(enc).join('');
    if (src.includes(escAll)) return name;
    const escNonAscii = [...text]
      .map((c) => (c.charCodeAt(0) > 127 ? enc(c) : c))
      .join('');
    if (src.includes(escNonAscii)) return `${name}(仅非ASCII)`;
  }
  return null;
}

const cases = [
  ['background', bg, '已停止', '既有中文串（对照组）'],
  ['background', bg, 'SW 重启后已恢复', 'P2-4 SW 恢复提示'],
  ['background', bg, '非本轮标签页', 'P1-1 多标签页隔离'],
  ['background', bg, 'session:run', 'P2-4 session 持久化 key'],
  ['background', bg, 'AbortSignal.timeout', 'P0-2 请求超时'],
  ['content', ct, 'toClickOff', 'P0-1 选择对齐属性'],
  ['content', ct, '存在非目标选项仍被选中', 'P0-1 多选残留校验'],
  ['content', ct, '答题卡上找不到第', 'P2-3 导航失败上报'],
  ['content', ct, '本题已填', '既有中文串（对照组2）'],
  ['options', opt, '已按有效范围修正', 'P1-5 设置页钳制提示'],
];

let pass = 0;
for (const [area, src, needle, desc] of cases) {
  const how = form(src, needle);
  if (how) pass += 1;
  console.log(`${how ? '✓' : '✗'} [${area}] ${desc}${how ? ` (${how})` : ''}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
