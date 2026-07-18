import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyPaletteSelection,
  palettePrimaryAction,
  paletteSecondaryActions,
  paletteStatusMessage,
  paletteStatusRow,
} from "./palette.js";
import { BUILTIN_AI_PALETTE_REGISTRY } from "../ai/palette-registry.js";

const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");
const voiceChipSource = readFileSync(new URL("../identity/VoiceChip.tsx", import.meta.url), "utf8");

test("the persistent control is named ActionPalette, not TopBar or CommandPalette", () => {
  assert.match(appSource, /function ActionPalette/);
  assert.doesNotMatch(appSource, /function TopBar/);
  assert.doesNotMatch(appSource, /function CommandPalette/);
  assert.doesNotMatch(appSource, /paletteOpen|setPaletteOpen/);
  assert.doesNotMatch(appSource, /e\.key === "k"/);
});

test("the action palette auto-sizes instead of exposing a manual height control", () => {
  assert.doesNotMatch(appSource, /ACTION_PALETTE_HEIGHT|actionPaletteHeight/);
  assert.doesNotMatch(appSource, /action-palette-resizer|Resize action palette/);
  assert.doesNotMatch(cssSource, /action-palette-shell|action-palette-resizer/);
  assert.match(cssSource, /\.action-palette\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(cssSource, /grid-template-rows:\s*repeat\(4,\s*auto\)/);
  assert.match(
    appSource,
    /<div className="action-palette">\s*<div className="action-palette-group">/,
  );
});

test("the trace row is last in the action palette", () => {
  const paletteSource = appSource.slice(
    appSource.indexOf("function ActionPalette("),
    appSource.indexOf("function Panel("),
  );
  const renderedPalette = paletteSource.slice(paletteSource.indexOf("return ("));

  assert.match(
    renderedPalette,
    /<PaletteStatus row="substrate" status=\{opStatus\} \/>\s*<\/div>\s*<\/div>\s*\{replayTransport\}\s*<\/div>/,
  );
});

test("file and folder scans open directly from separate palette actions", () => {
  assert.match(appSource, />\s*Scan File\s*<\/button>/);
  assert.match(appSource, />\s*Scan Folder\s*<\/button>/);
  assert.match(appSource, /onClick=\{\(\) => onScan\("file"\)\}/);
  assert.match(appSource, /onClick=\{\(\) => onScan\("folder"\)\}/);
  assert.doesNotMatch(appSource, /scanOpen|setScanOpen/);
});

test("the filesystem row owns signed-trace loading", () => {
  const paletteSource = appSource.slice(
    appSource.indexOf("function ActionPalette("),
    appSource.indexOf("function Panel("),
  );
  assert.match(paletteSource, /onClick=\{onOpenTrace\}/);
  assert.match(paletteSource, /"Reifying…" : "Reify Trace"/);
  assert.match(paletteSource, />\s*Open Trace\s*<\/button>/);
  assert.match(appSource, /onOpenTrace=\{\(\) => setTraceLocatorOpen\(true\)\}/);
});

test("the destructive modal is only a local-app factory reset", () => {
  assert.match(appSource, /Factory Reset the Local App/);
  assert.match(appSource, /aria-labelledby="factory-reset-title"/);
  assert.doesNotMatch(appSource, /Desktop settings|desktop-settings|settingsOpen|onOpenSettings/);
});

test("palette actions wrap into a top-aligned fixed-width grid", () => {
  assert.equal((appSource.match(/className="action-palette-actions"/g) ?? []).length, 3);
  assert.match(cssSource, /\.action-palette-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(cssSource, /\.action-palette-actions\s*\{[^}]*align-content:\s*flex-start;/s);
  assert.match(cssSource, /\.action-palette-group\s*\{[^}]*align-items:\s*start;/s);
  assert.match(cssSource, /\.action-palette-action\s*\{[^}]*flex:\s*0 0 5\.5rem;/s);
  assert.match(cssSource, /\.action-palette-action\s*\{[^}]*width:\s*5\.5rem;/s);
  assert.doesNotMatch(cssSource, /@container action-palette \((?:min|max)-width: (?:40|60)rem\)/);
  assert.match(
    appSource,
    /\{replayFrozen && \(\s*<button[\s\S]*?action-palette-action-fork/,
  );
  assert.match(
    cssSource,
    /\.action-palette-action\.op-scan\s*\{[^}]*white-space:\s*nowrap;[^}]*\}/s,
  );
  assert.doesNotMatch(
    cssSource,
    /\.action-palette-action\.op-scan\s*\{[^}]*grid-column:/s,
  );
});

test("palette controls use crisp regular-weight labels and strong outlines", () => {
  assert.match(
    cssSource,
    /\.action-palette-action\s*\{[^}]*border:\s*1px solid var\(--rule-strong\);[^}]*font-weight:\s*400;/s,
  );
  assert.match(
    cssSource,
    /\.action-palette \.steps-step-btn,\s*\.action-palette \.action-palette-replay-speed\s*\{[^}]*font-weight:\s*400;/s,
  );
  assert.match(
    cssSource,
    /\.action-palette-action:disabled\s*\{[^}]*opacity:\s*0\.76;/s,
  );
});

test("palette labels stay vertically centered on the first control row", () => {
  assert.match(
    cssSource,
    /\.action-palette-label\s*\{[^}]*display:\s*inline-flex;[^}]*align-self:\s*start;[^}]*align-items:\s*center;[^}]*height:\s*var\(--action-palette-control-height\);/s,
  );
});

