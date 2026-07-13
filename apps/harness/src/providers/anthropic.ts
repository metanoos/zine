import type { CompletionRequest, Provider } from './types.js';

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  constructor(
    private apiKey: string,
    private model: string = 'claude-sonnet-5',
    private baseUrl: string = 'https://api.anthropic.com/v1',
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userPrompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = json.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Anthropic API returned no text content');
    return text;
  }
}
