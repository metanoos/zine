import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const modalSource = readFileSync(new URL("./CoinModal.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("Coin composing and inspection render as tab surfaces", () => {
  const coinView = modalSource.match(
    /export function CoinView[\s\S]*?(?=export interface DirectCoinComposerViewProps)/,
  )?.[0];
  const composerView = modalSource.match(
    /export function DirectCoinComposerView[\s\S]*/,
  )?.[0];
  assert.ok(coinView);
  assert.ok(composerView);
  assert.match(coinView, /<article[\s\S]*className="coin-view"/);
  assert.match(composerView, /<section[\s\S]*className="coin-view coin-composer-view"/);
  assert.doesNotMatch(modalSource, /CoinDialogFrame|createPortal/);
});

test("the Mint header exposes direct minting and Coins open as non-editor tabs", () => {
  const mintHeader = appSource.match(
    /isRoot && node\.systemKind === "mint"[\s\S]*?<\/span>/,
  )?.[0];
  assert.ok(mintHeader);
  assert.match(mintHeader, /className="tree-row-actions"/);
  assert.match(mintHeader, /aria-label="Mint a direct Coin"/);
  assert.match(mintHeader, /<CircleDollarSign size=\{14\}/);
  assert.match(
    appSource,
    /node\.systemKind === "mint" \? \([\s\S]*?<Leaf size=\{13\} className="tree-icon tree-icon-mint"/,
  );
  assert.match(appSource, /<DirectCoinComposerView/);
  assert.match(appSource, /function openDirectCoinComposer\(\)/);
  assert.match(appSource, /onMintCoin=\{openDirectCoinComposer\}/);
  assert.match(appSource, /function selectCoin\(path: string\)[\s\S]*?activateLiveTab\(path/);
  assert.match(
    appSource,
    /isCoinTab\(p\) \|\| isCoinComposerTab\(p\) \? \([\s\S]*?<CircleDollarSign size=\{12\}/,
  );
  assert.match(
    appSource,
    /node\.systemKind === "minted" \? \([\s\S]*?<CircleDollarSign size=\{13\}/,
  );
  assert.match(appSource, /const readOnlyTabDetail = isCoinTab\(p\)[\s\S]*?"Immutable Coin"/);
  assert.match(appSource, /coinComposerActive \? \([\s\S]*?<DirectCoinComposerView[\s\S]*?: coinActive \? \([\s\S]*?<CoinView/);
  assert.doesNotMatch(appSource, /coinModalPath|<CoinModal/);
});

test("newly minted Coins activate the same tab flow", () => {
  assert.match(appSource, /activateLiveTab\(coin\.path/);
  assert.match(appSource, /replaceDirectCoinComposerTab\(coin\.path\)/);
  assert.match(appSource, /commitUiFocus\(locateFocus\([\s\S]*?coin\.path/);
});

test("Coin surfaces use the green Coin color token in both themes", () => {
  assert.match(
    cssSource,
    /\.tab \.tab-status\.tab-status-coin\s*\{[\s\S]*?color:\s*var\(--coin-fg\)/,
  );
  assert.equal(
    (cssSource.match(/--coin-fg:\s*#2d6a2f(?:\s*!important)?;/g) ?? []).length,
    2,
  );
  assert.equal(
    (cssSource.match(/--coin-fg:\s*#82cf85(?:\s*!important)?;/g) ?? []).length,
    2,
  );
});

test("the direct Coin draft survives tab switches and retains KEdits", () => {
  assert.match(appSource, /interface DirectCoinDraft[\s\S]*?kedits: KEdit\[\][\s\S]*?nextTx: number/);
  assert.match(appSource, /function editDirectCoinDraft\(phrase: string\)[\s\S]*?diffToDeltas\(draft\.phrase, phrase\)/);
  assert.doesNotMatch(appSource, /directCoinComposerOpen|DirectCoinComposerModal/);
});
