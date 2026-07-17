import type { OpKind as PreparedOperationId } from "./op-prompts.js";

/**
 * Declarative descriptions for AI participants rendered in the action palette.
 * Descriptions are deliberately inert: they identify supported actions and
 * presentation only. App retains provider resolution, gating, execution, and
 * application authority.
 */
export type AiPaletteActionId = PreparedOperationId | "run";

type AiPaletteActionPresentation = {
  label: string;
  title: string;
  className: string;
};

export type AiPaletteActionDescription = Readonly<
  | ({ id: PreparedOperationId; kind: "operation" } & AiPaletteActionPresentation)
  | ({ id: "run"; kind: "agent-run" } & AiPaletteActionPresentation)
>;

export type AiPaletteRowDescription = Readonly<{
  id: string;
  participantRole: "ai";
  voice: Readonly<{
    binding: "model";
    ariaLabel: string;
  }>;
  providerSelection: Readonly<{
    capability: "voice-pinned";
    requiredForActions: true;
  }>;
  label: Readonly<{
    defaultLabel: string;
    aliases: readonly string[];
    storageKey: string;
    rerollTitle: string;
  }>;
  actions: readonly AiPaletteActionDescription[];
}>;

export type AiPaletteRegistry = readonly AiPaletteRowDescription[];

export class AiPaletteRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiPaletteRegistryError";
  }
}

const BUILTIN_ACTIONS = [
  {
    id: "analyze",
    kind: "operation",
    label: "Analyze",
    title: "Analyze the writing process from exact trace, Step, and limelight evidence into a cited review",
    className: "op-analyze",
  },
  {
    id: "reply",
    kind: "operation",
    label: "Reply",
    title: "Write a response into a new doc in the other pane, citing traces",
    className: "op-reply",
  },
  {
    id: "extend",
    kind: "operation",
    label: "Extend",
    title: "Append an AI continuation to this file",
    className: "op-extend",
  },
  {
    id: "stir",
    kind: "operation",
    label: "Stir",
    title: "Reinvent loose prose, run (( commands )), preserve [[ anchors ]]",
    className: "op-stir",
  },
  {
    id: "settle",
    kind: "operation",
    label: "Settle",
    title: "File: condense loose prose, keep brackets. Folder: de-dupe near-duplicate scans into one",
    className: "op-settle",
  },
  {
    id: "run",
    kind: "agent-run",
    label: "Run",
    title: "Start an agent run — research and draft in a new subfolder under the current scope",
    className: "op-run",
  },
] as const satisfies readonly AiPaletteActionDescription[];

