import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");

test("the wrapped press editor never exposes horizontal scrolling", () => {
  const scroller = source.match(/"\.cm-scroller":\s*\{([^}]*)\}/s);
  assert.ok(scroller, "missing CodeMirror scroller theme");

  assert.match(source, /EditorView\.lineWrapping/);
  assert.match(scroller[1], /overflowX:\s*"hidden"/);
  assert.match(scroller[1], /overflowY:\s*"auto"/);
});

test("streamed appends restore both bottom and fixed scroll anchors", () => {
  const plugin = source.match(
    /const stickToBottom = ViewPlugin\.fromClass\(([\s\S]*?)\n\);\n\n\/\/ --- document chrome slots/,
  );
  assert.ok(plugin, "missing streaming scroll plugin");

  assert.match(plugin[1], /captureStreamingScrollAnchor/);
  assert.match(plugin[1], /restoreStreamingScrollTop/);
  assert.match(source, /effect\.is\(opVoiceEffect\)/);
  assert.match(source, /effect\.is\(setRunsEffect\)/);
});

test("voice attribution sits outside the citation bars", () => {
  const header = source.match(
    /const provenanceHeader = file \? \(([\s\S]*?)\n  \) : null;/,
  );
  assert.ok(header, "missing document provenance header");

  const voiceIndex = header[1].indexOf("<VoiceLegend");
  const citationIndex = header[1].indexOf("{citationBar}");
  assert.ok(voiceIndex >= 0, "missing voice attribution in document header");
  assert.ok(citationIndex > voiceIndex, "outgoing citations must remain flush with the body");
});
