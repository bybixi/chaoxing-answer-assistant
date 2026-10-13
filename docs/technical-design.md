# 智答 · 学习通自动答题助手 — 技术设计文档

| 项 | 内容 |
|---|---|
| 文档版本 | **v2.0**（取代 v1.0 PageAgent 草案） |
| 日期 | 2026-10-13 |
| 工作代号 | 智答 / AutoAnswer |
| 目标平台 | 超星学习通（chaoxing）作业答题页 |
| 技术栈 | Manifest V3 + **WXT 0.20** + TypeScript（已定稿，代码在 `zhi-da/`） |
| 使用方式 | 个人学习使用 · 自带 API Key（BYOK） |
| 交付形态 | 技术设计文档（Markdown） |

> **v1 → v2 的变更**：v1 是"用户发起的通用网页 AI 助手"，v2 收敛为"**全自动侦测 → 求解 → 回填**的学习通答题工具"。触发主体从人变成页面变化，内容脚本必须常驻，主界面从侧边栏退化为页面内浮球 + 设置页。v1 的 Stage 1 技术规范章节仍然有效，已并入 §3。

---

## 目录

- [§1 需求定义（已对齐）](#1-需求定义已对齐)
- [§2 目标平台技术分析（学习通）](#2-目标平台技术分析学习通)
- [§3 Chrome 扩展技术规范与踩坑（沿用 v1，已按本站点场景收敛）](#3-chrome-扩展技术规范与踩坑)
- [§4 功能定位、核心流程、权限与技术栈](#4-功能定位核心流程权限与技术栈)
- [§5 整体架构与文件结构](#5-整体架构与文件结构)
- [§6 本地开发与调试环境](#6-本地开发与调试环境)
- [§7 附录 · 决策、待办、风险](#7-附录--决策待办风险)

---

# 1. 需求定义（已对齐）

## 1.1 一句话

在学习通作业页打开时，扩展**自动侦测整卷题目 → 逐题调用 AI 求解 → 自动回填答案 → 保存**，全流程无需人工介入。

## 1.2 需求清单

| 维度 | 结论 |
|---|---|
| 使用场景 | 刷题练习 / 学习通作业自查 |
| 题目类型 | **全覆盖**（单选、多选、判断、填空、简答，及连线、排序、完形填空等特殊题型尽量覆盖） |
| 图片题 | **有**，题干与选项中都可能出现图片 |
| 页面加载模式 | **一次性加载整卷**（非逐题切换） |
| 触发方式 | **全自动**（检测到题目即抓取、求解、回填） |
| 完成动作 | 回填后**保存**（非提交） |
| 准确率要求 | **尽量不要打错** —— 允许因不确定而留空，不允许硬猜 |
| 是否展示推理过程 | 否 |
| 多模型交叉验证 | 不需要 |
| 答题历史留档 | 不需要 |
| 并发 | 需要**可自定义的并发调度**（见 §5.4） |
| debugger 兜底 | **接受**（见 §5.3 的代价说明） |
| API Key | 自己填（BYOK） |
| 分发范围 | 个人学习使用，不发布到商店 |

## 1.3 明确的非目标

- 不做视频刷课、不做进度伪造上报（伪造服务端接口极易触发风控，收益低风险高）
- 不做监考环境下的规避检测（不涉及隐藏窗口、不涉及对抗监考进程）
- 不自动点"提交"（见 §5.5）
- 不做题库云端同步、不做多用户

## 1.4 边界说明（一次性声明，不再重复）

超星的"作业"多数带计分属性。这个工具用于**自己练习、核对答案、省去手工录入**没问题；若用于提交计分作业或考核，属于学术诚信问题，风险由你自行承担。文档中不包含任何针对监考/反作弊系统的对抗设计。

---

# 2. 目标平台技术分析（学习通）

> 来源：学习通官方学生手册、教学平台使用手册，以及多个公开用户脚本的实现说明（Greasy Fork / GitHub）。**DOM 选择器部分我尚未实测，全部标记为待验证假设**，落地时需在真机逐个确认。

## 2.1 页面结构：顶层壳 + 多个跨域 iframe ★最容易低估的复杂点

学习通课程页不是单页，而是这样的嵌套结构：

```
顶层页 studentstudy (chaoxing.com)
├─ iframe  /ananas/modules/video/...     → 视频模块
├─ iframe  /ananas/modules/work/...      → 作业 / 测验模块   ★ 我们只关心这个
└─ iframe  /ananas/modules/read/...      → 阅读模块
```

**关键推论：**

1. 作业题目**不在顶层文档里**，而在 `/ananas/modules/work/...` 这个 iframe 内。
2. 这些 iframe 之间**跨域**，无法直接互访 DOM。
3. **这正是 Chrome 扩展相对油猴脚本的优势所在**：扩展内容脚本配合 `all_frames: true` 与正确的 `matches`，可以注入到每一个 iframe；各 frame 之间通过 `chrome.runtime.sendMessage` + SW 路由通信（用 `sender.tab.id` / `sender.frameId` 定位），**不需要像油猴脚本那样靠 GM_setValue 传信号绕跨域**。

## 2.2 目标 URL 匹配清单

| 用途 | URL 模式 |
|---|---|
| 作业查看页 | `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view*` |
| 作业答题页 | `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork*` |
| 站点域名族 | `*.chaoxing.com`、`*.chaoxing.com.cn`、`*.chaoxing.cn` |

> 域名族里还包含图片 CDN 子域（如 `p.ananas.chaoxing.com` 一类），`https://*.chaoxing.com/*` 这一条通配即覆盖。**具体子域需实测补全**，图片抓不到通常就是这里漏了域名。

## 2.3 题型清单

官方支持题型（学生端实际会出现的是前 5 类）：

| 题型 | 回填方式 | 难度 |
|---|---|---|
| 单选题 | 点 radio（或点 label） | 低 |
| 多选题 | 逐个点 checkbox | 低 |
| 判断题 | 点 radio（对/错） | 低 |
| 填空题 | 多个文本框，按空位顺序填 | 中 |
| 简答题 | **富文本编辑器**，见 §2.4 | 高 |
| 连线题 / 排序题 / 完形填空 / 阅读理解 / 计算题 / 名词解释 / 论述题 | 结构各异 | 高，首版可降级处理 |

**首版策略**：前 5 类完整支持；特殊题型先按"文本作答"尝试，失败则标记跳过，不阻塞整卷。

## 2.4 简答题 = UEditor 富文本 ★第二个必踩的坑

超星作业页的简答题使用 **UEditor**（百度富文本编辑器）。后果：

- 直接给 `textarea.value = '...'` **完全无效**，因为编辑器早已把真实输入区替换成一个 `iframe`，`textarea` 只是占位。
- 正确做法优先级：
  1. `UE.getEditor(editorId).setContent(html)` —— 若全局 `UE` 对象可用（最干净）
  2. 拿到编辑器的 iframe，直接写 `contentDocument.body.innerHTML`，再手动触发编辑器的内容同步
  3. 解除超星的 `beforepaste` 粘贴限制后模拟粘贴（公开脚本里提到的做法）
  4. **兜底：`chrome.debugger` → CDP `Input.insertText`**，走真实输入通道

## 2.5 图片题与多模态

- 题干、选项、解析中均可能出现 `<img>`。
- 需要把相关图片**一并送进模型**，因此所配模型必须支持视觉输入（vision）。
- 若所配模型不支持 vision：图片题降级为"跳过并标记"，**不猜**。

## 2.6 保存机制（官方口径）

- 学习通作业**每答一题实时保存作答记录**，中途退出再进入可继续。
- 但**必须点击"提交"才真正计入成绩**。
- 因此"填完保存"这个需求，技术上不需要额外动作 —— 回填本身就已经触发保存。可选的"点保存按钮"只作为兜底（部分页面有显式保存按钮）。

## 2.7 风控与稳定性提示

- 平台存在行为特征统计与前端反调试手段的说法（`debugger` 埋点、`Function.prototype.toString` 特征比对）。**这部分来自第三方文章，未经验证**，但足以说明：**不要高频、规律、暴力地灌请求**。这也是 §5.4 并发调度器存在的原因。
- 平台会改版。所有选择器必须集中在**单一文件**（`selectors.ts`）里，改版时单点修复。
- 公开脚本作者的经验：**绝不伪造服务端上报接口**（伪造 log / 进度接口"风险高且极易被风控，不做"）。本项目同理 —— 只做"读页面 → 填页面"，不碰网络请求改写。

---

# 3. Chrome 扩展技术规范与踩坑

> 本节沿用 v1.0 的官方文档检索结果，已按本项目场景收敛。

## 3.1 MV3 是唯一选项

MV2 已彻底退场：Chrome 138 起全渠道停用且用户无法重开；企业豁免策略随 Chrome 139 移除；2026-08-31 所有残留 MV2 扩展已从应用商店下架。

`minimum_chrome_version` 建议 `"116"`（覆盖 WebSocket 保活、部分 API 豁免 5 分钟上限等生命周期改进）。

## 3.2 Service Worker 生命周期

| 条件 | 阈值 |
|---|---|
| 空闲无操作 | **30 秒**后终止 |
| 单个事件 / API 调用处理时长 | 超过 **5 分钟**终止 |
| `fetch()` 响应到达时长 | 超过 **30 秒**终止 |

事件与扩展 API 调用会重置计时器。三条硬约束：

1. 状态一律落 `chrome.storage`（SW 中**没有** `localStorage`）
2. 定时任务只能用 `chrome.alarms`，`setTimeout` / `setInterval` 不可靠
3. **所有事件监听器顶层同步注册**，不能包在 `async` 函数里

## 3.3 权限模型

| 键 | 语义 |
|---|---|
| `permissions` | 安装时授予的 API 权限 |
| `host_permissions` | 安装时授予的主机访问权限 |
| `optional_permissions` / `optional_host_permissions` | 运行时由用户授予 |

**本项目因为限定了站点，权限可以做得非常精确** —— 不需要 `<all_urls>`，只声明 chaoxing 域名族 + AI 供应商域名即可。这是"限定站点"换来的最大收益。

## 3.4 内容脚本

- `run_at`：默认 `document_idle`。本项目整卷一次性加载，`document_idle` 足够；若题目是异步渲染的，改用 `MutationObserver` 等待而非提前抢跑。
- `world`：使用默认 `ISOLATED`（能用 chrome API、与页面 JS 隔离）。**只有确认页面 JS 变量必须读取时才启用 `MAIN`**，因为 MAIN world 下页面可以干扰你的脚本。
- `all_frames: true`：**本项目必须开**，否则注入不进作业 iframe。

## 3.5 消息通信四条铁律

| 规则 | 后果 |
|---|---|
| 异步 `sendResponse` 必须 `return true` | 忘记则响应静默不到达、**不报错** |
| SW 内只保留**一个** `onMessage` 监听器（路由器） | 多监听器只有第一个 `sendResponse` 生效 |
| 长连接 `port.onMessage` 必须同步挂载 | 先 `await` 再挂载会丢首条消息 |
| 消息体必须可 structured-clone | 不能带 DOM 节点、函数 |

## 3.6 CSP 与安全

- 禁内联脚本、禁 `eval`；所有逻辑放独立 JS 文件。
- 禁止远程托管代码，依赖全部打包。
- **AI 返回的答案文本必须当数据用**，绝不拼进代码执行。

## 3.7 打包与调试

- 打包时 `manifest.json` 必须在 zip 根目录；`background.service_worker` 引用的文件必须真实存在。
- **SW 的 DevTools 开着会人为保活**，会掩盖"休眠后状态丢失"类 bug。测终止行为必须关掉 DevTools，用 `chrome://serviceworker-internals` 手动 Stop。
- 构建需关掉 Vite 的 `modulePreload`，否则内联脚本会被商店拒审（本项目不上商店，但保持习惯）。

## 3.8 高频踩坑 Top 10（本项目相关度 ★ 标注）

| # | 坑 | 相关度 |
|---|---|---|
| 1 | 全局变量存状态，SW 休眠后丢失 | ★★★ |
| 2 | 异步 `sendResponse` 未 `return true` | ★★★ |
| 3 | 监听器注册过晚导致消息丢失 | ★★★ |
| 4 | 用 `setTimeout` 代替 `chrome.alarms` | ★★ |
| 5 | 少声明权限 → API 静默失效且无提示 | ★★★ |
| 6 | 权限过宽触发警告 | ★（本站点已精确限定） |
| 7 | **React/Vue 受控组件**：直接改 `.value` 不触发框架 onChange，提交时是空的 | ★★★ |
| 8 | **富文本编辑器**（UEditor）：设 `value` 完全无效 | ★★★ |
| 9 | iframe 未开 `all_frames` → 内容脚本根本没注入 | ★★★ |
| 10 | 只在 DevTools 打开时测试 → 掩盖 SW 终止 bug | ★★ |

---

# 4. 功能定位、核心流程、权限与技术栈

## 4.1 核心流程（六步闭环）

```
① 侦测    作业 iframe 内 MutationObserver 检测题目容器出现 & 稳定
              ↓
② 抓题    逐题解析：题型 / 题干文本 / 选项 / 图片 → 结构化 Question[]
              ↓
③ 求解    并发调度器 → 逐题调用 AI（结构化输出），图片题并入图片
              ↓
④ 校验    本地答案校验（题型约束 + 选项集合约束）→ 不通过则重试，仍失败则留空
              ↓
⑤ 回填    按题型分派回填器（radio / checkbox / input / UEditor）
              ↓
⑥ 保存    依赖超星实时保存；可选点显式保存按钮
```

## 4.2 权限清单

| 权限 | 用途 | 说明 |
|---|---|---|
| `storage` | 设置、API Key、运行时状态 | 必需 |
| `debugger` | 回填失败时走 CDP 真实输入兜底 | 见下方代价说明 |
| `alarms` | 超时兜底、失败重试队列 | 建议 |
| `scripting` | 需要编程式注入时使用 | 可选（已有声明式 content script） |
| `host_permissions` | `*.chaoxing.com` / `*.chaoxing.com.cn` / `*.chaoxing.cn` + AI 供应商域名 | 必需 |
| `content_scripts` | `matches` 同上，**`all_frames: true`** | 必需 |

**明确不申请**：`<all_urls>`、`webRequest`、`declarativeNetRequest`、`tabs` 敏感属性、`sidePanel`。

### `debugger` 权限的真实代价（必须知情）

| 代价 | 说明 |
|---|---|
| 顶部常驻横幅 | 启用期间浏览器顶部会有"正在调试此浏览器"提示条 |
| 与 DevTools 互斥 | 调试会话期间不能同时打开 DevTools |
| 性能开销 | 有一定额外开销 |
| 卸载需重启 | 部分情况下需重启浏览器才彻底释放 |

**设计对策**：`debugger` **默认不启用**，只在"常规回填失败"且用户在设置里显式开启"兜底模式"时才按需 attach，用完立即 detach。这样日常使用不受横幅干扰。

## 4.3 设置项（设置页 = `options.html`）

| 分区 | 项 | 默认值 |
|---|---|---|
| 模型 | API 地址（baseURL） | 空 |
| 模型 | API Key | 空 |
| 模型 | 文本模型名 | 空 |
| 模型 | **视觉模型名**（图片题用，可与上不同） | 空 |
| 并发 | 最大并发数 | `3`（范围 1–10） |
| 并发 | 请求间隔（随机区间 ms） | `200–800` |
| 并发 | 每分钟请求上限 | `60` |
| 并发 | 最大重试次数 | `3` |
| 并发 | 失败项自动重试 | 开 |
| 行为 | 自动回填 | 开 |
| 行为 | **自动点"提交"** | **关**（见 §5.5） |
| 行为 | debugger 兜底模式 | 关 |
| 行为 | 不确定时留空（不猜） | **开** |
| 行为 | 全局开关（页面浮球） | 开 |

## 4.4 技术栈说明（回答"第三个我不懂"）

你说的"第三个"指的是我上一轮问的 **Vite + CRXJS + TypeScript**。用大白话解释：

| 名词 | 是什么 | 解决什么问题 |
|---|---|---|
| **TypeScript** | JavaScript 加上类型标注 | 写代码时编辑器就能提示"这里参数该是数字"，把低级错误挡在运行前。本项目题型适配 + 并发 + 消息协议逻辑量大，收益明显 |
| **Vite** | 一个构建工具 | 把 TypeScript 源码编译打包成浏览器能直接跑的文件；开发时改代码自动刷新 |
| **CRXJS** | 一个 Vite 插件 | 专门让 Vite 能正确打包 Chrome 扩展：自动生成 manifest、处理内容脚本注入、支持热更新。没有它，Vite 打出来的目录结构 Chrome 不认 |

**替代方案：零构建原生 JS。** 不装任何工具，直接写 `.js` 文件，整个目录就是扩展本体，改完点一下重载即可。

**两者的取舍：**

| | Vite + CRXJS + TS | 零构建原生 JS |
|---|---|---|
| 上手 | 需要先装 Node 和依赖 | 只要浏览器 |
| 代码规模承受力 | 强（本项目预计 3000+ 行） | 超过约 1500 行就难维护 |
| 改代码后 | 自动热更新 | 手动点重载 |
| 出错排查 | 需要先理解构建产物 | 所见即所得 |
| 类型保护 | 有 | 无 |

### 4.4.1 框架/构建工具选型（2026-10 调研）

先纠正一个常见误解：**大多数已发布的浏览器扩展其实不用任何框架**，就是原生 JS 加一个打包器。"框架"在扩展领域指的是**构建工具**；UI 框架（React/Vue）只影响设置页这类界面，与核心逻辑无关。

当前（2026 年 10 月）主流选项：

| 工具 | 定位 | 构建器 | 跨浏览器 | 维护状态 | 说明 |
|---|---|---|---|---|---|
| **WXT** | 完整框架（Nuxt 风格） | Vite | Chrome/Firefox/Safari/Edge | **活跃**（2026-08 有发布） | 文件约定式入口、自动生成 manifest、自带 storage / 消息封装、默认 TS。Eye Dropper（100 万用户）、ChatGPT Writer（60 万用户）在用 |
| **Plasmo** | React 优先的 SDK | Parcel | Chrome/Firefox/Edge | **停滞**（核心版本停在 2025-05） | 内容脚本 UI 注入（CSUI + Shadow DOM 隔离）同类最强；但维护放缓是真实风险 |
| **CRXJS** | Vite 插件（**不是框架**） | Vite | 仅 Chromium | 曾停更 3 年，2025 年被新维护者复活 | 抽象最薄、内容脚本 HMR 最快（约 180ms）、无框架锁定；但**曾被弃坑一次，长期承诺未经验证** |
| **Extension.js** | 零配置 CLI | Rspack（内部） | Chrome/Edge/Firefox/Safari | 活跃 | `manifest.json` 作为唯一事实来源；构建器是内部细节，升级由框架负责 |
| `@samrum/vite-plugin-web-extension` | 更低层的 Vite 方案 | Vite | Chrome/Firefox | 一般 | 需要更细粒度控制时可考虑 |

**UI 框架层面**：用得最多的是 React，其次 Vue / Svelte / Preact，也有很多纯原生。**但对本项目几乎不重要** —— 我们只有一个页面内浮球 + 一个设置页，上 React 属于杀鸡用牛刀，原生或 Preact 足够。

### 4.4.2 对本项目的建议（已修正）

我上一版推荐 CRXJS，**看过维护历史后改口**：CRXJS 曾被弃坑三年，2025 年才由新维护者复活，长期承诺未经验证。而这个项目需要长期跟学习通改版维护，**工具链的稳定性比"少一层抽象"更重要**。

| 方案 | 适合度 | 说明 |
|---|---|---|
| **WXT** | ✅ **推荐** | 维护活跃度、DX、跨浏览器三项都稳。自带 storage / 消息封装（我们仍会写自己的类型化包装，但底层可用）。约定式目录，manifest 可在 `wxt.config.ts` 精确覆盖 —— 我们需要的 `all_frames`、`optional_permissions` 都能配 |
| **Extension.js** | ✅ 备选 | `manifest.json` 是唯一事实来源，对需要精确控制清单的我们很友好；零配置，上手最快 |
| **CRXJS** | ⚠️ 可行 | 抽象最薄、无锁定、出问题好排查；但要接受维护风险 |
| **零构建原生 JS** | ⚠️ 不推荐 | 不装工具，目录即扩展本体。本项目预计 3000+ 行，超过约 1500 行就难维护 —— 可行，但不划算 |

> **选 WXT 的话，§5.9 的目录结构需改为 `entrypoints/` 约定式布局**（`entrypoints/background.ts`、`entrypoints/content/index.ts`、`entrypoints/options/`），逻辑分层完全不变。

**TypeScript 建议不变**：本项目的重活（全题型回填、iframe 多实例通信、并发调度、答案校验）容易出隐蔽 bug，类型保护值这个成本。

**已定稿：WXT。** 代码骨架已落地在 `zhi-da/`（WXT 的 `entrypoints/` 约定式布局），已通过 `wxt build` 生产构建与 15 项单元测试（vitest）。

> 实际代码与 §5.9 的差异：`manifest.config.ts` → `wxt.config.ts`（WXT 约定）；`src/background` → `entrypoints/background.ts`；`src/content` → `entrypoints/content/`；`src/options` → `entrypoints/options/`；`shared/` 与 `scheduler/` 仍在根目录。逻辑分层完全一致。

---

# 5. 整体架构与文件结构

## 5.1 运行环境与 iframe 多实例架构

```
┌─ 顶层页 (chaoxing.com) ─────────────────────────────────┐
│  Content Script 实例 A  （识别角色：顶层壳，通常不干活）    │
│  ┌─ iframe: /ananas/modules/work/... ─────────────────┐ │
│  │  Content Script 实例 B （识别角色：作业模块 ★ 主力）  │ │
│  │   · MutationObserver 侦测整卷                        │ │
│  │   · 抓题 + 回填 + 浮球 UI                            │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                        ↕ chrome.runtime.sendMessage
┌─ Service Worker ────────────────────────────────────────┐
│  唯一 onMessage 路由器                                   │
│   · 题目路由（按 tabId / frameId 定位来源 frame）        │
│   · 图片抓取（用 host_permissions 绕开页面 CORS）★       │
│   · 会话状态持久化（chrome.storage.session / local）      │
└─────────────────────────────────────────────────────────┘
                        ↕ fetch
                  AI 服务（BYOK，OpenAI 兼容）
```

**角色识别**：每个内容脚本实例启动时先判断自己是谁 —— URL 含 `/work/` 且页面内能找到题目容器 → 判定为"作业模块"，否则静默退出。这样同一个脚本注入到所有 frame 也不会互相干扰。

## 5.2 图片抓取为什么必须走 SW ★

- 在**内容脚本**里 fetch 跨域图片，受页面 CORS 限制，多数会失败或污染 canvas。
- 在 **SW** 里 fetch 时，只要有对应 `host_permissions`，**不受 CORS 限制**，可以直接拿到 blob 并转 base64。
- 因此：内容脚本只负责收集 `<img>` 的 `src` 列表 → 发给 SW → SW 抓取并转 base64 → 连同题目一起送给模型。

## 5.3 六项关键技术决策

| # | 决策 | 理由 |
|---|---|---|
| **D1** | **AI 请求由 SW 统一发起**（与 v1 相反） | 本项目是全自动批处理，不能依赖任何界面存活；同时图片抓取本来就必须走 SW。为规避 SW 30s/5min 上限，每个请求单独且短小（单题一请求），并配 `chrome.alarms` 做超时兜底 |
| **D2** | **内容脚本只做 DOM 读写，不做网络** | 职责单一；避免 CORS 与权限问题 |
| **D3** | **回填器按题型分派的白名单实现** | 每种题型一个独立实现 + 独立测试，互不干扰 |
| **D4** | **所有选择器集中在 `selectors.ts`** | 超星改版时单点修复，这是本类工具最大的长期维护成本 |
| **D5** | **答案不经手代码执行，且必须过本地校验** | 安全底线 + 准确率保障（§5.6） |
| **D6** | **消息协议类型化 + SW 单一路由器** | 收敛最难查的几类消息 bug |

## 5.4 自定义并发调度器 ★ 你特别要求的功能

**目标**：整卷几十道题要并发求解，但不能打爆 AI 端点、不能触发平台风控。

### 机制设计

| 机制 | 说明 | 默认值 |
|---|---|---|
| **并发池** | 信号量控制同时在途请求数 | 3（可配 1–10） |
| **随机抖动间隔** | 每次发请求前随机等待，避免规律性节奏 | 200–800ms |
| **令牌桶限流** | 滑动窗口限制单位时间请求总量 | 60 次/分钟 |
| **指数退避重试** | 429 / 5xx / 网络错误 → 退避重试（1s→2s→4s，各加随机抖动）<br>4xx（鉴权、参数错）→ **不重试**，直接上报 | 最多 3 次 |
| **校验失败重试** | 答案格式校验不过 → 附上"你的输出不符合格式"重发 | 最多 2 次 |
| **失败队列** | 重试耗尽后入队，整卷结束后可一键只重试失败项 | — |
| **可随时中断** | 停止时不等待在途请求，已完成的保留 | — |
| **优先级排序** | 客观题（单选/多选/判断/填空）优先入队；简答题与图片题靠后 | — |

> 为什么简答/图片题靠后：请求体更大、响应更慢、更容易撞限流。先让廉价的客观题跑完，用户能更早看到大部分答案。

### 实现形态

```
src/scheduler/
├─ index.ts        # 调度器入口，对外只暴露 run(tasks, options)
├─ semaphore.ts    # 并发池
├─ rateLimiter.ts  # 令牌桶
├─ retry.ts        # 退避策略
└─ queue.ts        # 优先级队列 + 失败队列
```

调度器**不 import 任何 chrome API**，是纯函数式模块，可以脱离浏览器用 vitest 完整单测（并发数是否被遵守、限流是否生效、重试次数是否正确）—— 这是把最难的逻辑拿出来单独验证的做法。

## 5.5 关于"自动提交"

需求里写的是"填完保存"。**超星作业本身就是每答一题实时保存**，回填即等于保存。而"提交"是计分动作、不可逆。

**设计：默认只回填，不点提交。** 设置里保留"自动提交"开关，**默认关闭**。理由是——一道题回填错了只是损失一题，提交错了就是整卷定稿。这个开关留给你自己决定什么时候打开。

## 5.6 准确率保障策略（对应"尽量不要打错"）

分四道关，逐层收紧：

**第一道 · 提示词层**
- 温度设为 0
- 强制**结构化输出**（JSON Schema / function calling），不解析自由文本
- 提示词要求先判定题型，再给答案；判断题答案必须在 `["对","错"]` 中取值
- 要求模型在不确定时输出 `confidence` 字段

**第二道 · 本地校验层（最关键）**

| 题型 | 校验规则 | 不通过时 |
|---|---|---|
| 单选 | 答案必须 ∈ 选项集合 | 重试 |
| 多选 | 答案必须 ⊆ 选项集合，且非空 | 重试 |
| 判断 | 必须是 `对` / `错` | 重试 |
| 填空 | 拆分后的空位数量必须与题目空位数**完全一致** | 重试 |
| 简答 | 非空，长度在合理区间 | 重试 |

**第三道 · 重试层**
- 校验失败 → 把"你的输出不符合格式要求：xxx"回灌给模型重发，最多 2 次
- 网络类失败 → 走调度器的指数退避重试

**第四道 · 留空层（兜底）**
- 所有重试耗尽，或 `confidence` 低于阈值 → **不填，标记为"未作答"**，在浮球上计数
- 这是"尽量不要打错"的直接推论：**宁可空着，不要错填**。空着你能一眼看见并手填，错填你会漏掉。

**图片题补充**：需配置支持 vision 的模型；未配置则不送图片、按不确定处理 → 留空。

## 5.7 回填策略（按题型）

| 题型 | 目标元素 | 回填动作 |
|---|---|---|
| 单选 / 判断 | `input[type=radio]` | 按选项文本匹配 → 点击对应的 `label`（而非直接设 checked，保证触发框架逻辑） |
| 多选 | `input[type=checkbox]` | 对每个应选项执行点击；已选中的不重复点 |
| 填空 | 多个 `input[type=text]` | 按空位顺序逐一赋值：**使用原生 value setter** + 派发 `input` / `change` 事件（绕过 React/Vue 受控组件问题） |
| 简答 | UEditor 实例 | 优先 `UE.getEditor(id).setContent()` → 退化到写编辑器 iframe 的 body → 再退化到 debugger `Input.insertText` |

**通用回填注意**：
- 赋值必须走**原生 setter**（`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)`），否则框架的 onChange 不触发，表现为"看着填上了，提交时是空的"。
- 事件派发用 `new Event('input', {bubbles:true})`，必要时补 `change`。
- 回填后**校验回填结果**（读回 DOM 确认值已生效），不生效则记录失败。

## 5.8 消息协议

```ts
// src/shared/types/messages.ts
export interface MessageMap {
  // content → SW
  PAGE_READY:      { req: { role: 'work' | 'shell' };             res: { ack: true } };
  QUESTIONS_FOUND: { req: { questions: Question[] };              res: { ack: true } };
  FETCH_IMAGES:    { req: { urls: string[] };                     res: { images: Record<string, string> } }; // src → base64
  ANSWER_ONE:      { req: { question: Question };                 res: { answer: Answer | null; reason?: string } };
  // SW → content
  FILL_ANSWER:     { req: { questionId: string; answer: Answer };  res: { ok: boolean; reason?: string } };
  RUN_STATE:       { req: { phase: Phase; stats: Stats };          res: { ack: true } };
}
```

**实现要求**：SW 内**只有一个** `chrome.runtime.onMessage` 监听器（`router.ts`），按 `type` 分发到各 handler，并用 `sender.tab.id` + `sender.frameId` 区分来源 frame。

## 5.9 文件结构

```
zhi-da/
├─ manifest.config.ts          # defineManifest，类型安全清单
├─ vite.config.ts
├─ tsconfig.json
├─ package.json
├─ public/icons/               # 16 / 32 / 48 / 128
└─ src/
   ├─ background/
   │  ├─ index.ts              # SW 入口：所有监听器顶层同步注册
   │  ├─ router.ts             # 唯一的 onMessage 路由器
   │  ├─ imageFetcher.ts       # 用 host_permissions 抓图转 base64
   │  └─ state.ts              # 运行时状态（chrome.storage.session）
   ├─ content/
   │  ├─ index.ts              # 入口：先做角色识别，非作业 frame 立即退出
   │  ├─ role.ts               # 角色判定（URL + 容器探测）
   │  ├─ watcher.ts            # MutationObserver：整卷侦测 + 去重
   │  ├─ parse/
   │  │  ├─ index.ts           # 整卷解析 → Question[]
   │  │  └─ selectors.ts       # ★ 所有选择器集中于此，改版单点修复
   │  ├─ fill/
   │  │  ├─ index.ts           # 按题型分派
   │  │  ├─ radio.ts
   │  │  ├─ checkbox.ts
   │  │  ├─ input.ts           # 原生 setter + 事件派发
   │  │  ├─ ueditor.ts         # UEditor 三级降级
   │  │  └─ nativeEvents.ts    # 原生 setter / 事件派发工具
   │  ├─ ui/
   │  │  └─ floatBall.ts       # 页面内浮球：进度、计数、开始/停止
   │  └─ styles.css
   ├─ options/
   │  ├─ index.html
   │  └─ main.tsx              # 模型 / 并发 / 行为 三组设置
   ├─ scheduler/               # ★ 纯逻辑，不依赖 chrome API，可单测
   │  ├─ index.ts
   │  ├─ semaphore.ts
   │  ├─ rateLimiter.ts
   │  ├─ retry.ts
   │  └─ queue.ts
   └─ shared/
      ├─ types/
      │  ├─ messages.ts        # MessageMap
      │  ├─ question.ts        # Question / Answer / 题型枚举
      │  └─ settings.ts
      ├─ ai/
      │  ├─ client.ts          # OpenAI 兼容调用（含 vision 消息体构造）
      │  ├─ prompt.ts          # 内置提示词
      │  ├─ schema.ts          # 结构化输出 schema
      │  └─ validate.ts        # ★ 本地答案校验（第二道关）
      ├─ storage.ts            # chrome.storage 类型化封装
      ├─ messaging.ts          # 类型安全 sendMessage 包装
      └─ constants.ts
└─ tests/
   ├─ scheduler.spec.ts        # 并发/限流/重试
   ├─ validate.spec.ts         # 答案校验（穷举畸形答案）
   └─ parse.spec.ts            # 解析（离线 HTML 快照）
```

## 5.10 Manifest 示例

```ts
// manifest.config.ts
import { defineManifest } from '@crxjs/vite-plugin';

const CHAOXING = [
  'https://*.chaoxing.com/*',
  'https://*.chaoxing.com.cn/*',
  'https://*.chaoxing.cn/*',
];

export default defineManifest({
  manifest_version: 3,
  name: '智答',
  version: '0.1.0',
  description: '学习通作业自动答题助手',
  minimum_chrome_version: '116',
  permissions: ['storage', 'alarms', 'scripting'],
  optional_permissions: ['debugger'],        // 兜底模式，按需启用
  host_permissions: [
    ...CHAOXING,
    // AI 供应商域名（按实际使用填写）
    'https://api.openai.com/*',
    'https://api.deepseek.com/*',
  ],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  options_page: 'src/options/index.html',
  content_scripts: [
    {
      matches: CHAOXING,
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,                     // ★ 必须，否则注不进作业 iframe
    },
  ],
  icons: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' },
});
```

> `debugger` 放在 `optional_permissions` 里，用户开启"兜底模式"时再运行时申请 —— 这样默认安装不会有横幅，也不会有"读取调试信息"的权限警告。

---

# 6. 本地开发与调试环境

## 6.1 前置与初始化

Node ≥ 20（建议 22 LTS）、Vite 5+、`@crxjs/vite-plugin@latest`（版本必须与 Vite 匹配）。

```bash
npm create vite@latest zhi-da -- --template react-ts
cd zhi-da
npm i -D @crxjs/vite-plugin@latest @types/chrome
```

## 6.2 `vite.config.ts` 必配

```ts
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,        // 必配
    hmr: { port: 5173 },     // 必配：与 server.port 一致，否则 HMR 连不上
  },
  build: { modulePreload: false },
});
```

## 6.3 加载与热重载边界

`npm run dev` → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 **`dist/`**。

| 改动 | 行为 |
|---|---|
| Options 页 | 完整 HMR |
| **Content Script** | 真 HMR（但 **iframe 内的实例需要刷新目标页面才生效**） |
| Service Worker | 触发整个扩展重载 |
| **manifest.json** | **必须手动重载扩展** |

## 6.4 本项目专项调试要点

1. **确认内容脚本注进了 iframe**：在作业 iframe 上右键 → 检查 → Console，看有没有你的日志。注不进去八成是 `all_frames` 或 `matches` 的问题。
2. **DevTools 的 frame 切换**：页面 DevTools 左上角有执行上下文下拉框，能看到顶层和各个 iframe，逐层切进去看。
3. **测 SW 终止**：先关掉 SW 的 DevTools（开着会保活、掩盖 bug），再用 `chrome://serviceworker-internals` 手动 Stop，观察能否恢复。
4. **测消息丢失**：`sendMessage` 与 `onMessage` 两端都打带 `requestId` + `frameId` 的结构化日志。
5. **离线解析测试**：把作业页 HTML 存成快照放进 `tests/fixtures/`，用 vitest 直接跑解析器 —— 不用每次开浏览器就能验证选择器，改版后改选择器时效率极高。
6. **调度器单测**：`scheduler/` 是纯模块，单测覆盖并发数上限、限流窗口、退避次数、中断行为。
7. **回填后必读回**：每次回填后立刻读回 DOM 确认值生效，这是发现"受控组件吞值"的唯一手段。

## 6.5 建议的落地顺序（降低不确定性）

1. **先做侦察**：手动打开一个作业页，在 DevTools 里把题目 DOM 结构、题型数量、图片 URL 域名摸清楚，产出 `selectors.ts` 第一版。
2. 搭骨架：manifest + SW 路由器 + content 角色识别 + 浮球。
3. 只做**单选**：抓题 → 求解 → 回填 → 读回校验，跑通最小闭环。
4. 依次补：多选 → 判断 → 填空 → 简答（UEditor）。
5. 最后接：图片抓取 + vision、并发调度器、留空策略、debugger 兜底。

> 第 1 步是**整个项目不确定性最高的地方**。选择器一旦摸准，后面都是工程问题。建议先花半天做这一步。

---

# 7. 附录 · 决策、待办、风险

## A. 已确认决策

| 项 | 决定 |
|---|---|
| 功能定位 | 学习通作业页全自动侦测 → 求解 → 回填 → 保存 |
| 题型覆盖 | 全覆盖，首版保证单选/多选/判断/填空/简答 |
| 图片题 | 支持，需配置 vision 模型 |
| 触发方式 | 全自动 |
| 并发 | 可自定义（并发数 / 间隔 / 每分钟上限 / 重试次数） |
| debugger | 接受，作为回填兜底，默认关闭 |
| 提交行为 | **默认只回填不提交**，自动提交为可选项且默认关 |
| 准确率策略 | 宁可留空，不可错填 |
| API Key | 自己填（BYOK，OpenAI 兼容） |
| 分发范围 | 个人学习使用，不发布到商店 |
| 技术栈 | WXT + TypeScript（已定稿） |

## B. 落地待办（按优先级）

- [ ] **实测学习通作业页 DOM 结构**，产出 `selectors.ts` 第一版（最高优先级，不确定性最大）
- [ ] 确认题目图片的实际 CDN 域名，补进 `host_permissions`
- [ ] 确认目标页是否用 React/Vue 受控组件，确定事件派发策略
- [ ] 确认 UEditor 的全局对象（`UE`）在作业页是否可直接访问
- [ ] 实现 `scheduler/` 四个模块 + 单测
- [ ] 实现 `shared/ai/validate.ts` 校验规则 + 畸形答案穷举测试
- [ ] 实现回填后的 DOM 读回校验
- [ ] 浮球 UI 的进度与"未作答计数"展示
- [ ] 补齐批量重试失败项功能

## C. 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **选择器失效** | 超星改版会让整条链路崩掉 | 选择器集中单点管理 + 离线快照单测 |
| **iframe 结构变化** | 模块路径 `/ananas/modules/work/` 可能调整 | 角色识别不依赖单一 URL，辅以容器探测 |
| **UEditor 回填失败** | 简答题是最脆弱的一环 | 三级降级 + debugger 兜底 |
| **受控组件吞值** | 看着填上了、提交时是空的 | 原生 setter + 事件派发 + 回填后读回校验 |
| **图片跨域** | 内容脚本抓不到图 | 统一走 SW 抓取 |
| **模型答错** | 无法 100% 避免 | 温度 0 + 结构化输出 + 本地校验 + 留空兜底 |
| **请求过密触发风控** | 批量灌请求有被识别的风险 | 并发调度器（并发池 + 抖动 + 限流 + 退避） |
| **API Key 泄露** | 存 `chrome.storage.local` 对本机可开调试台的人可读 | 本机使用场景可接受；提供"仅本会话"选项 |
| **debugger 横幅** | 启用期间顶部常驻提示条 | 默认关闭，按需 attach，用完立即 detach |

---

*文档结束 · 智答 v2.0 · 2026-10-13*
