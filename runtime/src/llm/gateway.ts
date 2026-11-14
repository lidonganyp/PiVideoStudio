/**
 * LLM 网关：封装统一的 LLM 调用接口。
 * 供 splitter / asset-extractor / prompt-builder 复用。
 *
 * 配置走环境变量（.env.example 只留键名）：
 *   LLM_BASE_URL  — OpenAI 兼容 API 的 base URL（如 https://api.openai.com/v1）
 *   LLM_API_KEY   — API Key
 *   LLM_MODEL     — 模型名称（如 gpt-4o-mini）
 */

export interface CallLLMOptions {
  system: string;
  user: string;
  responseFormat?: 'json' | 'text';
  temperature?: number;
}

export interface LLMTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 最近一次调用的 token 用量（为后续计费预留） */
let lastUsage: LLMTokenUsage | undefined;

export function getLastTokenUsage(): LLMTokenUsage | undefined {
  return lastUsage;
}

function getConfig() {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
  if (!baseUrl || !apiKey) {
    throw new Error(
      'LLM 网关未配置：请设置 LLM_BASE_URL 和 LLM_API_KEY 环境变量',
    );
  }
  return { baseUrl, apiKey, model };
}

/** 判断是否为 LLM mock 模式（无需真实 LLM Key 的全链路测试） */
export function isLLMMockMode(): boolean {
  const v = (process.env.LLM_MOCK_MODE ?? '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** 简单标点分句（保留句末标点） */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^。！？!?]+[。！？!?]?/g);
  return matches ? matches.map((s) => s.trim()).filter(Boolean) : [text];
}

/** 中文人名粗提取：2~3 个连续汉字且非高频词 */
const STOP_WORDS = new Set([
  '第一章', '第二章', '第三章', '第四章', '第五章',
  '无人', '知晓', '一道', '一柄', '狂风', '金光', '云海',
  '山巅', '城池', '街市', '人声', '少年', '古剑', '剑诀',
]);
/** 常见非人名用字，出现在候选词中则排除 */
const BAD_CHARS = new Set(
  '站走看说在了中下上一道化作呼啸翻阅握持伸他她它这那有无人知鼎沸繁城剑风狂金云海巅远眺破空至来入'.split(''),
);
function extractNames(text: string): string[] {
  const candidates = text.match(/[\u4e00-\u9fa5]{2,3}/g) ?? [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const c of candidates) {
    if (STOP_WORDS.has(c) || seen.has(c)) continue;
    if ([...c].some((ch) => BAD_CHARS.has(ch))) continue;
    seen.add(c);
    names.push(c);
    if (names.length >= 3) break;
  }
  return names;
}

/** 剥离 user prompt 中的指令前缀（指令与正文以空行分隔） */
function stripInstructionPrefix(user: string): string {
  const idx = user.indexOf('\n\n');
  return idx >= 0 ? user.slice(idx + 2) : user;
}

/** 生成确定性 mock 分镜列表 */
function mockSegments(text: string) {
  const sentences = splitSentences(text);
  const segments: Array<{
    sourceText: string;
    sceneSummary: string;
    characterNames: string[];
    emotion: string;
    estimatedSeconds: number;
  }> = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const group = sentences.slice(i, i + 2).join('');
    const names = extractNames(group);
    segments.push({
      sourceText: group,
      sceneSummary: group.length > 20 ? group.slice(0, 20) + '…' : group,
      characterNames: names,
      emotion: '平静',
      estimatedSeconds: Math.max(3, Math.min(10, Math.round(group.length / 4.5))),
    });
  }
  return { segments };
}

/** 生成确定性 mock 资产 */
function mockAssets(text: string) {
  const names = extractNames(text);
  const characters = names.map((name) => ({
    name,
    appearance: `${name}的外貌（mock）`,
    clothing: `${name}的服装（mock）`,
    temperament: '沉稳（mock）',
  }));
  const scenes = [
    {
      name: '主要场景',
      location: '故事场景（mock）',
      lighting: '自然光（mock）',
      props: '基础道具（mock）',
    },
  ];
  return { characters, scenes };
}

