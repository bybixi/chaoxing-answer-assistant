import { defineConfig } from 'wxt';
import { existsSync, readFileSync } from 'node:fs';

const CHAOXING = [
  'https://*.chaoxing.com/*',
  'https://*.chaoxing.com.cn/*',
  'https://*.chaoxing.cn/*',
];

// AI 供应商域名：只列实际使用的。用多少加多少 —— 每多一条，
// 用户安装时就会多一行"读取和更改您在 xxx 上的数据"的权限提示。
const AI_HOSTS = ['https://api.deepseek.com/*'];

/**
 * 固定公钥（可选）：写进 manifest 后扩展 ID 由公钥决定，与加载目录解耦 ——
 * 换文件夹、改名、重装都不会丢配置。
 *
 * 公钥**不放进仓库**：它绑定具体的扩展实例身份（上架后还与开发者账号绑定）。
 * 想启用同款能力，跑 `node tools/gen-ext-key.mjs` 生成自己的密钥对，
 * 公钥写到 `.keys/public-key.txt` 即可（该目录已 gitignore）。
 */
const FIXED_KEY_FILE = '.keys/public-key.txt';
const fixedKey = existsSync(FIXED_KEY_FILE)
  ? readFileSync(FIXED_KEY_FILE, 'utf8').trim()
  : undefined;

export default defineConfig({
  manifest: {
    name: '智答',
    description: '学习通作业/考试自动答题助手（个人学习辅助工具）',
    version: '1.0.15',
    ...(fixedKey ? { key: fixedKey } : {}),
    minimum_chrome_version: '116',
    // 只保留真正用到的权限（storage）
    // 注意：debugger 不能放进 optional_permissions —— Chrome 会报
    // "Permission 'debugger' cannot be listed as optional" 并丢弃它。
    // 本项目改用「直调页面 addChoice」实现回填，已不需要 debugger。
    // 若将来必须用 CDP 真实输入，把它加进下面的 permissions 数组（会多一条权限提示）。
    permissions: ['storage'],
    host_permissions: [...CHAOXING, ...AI_HOSTS],
    // ★ 内容脚本往页面 DOM 里插 <img src="chrome-extension://..."> 时，
    //   该资源必须声明为 web_accessible_resources，否则页面无权加载 → 显示"破图"
    web_accessible_resources: [
      {
        resources: ['icon/*.png'],
        matches: CHAOXING,
      },
    ],
    // 图标（tools/make-icon.py 生成，16/32 用简化版、48+ 用完整版）
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    },
    // 工具栏按钮：点击打开设置页（无 popup，由 SW 的 action.onClicked 处理）
    action: {
      default_title: '智答 · 点击打开设置',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png' },
    },
  },
  hooks: {
    // WXT 生成清单时会用默认值覆盖 options_ui，这里在生成后改回独立标签页
    'build:manifestGenerated': (_wxt, manifest) => {
      manifest.options_ui = { page: 'options.html', open_in_tab: true };
    },
  },
});
