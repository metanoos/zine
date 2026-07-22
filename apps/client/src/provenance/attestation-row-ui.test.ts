import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");
const cssSource = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");

test("attestations render below citations-in instead of in directory rows", () => {
  const footer = appSource.match(
    /const inboundFooter = file \? \(([\s\S]*?)\n  \) : null;/,
  );

  assert.ok(footer, "missing document footer");
  assert.ok(
    footer[1].indexOf("<InboundRow") < footer[1].indexOf("<AttestationRow"),
    "attestations should follow citations-in",
  );
  assert.match(appSource, /<span>ATTESTATIONS: \{count\}<\/span>/);
  assert.doesNotMatch(appSource, /tree-attestation-badge/);
  assert.doesNotMatch(cssSource, /\.tree-attestation-badge/);
});