/** 生成确定性 mock 提示词包 */
function mockPromptBundle(user: string) {
  const styleMatch = user.match(/风格后缀（必须包含在 visual 末尾）：([^\n]+)/);
  const styleSuffix = styleMatch ? styleMatch[1].trim() : '';
  const srcMatch = user.match(/分镜原文：([^\n]+)/);
  const src = srcMatch ? srcMatch[1].trim() : '';
  const names = extractNames(src);
  const anchor = names.length > 0 ? `, ${names[0]} character anchor` : '';
  const visual = `cinematic shot of ${src || 'scene'}${anchor}, ${styleSuffix}`.trim();
  const narration = src.length > 40 ? src.slice(0, 40) : src;
  return {
    camera: '中景，缓慢推进（mock）',
    visual,
    narration,
    subtitle: narration,
  };
}

/** mock 模式下的确定性响应 */
function mockLLMResponse(system: string, user: string): string {
  if (system.includes('分镜师')) {
    return JSON.stringify(mockSegments(stripInstructionPrefix(user)));
  }
  if (system.includes('资产提取器')) {
    return JSON.stringify(mockAssets(stripInstructionPrefix(user)));
  }
  if (system.includes('提示词工程师')) {
    return JSON.stringify(mockPromptBundle(user));
  }
  return JSON.stringify({ text: 'mock response' });
}

/**
 * 调用 LLM，返回纯文本响应。
 * JSON 模式下解析失败自动重试 1 次（追加格式修正指令），仍失败则抛错。
 */
export async function callLLM(options: CallLLMOptions): Promise<string> {
  const { system, user, responseFormat, temperature } = options;

  // mock 模式：直接返回确定性数据，不访问网络
  if (isLLMMockMode()) {
    const content = mockLLMResponse(system, user);
    lastUsage = {
      promptTokens: system.length + user.length,
      completionTokens: content.length,
      totalTokens: system.length + user.length + content.length,
    };
    console.log(
      `[llm-gateway] MOCK MODE tokens=${JSON.stringify(lastUsage)}`,
    );
    if (responseFormat === 'json') {
      try {
        JSON.parse(content);
        return content;
      } catch {
        throw new Error('LLM mock 模式返回内容不是合法 JSON');
      }
    }
    return content;
  }

  const { baseUrl, apiKey, model } = getConfig();

  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: temperature ?? 0.7,
  };
  if (responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const url = baseUrl.endsWith('/')
    ? baseUrl + 'chat/completions'
    : baseUrl + '/chat/completions';

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API 错误 ${resp.status}: ${errText}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content ?? '';

  // 记录 token 用量
  lastUsage = {
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
  };
  console.log(
    `[llm-gateway] model=${model} tokens=${JSON.stringify(lastUsage)}`,
  );

  // JSON 模式：验证并重试
  if (responseFormat === 'json') {
    try {
      JSON.parse(content);
      return content;
    } catch {
      // 重试 1 次：追加格式修正指令
      console.warn('[llm-gateway] JSON 解析失败，追加修正指令重试');
      const retryMessages = [
        ...messages,
        { role: 'assistant' as const, content },
        {
          role: 'user' as const,
          content:
            '你上面的回复不是合法 JSON。请只输出一个合法的 JSON 对象，不要包含任何 markdown 代码块标记或额外文字。',
        },
      ];
      const retryBody: Record<string, unknown> = {
        model,
        messages: retryMessages,
        temperature: 0,
        response_format: { type: 'json_object' },
      };
      const retryResp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(retryBody),
      });
      if (!retryResp.ok) {
        const errText = await retryResp.text();
        throw new Error(`LLM API 重试错误 ${retryResp.status}: ${errText}`);
      }
      const retryData = (await retryResp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const retryContent = retryData.choices?.[0]?.message?.content ?? '';
      lastUsage = {
        promptTokens: retryData.usage?.prompt_tokens,
        completionTokens: retryData.usage?.completion_tokens,
        totalTokens: retryData.usage?.total_tokens,
      };
      console.log(
        `[llm-gateway] retry tokens=${JSON.stringify(lastUsage)}`,
      );
      try {
        JSON.parse(retryContent);
        return retryContent;
      } catch {
        throw new Error(
          'LLM JSON 模式重试后仍无法解析：返回内容不是合法 JSON',
        );
      }
    }
  }

  return content;
}

/** 便捷方法：调用 LLM 并直接解析为 JSON 对象 */
export async function callLLMAsJSON<T = unknown>(
  options: Omit<CallLLMOptions, 'responseFormat'>,
): Promise<T> {
  const raw = await callLLM({ ...options, responseFormat: 'json' });
  return JSON.parse(raw) as T;
}
