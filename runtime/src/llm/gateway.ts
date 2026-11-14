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

/**
 * 调用 LLM，返回纯文本响应。
 * JSON 模式下解析失败自动重试 1 次（追加格式修正指令），仍失败则抛错。
 */
export async function callLLM(options: CallLLMOptions): Promise<string> {
  const { system, user, responseFormat, temperature } = options;
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
