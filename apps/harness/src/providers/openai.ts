import type { CompletionRequest, Provider } from './types.js';

/**
 * Talks to the OpenAI chat-completions API, or any OpenAI-compatible
 * endpoint (Ollama, LM Studio, OpenRouter, etc.) via baseUrl — that's the
 * "plug in any API key" story for local/self-hosted models too.
 */
export class OpenAiProvider implements Provider {
  readonly name = 'openai';

  constructor(
    private apiKey: string,
    private model: string = 'gpt-4o',
    private baseUrl: string = 'https://api.openai.com/v1',
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const messages = [
      ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
      { role: 'user', content: req.userPrompt },
    ];

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: req.maxTokens ?? 4096,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI-compatible API error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    const content = json.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI-compatible API returned no content');
    return content;
  }
}
