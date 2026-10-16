import { buildRetryPrompt, buildReviewPrompt, buildSystemPrompt, buildUserPrompt } from './prompt';
import { isSameAnswer, normalizeAnswer, validateAnswer } from './validate';
import { decideReviewOutcome } from './reviewDecision';
import { AI_TIMEOUT_MS, requestWithRetry } from './request';
import { fetchImagesAsDataUrls } from '../imageFetch';
import { getSettings } from '../storage';
import type { SolveResult } from '../types/question';
import type { Answer, Question } from '../types/question';
import type { Settings } from '../types/settings';

/**
 * AI 求解（设计文档 §5.6）：只在 SW 里运行。
 * 单题一请求 —— 请求短小，天然规避 SW 单次事件 5 分钟上限（设计文档 D1）。
 */

/** 单题最多送几张图（题干 + 选项合计），防止请求体膨胀 */
const MAX_IMAGES_PER_QUESTION = 6;

/** 带标签的图片：让模型知道哪张是题干、哪张属于哪个选项 */
interface LabeledImage {
  tag: string;
  dataUrl: string;
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b; // 用户直接粘了完整端点
  // 用户粘了 …/v1（OpenAI 风格 base）时不能再补一次 /v1
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}${path}`;
}

async function chatCompletion(
  s: Settings,
  messages: ChatMessage[],
  model: string,
): Promise<{ content: string; reasoning: string }> {
  const url = joinUrl(s.apiBase, '/v1/chat/completions');
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (s.thinking) {
    // 思考模式（DeepSeek 官方参数，实测 deepseek-chat 可用）
    // 注意：思考模式不支持 temperature（传了不报错但不生效），故不传
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = s.thinkingEffort || 'high';
  } else {
    body.temperature = 0; // 非思考模式：温度 0（准确率第一道关）
  }

  const doFetch = (b: Record<string, unknown>) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(b),
      // ★ 必须带超时：无超时的话一次卡死的请求会让整个流程永远 in-flight
      //   （逐题模式表现为"卡在并发求解中"，就地模式表现为计数不动）
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

  let res = await doFetch(body);
  if (!res.ok && s.thinking && res.status === 400) {
    // 某些 OpenAI 兼容端点不认识 thinking/reasoning_effort → 去掉重试一次
    delete body.thinking;
    delete body.reasoning_effort;
    body.temperature = 0;
    res = await doFetch(body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: {
      message?: { content?: string; reasoning_content?: string };
    }[];
  };
  const msg = json.choices?.[0]?.message;
  const content = msg?.content ?? '';
  const reasoning = msg?.reasoning_content ?? '';
  // 个别端点在思考模式下把最终答案遗漏在 content，兜底用思维链解析
  return { content: content || reasoning, reasoning };
}

/** 宽松地从模型输出里抠出第一个 JSON 对象（容忍 ```json 包裹、前后缀文本） */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 单题求解主流程：抓图 → 调模型 → 本地校验 → 校验失败带反馈重试 → 低置信度留空 */
export async function solveQuestion(question: Question): Promise<SolveResult> {
  const s = await getSettings();
  if (!s.enabled) return { answer: null, reason: '插件已暂停' };
  if (!s.apiBase || !s.apiKey || !s.model)
    return { answer: null, reason: '未配置 API（地址/Key/模型），请到设置页填写' };

  // 图片题：必须配视觉模型，否则留空不猜（设计文档 §5.6 第四道关）
  // ★ 题干图与**选项图**都要送 —— 数学公式常常长在选项里（例如"则 P( )=? A/B/C/D 各带一张公式图"），
  //   只送题干图等于让模型对着"（图片选项）"占位文字瞎猜。
  const images: LabeledImage[] = [];
  const hasAnyImage =
    question.imgUrls.length > 0 || question.options.some((o) => o.imgUrls.length > 0);
  if (hasAnyImage) {
    if (!s.visionModel)
      return { answer: null, reason: '题目含图片但未配置视觉模型，已留空' };
    const plan = [
      ...question.imgUrls.map((url) => ({ tag: '题干图片', url })),
      ...question.options.flatMap((o) =>
        o.imgUrls.map((url) => ({ tag: `选项${o.key}的图片`, url })),
      ),
    ].slice(0, MAX_IMAGES_PER_QUESTION);
    const fetched = await fetchImagesAsDataUrls(plan.map((p) => p.url));
    const byUrl = new Map(fetched.map((f) => [f.url, f.dataUrl]));
    // 按 plan 的顺序还原，且丢弃抓取失败的图
    for (const p of plan) {
      const dataUrl = byUrl.get(p.url);
      if (dataUrl) images.push({ tag: p.tag, dataUrl });
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    buildUserMessage(question, images),
  ];

  const visionModel = images.length > 0 ? s.visionModel : s.model;
  let lastReason = '未知错误';

  for (let attempt = 0; attempt <= s.validateRetries; attempt++) {
    let text: string;
    try {
      // ★ 走退避重试：瞬时错误（429/5xx/超时）不再"一次定生死"
      const out = await requestWithRetry(
        () => chatCompletion(s, messages, visionModel),
        s.retries,
      );
      text = out.content;
    } catch (err) {
      return { answer: null, reason: `请求失败: ${(err as Error).message}` };
    }

    const raw = extractJson(text);
    if (!raw) {
      lastReason = '模型输出不是合法 JSON';
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: buildRetryPrompt(lastReason) });
      continue;
    }

    const answer = normalizeAnswer(raw, question);
    const v = validateAnswer(question, answer);
    if (v.ok) {
      const conf = answer.confidence ?? 1;
      if (conf >= s.minConfidence) return { answer };
      // 低置信度：先别放弃 —— 做一次独立复核（见 buildReviewPrompt）
      if (!s.reviewLowConfidence) {
        return { answer: null, reason: `置信度过低(${conf.toFixed(2)})，宁空不错` };
      }
      return await reviewLowConfidenceAnswer(s, question, answer, images, visionModel);
    }

    lastReason = v.reason!;
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: buildRetryPrompt(lastReason) });
  }

  return { answer: null, reason: `校验未通过: ${lastReason}` };
}

