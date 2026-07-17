import { loadLocalFolder, saveLocalFile } from "../workspace/local-store.js";
import {
  addKey,
  getAuthorKey,
  getModelKeyId,
  loadKeys,
  type KeyEntry,
} from "../identity/keys-store.js";
import type { FileState } from "../workspace/workspace-core.js";

/** The small document created when the user starts the onboarding journey. */
export const ONBOARDING_DEMO_FILE_PATH = "hello-world.md";
export const ONBOARDING_DEMO_FILE_CONTENT = "# Ayooo, world!\n\nThis is my first trace.\n";

/** Use a spare voice for system-provided starter prose, keeping the seed text
 *  distinct from both AUTHOR and MODEL. This voice is attribution only: the
 *  starter trace remains AUTHOR-owned so its first deliberate Step extends the
 *  trace instead of triggering fork-on-write. If the user has removed every
 *  spare identity, use MODEL or mint a new neutral voice. */
async function onboardingDemoVoice(): Promise<KeyEntry> {
  const keys = loadKeys();
  const authorId = getAuthorKey()?.id;
  const modelId = getModelKeyId();
  const alternate = keys.find(
    (key) =>
      key.id !== authorId &&
      key.id !== modelId &&
      /^voice-\d+$/i.test(key.label.trim()),
  );
  if (alternate) return alternate;
  const model = keys.find((key) => key.id === modelId && key.id !== authorId);
  if (model) return model;
  const withAlternate = await addKey();
  return withAlternate[withAlternate.length - 1]!;
}

function nextDemoPath(rootId: string): string {
  const files = loadLocalFolder(rootId)?.files ?? {};
  if (!files[ONBOARDING_DEMO_FILE_PATH]) return ONBOARDING_DEMO_FILE_PATH;

  const extension = ".md";
  const stem = ONBOARDING_DEMO_FILE_PATH.slice(0, -extension.length);
  let copy = 2;
  while (files[`${stem}-${copy}${extension}`]) copy += 1;
  return `${stem}-${copy}${extension}`;
}

/** Create a fresh demo at the moment onboarding starts. Repeated journeys use
 *  a numbered path instead of replacing the user's earlier tutorial trace.
 *  The empty node id and pendingEmptyGenesis marker make workspace attach
 *  publish an empty genesis (Step 0), then append the starter prose as Step 1. */
export async function loadOnboardingDemo(
  rootId: string,
): Promise<{ path: string; file: FileState }> {
  const path = nextDemoPath(rootId);
  const attributedVoice = await onboardingDemoVoice();
  const owner = getAuthorKey();
  if (!owner) throw new Error("Cannot load onboarding demo: the AUTHOR signing key is unavailable.");
  const runs = [{ voice: attributedVoice.pubkey, text: ONBOARDING_DEMO_FILE_CONTENT }];
  saveLocalFile(rootId, path, {
    content: ONBOARDING_DEMO_FILE_CONTENT,
    tags: [],
    nodeId: "",
    runs,
    voicePubkey: owner.pubkey,
    pendingEmptyGenesis: true,
  });
  return {
    path,
    file: { runs, nodeId: "", tags: [] },
  };
}
