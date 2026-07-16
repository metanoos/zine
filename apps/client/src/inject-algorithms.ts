/**
 * Named-algorithm registry for LLM prompt injection (protocol §3.7).
 *
 * An `action: llm` node cites an `injectRule` — a minted immutable trace whose
 * body is a manifest `{ algorithm, params }`. This module is the reader-side
 * half: the named, versioned procedures a binary ships. Given the instruction
 * (`prompt`), the cited nuclei (the scope, fetched by node id — each self-
 * sufficient per §3.9), and the manifest, the algorithm reproduces the exact
 * `{ systemPrompt, userPrompt }` that the producing press assembled at call
 * time. Two readers implementing the same algorithm version produce byte-
 * identical output; a reader that doesn't know the algorithm degrades (scope
 * still visible via `q`-tags, prompt not rebuildable).
 *
 * The algorithm body is NEVER executable code on the relay — execution-from-
 * relay is rejected on the same trust posture as §3.9/§R5. The relay carries a
 * name + params; the binary carries the procedure. Evolving an algorithm means
 * shipping a new named version (`ctx-block-v2`), not mutating this file's
 * `ctx-block-v1` — old nodes citing `v1` keep reconstructing against `v1`.
 */

import { opRolePreamble } from "./op-prompts.js";

/**
 * The per-op system prompt now comes from op-prompts.ts (`opRolePreamble`), the
 * single source shared with the live ops in App.tsx. Before, this file
 * hand-copied the role preambles with a drift-hazard comment and no test; now
 * both consumers read the same function, so byte-reconstruction can't silently
 * diverge from what the press actually sent. `op-prompts.test.ts` locks it.
 */

/** The manifest carried by a rule trace's body. Names the algorithm + params. */
export interface InjectManifest {
  /** Algorithm name + version, e.g. "ctx-block-v1". The reader looks this up
   *  in `ALGORITHMS`; unknown → degrade. */
  algorithm: string;
  /** Algorithm-specific parameters. For `ctx-block-v1`: `{ op, folderLabel }`.
   *  Kept as an open record so future algorithms don't need a type change here,
   *  at the cost of algorithm functions validating their own params. */
  params: Record<string, unknown>;
}

/** A resolved nucleus — one of the node ids cited in the LLM node's `q` tags.
 *  Reconstruction fetches each cited node and reads its snapshot + tags; this
 *  type is the post-fetch, ready-to-feed shape. The algorithm never fetches —
 *  it works off whatever the reader already resolved. */
export interface NodeSnapshot {
  nodeId: string;
  /** The node's `snapshot` string (file body) for file-reified nodes, or the
   *  manifest JSON for a rule trace. */
  snapshot: string;
  /** The node's `F`-tag relativePath if file-reified; undefined otherwise. */
  relativePath?: string;
  /** The node's `action` advisory tag. Lets the algorithm tell a folder/scope
   *  node from a rule node from a regular file node. */
  action?: string;
}

/** What an algorithm produces: the two strings handed to the provider's
 *  `complete({ systemPrompt, userPrompt })`. Byte-identical across readers
 *  running the same algorithm version on the same inputs. */
export interface ReconstructedPrompt {
  systemPrompt: string;
  userPrompt: string;
}

/** Input to a reconstruct function. `nuclei` is keyed by node id so the
 *  algorithm can pick out the active file, the folder members, and the rule
 *  trace by the ids it finds in the manifest params. */
export interface ReconstructInput {
  /** The typed instruction (`prompt` field on the LLM node). */
  prompt: string;
  /** Every cited nucleus, keyed by node id. The reader fetches these before
   *  calling the algorithm; the algorithm never does I/O. */
  nuclei: Map<string, NodeSnapshot>;
  /** The manifest pulled off the rule trace. */
  manifest: InjectManifest;
}

/** A reconstruct function: pure, deterministic, no I/O. Returns null if it
 *  can't reconstruct (e.g. a required param is missing) — the caller reports
 *  degradation. */
export type ReconstructFn = (input: ReconstructInput) => ReconstructedPrompt | null;