/** 构造题目消息（有图时用多模态格式，并附"第N张图是什么"的说明） */
function buildUserMessage(question: Question, images: LabeledImage[]): ChatMessage {
  const userText = buildUserPrompt(question);
  if (images.length === 0) return { role: 'user', content: userText };
  const legend = images.map((img, i) => `第${i + 1}张图 = ${img.tag}`).join('；');
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${userText}\n\n【附图说明】${legend}` },
      ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
    ],
  };
}

/**
 * 低置信度题目的独立复核。
 *
 * 决策表（宁空不错的前提下尽量救回）：
 *  - 复核认为原答案正确 且 复核置信度达标 → 采纳原答案（标注"已复核确认"）
 *  - 复核认为原答案有误 且 给出不同答案 且 置信度达标 → 采纳复核答案（标注"已更正"）
 *  - 其余（复核也没把握 / 输出无法解析 / 校验不过） → 留空
 */
async function reviewLowConfidenceAnswer(
  s: Settings,
  question: Question,
  candidate: Answer,
  images: LabeledImage[],
  model: string,
): Promise<SolveResult> {
  const originalConf = candidate.confidence ?? 0;
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    buildUserMessage(question, images),
    { role: 'user', content: buildReviewPrompt(question, candidate) },
  ];

  let out: { content: string };
  try {
    out = await requestWithRetry(() => chatCompletion(s, messages, model), s.retries);
  } catch (err) {
    return {
      answer: null,
      reason: `置信度过低(${originalConf.toFixed(2)})，且复核请求失败(${(err as Error).message.slice(0, 40)})，留空`,
    };
  }

  const raw = extractJson(out.content);
  if (!raw) {
    return { answer: null, reason: `置信度过低(${originalConf.toFixed(2)})，复核输出无法解析，留空` };
  }

  const reviewed = normalizeAnswer(raw, question);
  const reviewValid = validateAnswer(question, reviewed).ok;
  const verdict = String(raw.verdict ?? '').toLowerCase();
  const rconf = reviewed.confidence ?? 0;
  const same = isSameAnswer(candidate, reviewed, question.type);

  // ★ 判决逻辑抽成纯函数（含"复核输出格式非法但明确认可原答案"的挽救分支），
  //   见 shared/ai/reviewDecision.ts 与 tests/review-decision.spec.ts
  const decision = decideReviewOutcome({
    candidateValid: validateAnswer(question, candidate).ok,
    reviewValid,
    rconf,
    originalConf,
    minConfidence: s.minConfidence,
    verdict,
    same,
  });

  switch (decision.action) {
    case 'adopt-candidate':
      return { answer: candidate, note: decision.note };
    case 'adopt-review':
      return { answer: reviewed, note: decision.note };
    default:
      return { answer: null, reason: decision.reason };
  }
}
