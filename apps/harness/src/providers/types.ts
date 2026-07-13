export interface CompletionRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
}

/** Adapter boundary every LLM provider implements. Add a new provider by
 * implementing this interface and registering it in providers/index.ts —
 * nothing else in the harness needs to know which provider is in use. */
export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
}
