import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyPaletteSelection,
  palettePrimaryAction,
  paletteSecondaryActions,
} from "./palette.js";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("the persistent control is named ActionPalette, not TopBar or CommandPalette", () => {
  assert.match(appSource, /function ActionPalette/);
  assert.doesNotMatch(appSource, /function TopBar/);
  assert.doesNotMatch(appSource, /function CommandPalette/);
  assert.doesNotMatch(appSource, /paletteOpen|setPaletteOpen/);
  assert.doesNotMatch(appSource, /e\.key === "k"/);
});

test("file and folder scans open directly from separate palette actions", () => {
  assert.match(appSource, />\s*Scan File\s*<\/button>/);
  assert.match(appSource, />\s*Scan Folder\s*<\/button>/);
  assert.match(appSource, /onClick=\{\(\) => onScan\("file"\)\}/);
  assert.match(appSource, /onClick=\{\(\) => onScan\("folder"\)\}/);
  assert.doesNotMatch(appSource, /scanOpen|setScanOpen/);
});

test("scan labels stay on one line in one widened action track each", () => {
  assert.match(
    cssSource,
    /repeat\(6,\s*minmax\(5\.75rem,\s*6\.5rem\)\)/,
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

test("the palette disables Step when the focused trace is current", () => {
  assert.match(appSource, /stepAvailable=\{paletteStepIsAvailable\(\)\}/);
  assert.match(appSource, /No updates since the last Step/);
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

test("legacy cited-trace editing is absent", () => {
  assert.doesNotMatch(appSource, /Step edited citation|editChip|PropagateModal|setPropagate/);
});
