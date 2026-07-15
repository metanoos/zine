/**
 * Ambient typing for `import.meta.env` so the shared client modules (which use
 * `import.meta.env.VITE_RELAY_URL` in identity.ts) typecheck under apps/mcp's
 * tsconfig. In the client build, `vite/client` (referenced from
 * apps/client/src/vite-env.d.ts) provides this; zine-mcp isn't a Vite project,
 * so we declare the minimal shape the shared code reads.
 *
 * This file carries no runtime code — it only satisfies the type checker.
 * Under tsx/node at runtime, `import.meta.env` is undefined and the
 * `ZINE_RELAY_URL` branch in resolveRelayUrl() runs first anyway, so the
 * VITE_RELAY_URL access is never reached in the headless press.
 */
interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