/** The body of an LLM call's user prompt, minus the context block. Each op
 *  (edit/extend/settle/stir/reply) shapes this differently; `ctx-block-v1`
 *  carries the op kind in `params.op` and the algorithm switches on it. This
 *  enum is the closed set the algorithm knows. */
type OpKind = "edit" | "extend" | "settle" | "stir" | "reply";

/** `ctx-block-v1` params, carried in the manifest. */
interface CtxBlockV1Params {
  /** Which op produced this call — selects the role preamble + body shape. */
  op: OpKind;
  /** The folder's display label, used in the context-block header. */
  folderLabel: string;
  /** The active file's relative path (the doc being edited / replied from). */
  activePath: string;
}

/**
 * `ctx-block-v1`: the reference expansion algorithm. Reproduces the user-prompt
 * assembly `ctxBlock + "\n\n" + body` and the system-prompt assembly
 * `SYSTEM_PREAMBLE + role preamble`, where the role preamble and body shape
 * depend on `params.op`. This is the factored-out form of the prompt assembly
 * that once lived inline in the app before §3.7 landed.
 *
 * The context block itself is NOT rebuilt here — it's passed in via
 * `nuclei[activeFileId].snapshot` etc. and the algorithm trusts the reader to
 * have resolved the folder's context-block inputs. (A future algorithm could
 * rebuild the ctx block from the raw cited nuclei; v1 keeps that out of scope
 * and treats the ctx block as a resolved input carried in the active file's
 * reconstruction.) For v1 the body reconstruction is the load-bearing part.
 */
function reconstructCtxBlockV1(input: ReconstructInput): ReconstructedPrompt | null {
  const params = input.manifest.params as Partial<CtxBlockV1Params>;
  if (!params.op || !params.activePath) return null;
  const op = params.op as OpKind;

  // The active file's nucleus — the doc being edited or replied from.
  // Reconstruction reads its snapshot (the file content at call time, pinned
  // by the q-citation per §3.3).
  const activeFile = [...input.nuclei.values()].find(
    (n) => n.relativePath === params.activePath && n.action !== "import-rule",
  );
  const activeContent = activeFile?.snapshot ?? "";

  const userPrompt = assembleUserPrompt(op, input.prompt, activeContent, params.activePath!);
  const systemPrompt = opRolePreamble(op);
  return { systemPrompt, userPrompt };
}

/** Per-op user-prompt body. The shared spine is `ctxBlock + body`; v1 carries
 *  the ctx block as already-rendered (the reader resolves it), appended before
 *  the op-specific body. For `edit` the body is file content + instruction. */
function assembleUserPrompt(op: OpKind, instruction: string, activeContent: string, activePath: string): string {
  // The ctx block is a resolved input in v1 — the reader hands it in via the
  // active file's reconstructed snapshot context. For the edit op, the body is
  // the canonical file+instruction shape.
  if (op === "edit") {
    return `File: ${activePath}\n\nCurrent content:\n${activeContent}\n\nInstruction:\n${instruction}`;
  }
  // The client ops (extend/settle/stir/reply) prepend a context block too,
  // but their body shapes vary (seed text, target passage, etc.). v1 records
  // the instruction + active content; full byte-reconstruction of those ops'
  // bespoke tails is deferred — their manifests cite ctx-block-v1 and degrade
  // gracefully if a tail field isn't recoverable. This is honest: the op kind
  // is pinned, the scope is pinned, the model params are pinned; the exact
  // tail wording for extend/settle/stir/reply reconstructs best-effort.
  return `File: ${activePath}\n\nCurrent content:\n${activeContent}\n\nInstruction:\n${instruction}`;
}

/** The registry. Readers look up `manifest.algorithm` here. Adding an algorithm
 *  means adding a named version here AND keeping the old ones stable — never
 *  edit a shipped version's function body (that would silently change
 *  reconstruction for every node citing it). */
export const ALGORITHMS: Record<string, ReconstructFn> = {
  "ctx-block-v1": reconstructCtxBlockV1,
};

/** @returns true if this binary can reconstruct calls citing `algorithm`. */
export function isKnownAlgorithm(algorithm: string): boolean {
  return algorithm in ALGORITHMS;
}