test("palette statuses render in the row that owns the operation", () => {
  assert.equal((appSource.match(/<PaletteStatus row="author"/g) ?? []).length, 1);
  assert.equal((appSource.match(/<PaletteStatus row="model"/g) ?? []).length, 1);
  assert.equal((appSource.match(/<PaletteStatus row="substrate"/g) ?? []).length, 1);

  for (const op of ["step", "send", "attest", "fork"]) {
    assert.equal(paletteStatusRow(op), "author", op);
  }
  for (const op of ["analyze", "reply", "extend", "stir", "settle", "run"]) {
    assert.equal(paletteStatusRow(op), "model", op);
  }
  for (const op of ["scan", "reify"]) {
    assert.equal(paletteStatusRow(op), "substrate", op);
  }
  assert.equal(paletteStatusRow(), null);

  assert.equal(paletteStatusMessage("settle"), "settled");
  assert.equal(paletteStatusMessage("scan", "3 scanned"), "3 scanned");
});

test("voice roles use one custom identity-aware listbox", () => {
  assert.match(appSource, /function VoiceKeySelect/);
  assert.equal((appSource.match(/<VoiceKeySelect/g) ?? []).length, 3);
  assert.equal((appSource.match(/<VoiceChip/g) ?? []).length, 4);
  assert.match(appSource, /role="listbox"/);
  assert.match(appSource, /role: "option"/);
  assert.match(appSource, /"aria-selected": isSelected/);
  assert.match(voiceChipSource, /identityColors\(identity, 0\.18\)/);
  assert.match(voiceChipSource, /<PubkeyCopyButton/);
  assert.doesNotMatch(appSource, /action-palette-key-select/);
});

test("the AI model selector shares the voice selector's custom chip treatment", () => {
  assert.match(appSource, /function ModelProviderSelect/);
  assert.equal((appSource.match(/<ModelProviderSelect/g) ?? []).length, 1);
  assert.doesNotMatch(appSource, /function ModelSelect|action-palette-model-select/);
  assert.match(
    appSource,
    /action-palette-key-picker action-palette-model-picker/,
  );
  assert.match(
    appSource,
    /action-palette-key-listbox action-palette-model-listbox/,
  );
  assert.match(
    appSource,
    /action-palette-key-option action-palette-model-option/,
  );
  assert.match(appSource, /aria-label="Model for AI ops choices"/);
  assert.match(
    cssSource,
    /\.action-palette-model-cell \.action-palette-model-picker\s*\{[^}]*flex:\s*1 1 0;/s,
  );
});

