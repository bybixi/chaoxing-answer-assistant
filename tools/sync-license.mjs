/**
 * 把根目录的 LICENSE 同步一份到 public/，让构建产物（发布 zip）里也带上许可文本。
 *
 * 为什么需要：MIT 许可要求「许可声明必须随软件的所有副本一并分发」。
 * 仓库里有 LICENSE 已被 GitHub 识别，但从仓库分发出的扩展包也是"副本"，
 * 因此把它放进 public/（WXT 会把 public/ 原样拷进产物根目录）。
 *
 * 单一事实来源仍是根目录的 LICENSE —— public/LICENSE.txt 属于生成物，已 gitignore。
 * 由 package.json 的 prebuild / prezip 自动执行。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SRC = 'LICENSE';
// public/ 下的用 .txt 后缀，避免被工具误认成第二份"许可证文件"
const DEST = 'public/LICENSE.txt';

if (!existsSync(SRC)) {
  console.error(`✗ 找不到 ${SRC}，跳过许可同步`);
  process.exit(1);
}

writeFileSync(DEST, readFileSync(SRC, 'utf8'), 'utf8');
console.log(`✓ 已同步许可文本 → ${DEST}（随构建产物分发，满足 MIT 的分发要求）`);
