export interface Settings {
  /** 开关：页面浮球可一键暂停全部行为 */
  enabled: boolean;

  // ── 模型 ──
  apiBase: string;      // 如 https://api.deepseek.com  （不带 /v1 也可，代码会补）
  apiKey: string;
  model: string;        // 文本模型
  visionModel: string;  // 视觉模型（图片题用；留空则图片题直接留空）

  // ── 准确率 ──
  /** 低于此置信度不回填（0~1） */
  minConfidence: number;
  /** 校验失败后带格式反馈重试的次数 */
  validateRetries: number;
  /** 置信度低于阈值时，自动做一次独立复核（只对少数不确定的题，代价很小） */
  reviewLowConfidence: boolean;

  // ── 思考模式（DeepSeek: thinking.enabled + reasoning_effort）──
  /** 开启后先推理再作答，更准但更慢 */
  thinking: boolean;
  /** 思考强度：low / medium / high */
  thinkingEffort: string;

  // ── 并发调度（可自定义，见设计文档 §5.4） ──
  concurrency: number;   // 并发数 1~10
  minGapMs: number;      // 请求间隔下限 ms（随机抖动区间）
  maxGapMs: number;      // 请求间隔上限 ms
  maxPerMinute: number;  // 每分钟请求上限（令牌桶）
  retries: number;       // 网络/限流类错误的退避重试次数

  // ── 行为 ──
  autoRun: boolean;          // 检测到整卷后自动开始
  autoSubmit: boolean;       // ⚠️ 默认关闭：自动点「提交」是不可逆动作
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,

  apiBase: '',
  apiKey: '',
  model: '',
  visionModel: '',

  minConfidence: 0.6,
  validateRetries: 2,
  reviewLowConfidence: true,
  thinking: true,
  thinkingEffort: 'high',

  concurrency: 3,
  minGapMs: 200,
  maxGapMs: 800,
  maxPerMinute: 60,
  retries: 3,

  autoRun: true,
  autoSubmit: false,
};