const REQUIRED_ACTION_IDS = Object.freeze(
  BUILTIN_ACTIONS.map((action) => action.id),
) as readonly AiPaletteActionId[];
const REQUIRED_ACTION_ID_SET = new Set<AiPaletteActionId>(REQUIRED_ACTION_IDS);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((child) => isDeepFrozen(child, seen));
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiPaletteRegistryError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new AiPaletteRegistryError(`${path} has unsupported fields: ${unexpected.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AiPaletteRegistryError(`${path} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate an already-immutable description graph and return a canonical,
 * deeply frozen copy. Mutable caller-owned data is rejected rather than held
 * by reference, and unsupported fields cannot smuggle callbacks or prompts
 * into the composition layer.
 */
export function validateAiPaletteRegistry(input: unknown): AiPaletteRegistry {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AiPaletteRegistryError("AI palette registry must contain at least one row");
  }
  if (!isDeepFrozen(input)) {
    throw new AiPaletteRegistryError("AI palette registry input must be deeply immutable");
  }

  const rowIds = new Set<string>();
  const rows = input.map((candidate, rowIndex): AiPaletteRowDescription => {
    const path = `rows[${rowIndex}]`;
    const row = record(candidate, path);
    exactKeys(row, ["id", "participantRole", "voice", "providerSelection", "label", "actions"], path);

    const id = nonEmptyString(row.id, `${path}.id`);
    if (rowIds.has(id)) throw new AiPaletteRegistryError(`duplicate AI palette row id: ${id}`);
    rowIds.add(id);
    if (row.participantRole !== "ai") {
      throw new AiPaletteRegistryError(`${path}.participantRole must be ai`);
    }

    const voice = record(row.voice, `${path}.voice`);
    exactKeys(voice, ["binding", "ariaLabel"], `${path}.voice`);
    if (voice.binding !== "model") {
      throw new AiPaletteRegistryError(`${path}.voice.binding must be model`);
    }

    const providerSelection = record(row.providerSelection, `${path}.providerSelection`);
    exactKeys(
      providerSelection,
      ["capability", "requiredForActions"],
      `${path}.providerSelection`,
    );
    if (
      providerSelection.capability !== "voice-pinned" ||
      providerSelection.requiredForActions !== true
    ) {
      throw new AiPaletteRegistryError(
        `${path}.providerSelection must require voice-pinned providers`,
      );
    }

    const label = record(row.label, `${path}.label`);
    exactKeys(
      label,
      ["defaultLabel", "aliases", "storageKey", "rerollTitle"],
      `${path}.label`,
    );
    const defaultLabel = nonEmptyString(label.defaultLabel, `${path}.label.defaultLabel`);
    if (!Array.isArray(label.aliases) || label.aliases.length === 0) {
      throw new AiPaletteRegistryError(`${path}.label.aliases must be a non-empty array`);
    }
    const aliases = label.aliases.map((alias, aliasIndex) =>
      nonEmptyString(alias, `${path}.label.aliases[${aliasIndex}]`));
    if (new Set(aliases).size !== aliases.length) {
      throw new AiPaletteRegistryError(`${path}.label.aliases contains duplicates`);
    }
    if (!aliases.includes(defaultLabel)) {
      throw new AiPaletteRegistryError(`${path}.label.aliases must include the default label`);
    }

    if (!Array.isArray(row.actions)) {
      throw new AiPaletteRegistryError(`${path}.actions must be an array`);
    }
    const actionIds = new Set<AiPaletteActionId>();
    const actions = row.actions.map((candidateAction, actionIndex): AiPaletteActionDescription => {
      const actionPath = `${path}.actions[${actionIndex}]`;
      const action = record(candidateAction, actionPath);
      exactKeys(action, ["id", "kind", "label", "title", "className"], actionPath);
      const actionId = nonEmptyString(action.id, `${actionPath}.id`);
      if (!REQUIRED_ACTION_ID_SET.has(actionId as AiPaletteActionId)) {
        throw new AiPaletteRegistryError(`unknown AI palette operation id: ${actionId}`);
      }
      const id = actionId as AiPaletteActionId;
      if (actionIds.has(id)) {
        throw new AiPaletteRegistryError(`duplicate AI palette operation id in ${path}: ${id}`);
      }
      actionIds.add(id);
      const presentation = {
        label: nonEmptyString(action.label, `${actionPath}.label`),
        title: nonEmptyString(action.title, `${actionPath}.title`),
        className: nonEmptyString(action.className, `${actionPath}.className`),
      };
      if (id === "run") {
        if (action.kind !== "agent-run") {
          throw new AiPaletteRegistryError(`${actionPath}.kind must be agent-run`);
        }
        return { id, kind: "agent-run", ...presentation };
      }
      if (action.kind !== "operation") {
        throw new AiPaletteRegistryError(`${actionPath}.kind must be operation`);
      }
      return { id, kind: "operation", ...presentation };
    });
    const missing = REQUIRED_ACTION_IDS.filter((actionId) => !actionIds.has(actionId));
    if (missing.length > 0) {
      throw new AiPaletteRegistryError(
        `${path} is missing required AI palette operations: ${missing.join(", ")}`,
      );
    }

    return {
      id,
      participantRole: "ai",
      voice: {
        binding: "model",
        ariaLabel: nonEmptyString(voice.ariaLabel, `${path}.voice.ariaLabel`),
      },
      providerSelection: {
        capability: "voice-pinned",
        requiredForActions: true,
      },
      label: {
        defaultLabel,
        aliases,
        storageKey: nonEmptyString(label.storageKey, `${path}.label.storageKey`),
        rerollTitle: nonEmptyString(label.rerollTitle, `${path}.label.rerollTitle`),
      },
      actions,
    };
  });

  return deepFreeze(rows);
}

const BUILTIN_REGISTRY_SOURCE = deepFreeze([
  {
    id: "ai-default",
    participantRole: "ai",
    voice: {
      binding: "model",
      ariaLabel: "AI voice",
    },
    providerSelection: {
      capability: "voice-pinned",
      requiredForActions: true,
    },
    label: {
      defaultLabel: "AI",
      aliases: ["AI", "ASSISTANT", "AUTOMATIC", "AUTOMATON", "LLM"],
      storageKey: "zine.modelLabel",
      rerollTitle: "Click to update label in view; no effect on behavior",
    },
    actions: BUILTIN_ACTIONS,
  },
]);

/** The only registry exposed today. Multi-row/custom persistence is deferred. */
export const BUILTIN_AI_PALETTE_REGISTRY = validateAiPaletteRegistry(
  BUILTIN_REGISTRY_SOURCE,
);

/**
 * Custom or persisted registries are not supported yet. Always fail closed to
 * the reviewed built-in row, even when a caller supplies a valid description.
 */
export function resolveAiPaletteRegistry(candidate?: unknown): AiPaletteRegistry {
  if (candidate !== undefined) {
    try {
      validateAiPaletteRegistry(candidate);
    } catch {
      // Invalid external data has no effect; the built-in row remains active.
    }
  }
  return BUILTIN_AI_PALETTE_REGISTRY;
}