test("the MODEL row leads with its label, then voice, then model selector", () => {
  const start = appSource.indexOf('<div className="action-palette-group action-palette-model-row">');
  const end = appSource.indexOf('<div className="action-palette-group">', start + 1);
  const modelRow = appSource.slice(start, end);
  const labelAt = modelRow.indexOf("{modelAlias}:");
  const voiceAt = modelRow.indexOf("<VoiceKeySelect");
  const providerAt = modelRow.indexOf("<ModelProviderSelect");

  assert.ok(start >= 0 && end > start);
  assert.ok(labelAt >= 0 && labelAt < voiceAt);
  assert.ok(voiceAt < providerAt);
  assert.match(
    cssSource,
    /\.action-palette-group\s*\{[^}]*grid-template-columns:\s*minmax\(5\.5rem,\s*6\.25rem\)\s+var\(--action-palette-voice-width\)/s,
  );
});

test("the action palette omits prompt-context summaries", () => {
  const modelStart = appSource.indexOf('<div className="action-palette-group action-palette-model-row">');
  const modelEnd = appSource.indexOf('<div className="action-palette-group">', modelStart + 1);
  const modelRow = appSource.slice(modelStart, modelEnd);

  assert.match(modelRow, /className="action-palette-inspect"[\s\S]*?onClick=\{\(\) => onInspect\(\)\}/);
  assert.doesNotMatch(appSource, /action-palette-context-(?:status|value)|promptContextStatus/);
  assert.doesNotMatch(cssSource, /action-palette-context-(?:status|value)/);
});

