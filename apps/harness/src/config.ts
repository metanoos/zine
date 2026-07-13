import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HarnessConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const CONFIG_PATH = path.join(os.homedir(), '.tracer', 'config.json');

/**
 * Resolves provider config from, in order: CLI flags (passed in as
 * overrides), environment variables (TRACER_PROVIDER / TRACER_API_KEY /
 * TRACER_MODEL / TRACER_BASE_URL), then ~/.tracer/config.json. "Plug in
 * any API key and go" — no provider is hardcoded as the default.
 */
export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const fileConfig = readConfigFile();
  const envConfig: Partial<HarnessConfig> = {
    provider: process.env.TRACER_PROVIDER as HarnessConfig['provider'] | undefined,
    apiKey: process.env.TRACER_API_KEY,
    model: process.env.TRACER_MODEL,
    baseUrl: process.env.TRACER_BASE_URL,
  };

  const merged: Partial<HarnessConfig> = {
    ...fileConfig,
    ...stripUndefined(envConfig),
    ...stripUndefined(overrides),
  };

  if (!merged.provider) {
    throw new Error(
      'No provider configured. Set TRACER_PROVIDER (openai|anthropic), pass --provider, or write ~/.tracer/config.json',
    );
  }
  if (!merged.apiKey) {
    throw new Error('No API key configured. Set TRACER_API_KEY, pass --api-key, or write ~/.tracer/config.json');
  }

  return merged as HarnessConfig;
}

function readConfigFile(): Partial<HarnessConfig> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
