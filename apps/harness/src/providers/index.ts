import type { HarnessConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import type { Provider } from './types.js';

export type { CompletionRequest, Provider } from './types.js';

export function createProvider(config: HarnessConfig): Provider {
  switch (config.provider) {
    case 'openai':
      return new OpenAiProvider(config.apiKey, config.model, config.baseUrl);
    case 'anthropic':
      return new AnthropicProvider(config.apiKey, config.model, config.baseUrl);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