test("the Prompt Inspector opener survives missing estimates and tight layouts", () => {
  const modelStart = appSource.indexOf('<div className="action-palette-group action-palette-model-row">');
  const modelEnd = appSource.indexOf('<div className="action-palette-group">', modelStart + 1);
  const modelRow = appSource.slice(modelStart, modelEnd);

  assert.match(modelRow, /className="action-palette-inspect"/);
  assert.match(
    modelRow,
    />\s*Inspect\s*\{tokenEstimate != null && \(\s*<span className="action-palette-inspect-estimate">/,
  );
  assert.doesNotMatch(modelRow, /\{tokenEstimate != null && \(\s*<button/);
  assert.doesNotMatch(
    cssSource,
    /@container action-palette \(max-width: 36rem\)[\s\S]*?\.action-palette-inspect\s*\{\s*display:\s*none;/,
  );
});

test("single-shot MODEL actions open their corresponding Prompt Inspector tab", () => {
  const modelStart = appSource.indexOf('<div className="action-palette-group action-palette-model-row">');
  const modelEnd = appSource.indexOf('<div className="action-palette-group">', modelStart + 1);
  const modelRow = appSource.slice(modelStart, modelEnd);

  assert.match(modelRow, /action\.kind === "operation"[\s\S]*?onInspect\(action\.id\)/);
  assert.match(modelRow, /else \{\s*onOp\(action\.id\);\s*\}/);
  assert.match(appSource, /onInspect=\{\(operation\) => void openInspector\(operation\)\}/);
});

test("the MODEL row does not inject directory-mount controls", () => {
  const modelStart = appSource.indexOf('<div className="action-palette-group action-palette-model-row">');
  const modelEnd = appSource.indexOf('<div className="action-palette-group">', modelStart + 1);
  const modelRow = appSource.slice(modelStart, modelEnd);

  assert.doesNotMatch(modelRow, /Mount folder|action-palette-rescope|onScopeToTarget/);
  assert.doesNotMatch(appSource, /action-palette-rescope|onScopeToTarget/);
  assert.match(modelRow, /\{tokenEstimate != null && \(\s*<span/);
});

test("an empty model catalog keeps the model selector visible", () => {
  assert.match(
    appSource,
    /className="action-palette-group action-palette-model-row"[\s\S]*?className="action-palette-label action-palette-label-clickable"[\s\S]*?\{modelAlias\}:/,
  );
  assert.match(appSource, /<div className="action-palette-model-cell">\s*<ModelProviderSelect/);
  assert.match(appSource, /label=\{selected \? providerLabel\(selected\) : "Choose a model…"\}/);
  assert.match(appSource, /disabled: providers\.length === 0/);
  assert.deepEqual(
    BUILTIN_AI_PALETTE_REGISTRY[0].label.aliases,
    ["AI", "ASSISTANT", "AUTOMATIC", "AUTOMATON", "LLM"],
  );
  assert.equal(BUILTIN_AI_PALETTE_REGISTRY[0].label.storageKey, "zine.modelLabel");
  assert.match(appSource, /localStorage\.setItem\(AI_PALETTE_ROW\.label\.storageKey, next\)/);
  assert.match(appSource, /Configure a model in Models to use AI operations/);
  assert.doesNotMatch(appSource, /onOpenModels|onAddModel|Add a model…|NO MODEL/);
  assert.doesNotMatch(cssSource, /action-palette-model-empty/);
});

test("the AI row keeps voice pins with first-provider fallback", () => {
  assert.match(
    appSource,
    /providers\.find\(\(p\) => p\.id === getVoiceProvider\(modelPubkey\)\)\?\.id \?\? providers\[0\]\?\.id \?\? ""/,
  );
  assert.match(appSource, /setVoiceProvider\(modelPubkey, providerId \|\| null\)/);
});

test("cosmetic row-label cyclers concisely explain that they do not change behavior", () => {
  assert.equal(
    (appSource.match(/title="Click to update label in view; no effect on behavior"/g) ?? []).length,
    2,
  );
  assert.equal(
    BUILTIN_AI_PALETTE_REGISTRY[0].label.rerollTitle,
    "Click to update label in view; no effect on behavior",
  );
  assert.match(appSource, /title=\{AI_PALETTE_ROW\.label\.rerollTitle\}/);
  assert.doesNotMatch(appSource, /Click to update label in view[^"\n]*Current:/);
});

test("voice and model selectors span exactly two action buttons", () => {
  assert.match(
    cssSource,
    /\.action-palette\s*\{[^}]*--action-palette-voice-width:\s*11\.3rem;/s,
  );
  assert.match(
    cssSource,
    /\.action-palette-group\s*\{[^}]*grid-template-columns:\s*minmax\(5\.5rem,\s*6\.25rem\)\s+var\(--action-palette-voice-width\)/s,
  );
  for (const selector of ["picker", "control", "listbox", "option"]) {
    assert.match(
      cssSource,
      new RegExp(`\\.action-palette-key-${selector}\\s*\\{[^}]*width:\\s*100%;`, "s"),
      selector,
    );
  }
});

test("narrow voice chips truncate labels before pubkeys", () => {
  assert.match(
    cssSource,
    /\.voice-chip-label\s*\{[^}]*flex:\s*1 1 0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
  );
  assert.match(
    cssSource,
    /\.voice-chip-pubkey\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*max-content;[^}]*white-space:\s*nowrap;/s,
  );
});

test("voice menu options omit selection checkmarks", () => {
  assert.doesNotMatch(appSource, /action-palette-key-check|afterLabel=/);
  assert.doesNotMatch(cssSource, /action-palette-key-check/);
  assert.doesNotMatch(voiceChipSource, /afterLabel/);
});

test("voice menu options stack vertically", () => {
  assert.match(
    cssSource,
    /\.action-palette-key-listbox\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/s,
  );
});

test("voice listbox supports keyboard navigation and escape", () => {
  assert.match(appSource, /case "ArrowDown":/);
  assert.match(appSource, /case "ArrowUp":/);
  assert.match(appSource, /case "Home":/);
  assert.match(appSource, /case "End":/);
  assert.match(appSource, /case "Escape":/);
  assert.match(appSource, /case "Tab":/);
});

test("palette selection states distinguish Mint, Coin, and invalid structure", () => {
  assert.equal(classifyPaletteSelection("before selected after", 7, 15), "loose");

  const pending = "before [[ selected ]] after";
  assert.equal(classifyPaletteSelection(pending, 10, 18), "pending");

  const resolved = "before [[ selected | node-1 ]] after";
  assert.equal(classifyPaletteSelection(resolved, 10, 18), "coin");

  assert.equal(classifyPaletteSelection(pending, 0, pending.length), "invalid");
  assert.equal(classifyPaletteSelection("nothing selected", 4, 4), "none");
});

test("palette primary action mutates from outlined Step to Mint or immutable Coin", () => {
  assert.deepEqual(palettePrimaryAction("none"), {
    label: "Step",
    title: "Step this trace as a local checkpoint, signed as this voice",
    tone: "step",
    actionable: true,
  });
  assert.equal(palettePrimaryAction("loose").label, "Mint");
  assert.equal(palettePrimaryAction("loose").tone, "mint");
  assert.equal(palettePrimaryAction("pending").label, "Mint");
  assert.equal(palettePrimaryAction("coin").label, "Coin");
  assert.equal(palettePrimaryAction("coin").actionable, false);
  assert.equal(palettePrimaryAction("invalid").tone, "invalid");
  assert.equal(palettePrimaryAction("invalid").actionable, false);
});

test("palette secondary actions follow passage semantics", () => {
  assert.deepEqual(paletteSecondaryActions("none"), {
    preserve: false,
    send: true,
    attest: true,
  });
  assert.deepEqual(paletteSecondaryActions("loose"), {
    preserve: true,
    send: false,
    attest: false,
  });
  assert.deepEqual(paletteSecondaryActions("pending"), {
    preserve: false,
    send: false,
    attest: false,
  });
  assert.deepEqual(paletteSecondaryActions("coin"), {
    preserve: false,
    send: false,
    attest: true,
  });
});

test("loose text offers Preserve as the enduring-text action", () => {
  assert.match(appSource, />\s*Preserve\s*<\/button>/);
  assert.match(appSource, /so it endures/);
});

test("Send receives the palette's auto-Step cue from the delivery policy", () => {
  assert.match(appSource, /sendAutoSteps=\{paletteSendAutoSteps\(\)\}/);
  assert.match(appSource, /planDelivery\("send", unsteppedPathSet\.has\(path\), file\.nodeId\)/);
  assert.match(appSource, /action-palette-action--auto-step/);
});

test("Attest composes missing delivery prerequisites with independent Step and Send cues", () => {
  assert.match(appSource, /attestPlan=\{paletteAttestationPlan\(\)\}/);
  assert.match(appSource, /await isTraceNodeSent\(citedId\)/);
  assert.match(appSource, /v\.op === "attest" && attestCreatesStep/);
  assert.match(appSource, /v\.op === "attest" && attestAutoSends/);
  assert.match(appSource, /action-palette-action--sends/);
  assert.match(cssSource, /\.action-palette-action--sends::after/);
  assert.doesNotMatch(cssSource, /action-palette-action--auto-deliver/);
});

test("the palette permits a deliberate Step when the focused trace is current", () => {
  assert.match(appSource, /stepAvailable=\{paletteStepIsAvailable\(\)\}/);
  assert.match(appSource, /steppedId = await stepFile\(path, signer, true, true\)/);
  assert.doesNotMatch(appSource, /No updates since the last Step/);
});

test("switching files collapses the previous editor range", () => {
  const switchedBranch = appSource.match(
    /if \(switched\) \{([\s\S]*?)\n\s*return;\n\s*\}/,
  )?.[1] ?? "";

  assert.match(switchedBranch, /selection:\s*EditorSelection\.cursor\(0\)/);
});

test("an opened Mint trace presents as an immutable Coin", () => {
  assert.match(
    appSource,
    /const targetPath = panels\[targetPanel\]\?\.active;\s*if \(targetPath && isMint\(targetPath\)\) return "coin";/,
  );
});

test("removed cited-trace editing is absent", () => {
  assert.doesNotMatch(appSource, /Step edited citation|editChip|PropagateModal|setPropagate/);
});
