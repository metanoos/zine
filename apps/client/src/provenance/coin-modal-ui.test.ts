import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const modalSource = readFileSync(new URL("./CoinModal.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");
const networkingSource = readFileSync(new URL("../networking/Networking.tsx", import.meta.url), "utf8");

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
  const selectCoin = appSource.match(
    /function selectCoin\(path: string\)[\s\S]*?(?=\n  function selectOblivion)/,
  )?.[0];
  assert.ok(selectCoin);
  assert.match(selectCoin, /if \(!isCoinTab\(path\) \|\| !isCompletedCoinFile\(coin\)\) return/);
  assert.ok(
    selectCoin.indexOf("isCompletedCoinFile(coin)") < selectCoin.indexOf("activateLiveTab(path"),
  );
  assert.match(
    appSource,
    /completedCoinTab \|\| isCoinComposerTab\(p\) \? \([\s\S]*?<CircleDollarSign size=\{12\}/,
  );
  assert.match(
    appSource,
    /node\.systemKind === "minted" \? \([\s\S]*?<CircleDollarSign size=\{13\}/,
  );
  assert.match(appSource, /const readOnlyTabDetail = isCoinTab\(p\)[\s\S]*?"Immutable Coin"/);
  assert.match(appSource, /coinComposerActive \? \([\s\S]*?<DirectCoinComposerView[\s\S]*?: coinActive \? \([\s\S]*?<CoinView/);
  assert.match(appSource, /: incompleteMintActive \? \([\s\S]*?<IncompleteMintView/);
  assert.doesNotMatch(appSource, /coinModalPath|<CoinModal/);
});

test("legacy Mint artifacts never receive Coin or citation semantics", () => {
  assert.match(modalSource, /export function IncompleteMintView/);
  assert.match(modalSource, /It is not a Coin and is excluded from citation and[\s\S]*rendezvous/);
  assert.match(appSource, /const coinFile = isCoinTab\(activePath\) && isCompletedCoinFile\(file\)/);
  const selectCoin = appSource.match(
    /function selectCoin\(path: string\)[\s\S]*?(?=\n  function selectOblivion)/,
  )?.[0];
  assert.ok(selectCoin);
  assert.match(selectCoin, /!isCompletedCoinFile\(coin\)/);
  assert.match(appSource, /if \(isCoinTab\(srcPath\) && !isCompletedCoinFile\(src\)\) return false/);
  assert.match(appSource, /if \(!isCompletedCoinFile\(src\) \|\| !src\.nodeId\) return null/);
  assert.match(
    appSource,
    /if \(targetPath && isCoinTab\(targetPath\)\)[\s\S]*?isCompletedCoinFile\(files\[targetPath\]\)[\s\S]*?"coin"[\s\S]*?"none"/,
  );
  assert.match(
    appSource,
    /if \(isCoinTab\(path\)\)[\s\S]*?isCompletedCoinFile\(file\)[\s\S]*?kind: "coin"/,
  );
  assert.match(appSource, /ctxMenu\.systemKind === "minted"/);
  assert.match(appSource, /node\.systemKind !== "mint-pending"/);
  assert.match(appSource, /!isCompletedCoinFile\(source\)/);
});

test("newly minted Coins activate the same tab flow", () => {
  assert.match(appSource, /activateLiveTab\(coin\.path/);
  assert.match(appSource, /replaceDirectCoinComposerTab\(coin\.path\)/);
  assert.match(appSource, /commitUiFocus\(locateFocus\([\s\S]*?coin\.path/);
});

test("an open Coin tab reacts immediately when the Coins opt-in changes", () => {
  const coinView = modalSource.match(
    /export function CoinView[\s\S]*?(?=export interface DirectCoinComposerViewProps)/,
  )?.[0];
  assert.ok(coinView);
  assert.match(
    coinView,
    /useSyncExternalStore\([\s\S]*?subscribeKademliaConfig[\s\S]*?kademliaEnabledSnapshot/,
  );
  assert.match(coinView, /const rendezvousEnabled = isTauri\(\) && coinsEnabled/);
  assert.doesNotMatch(coinView, /loadKademliaConfig\(\)\.enabled/);
  assert.match(coinView, /\[phrase, rendezvousEnabled\]/);
});

test("Mint consent copy discloses publication and rendezvous distinguishes exact identity", () => {
  assert.match(modalSource, /Mint, publish, attest, and index this exact text/);
  assert.match(modalSource, /text will be public through configured publication relays/);
  assert.match(modalSource, /candidate\.coinNodeId === nodeId/);
  assert.match(modalSource, /completed this exact Mint/);
  assert.match(modalSource, /minted matching Coin text/);
  assert.match(modalSource, /candidate\.relayUrls\.length/);
  assert.match(networkingSource, /Mint\s+publishes the exact Coin text and a same-minter attestation/);
  assert.match(networkingSource, /A later citation or Send is not required/);
  assert.match(appSource, /function MintConsentModal/);
  assert.match(appSource, /This exact selected text will be public through configured publication relays/);
  assert.match(appSource, /no later[\s\S]*?citation or Send is required/);
  assert.match(appSource, /Mint does not publish the containing trace/);
  assert.match(appSource, /await requestMintConsent\(mintTarget\.phrase\)/);
  assert.match(appSource, /confirmedTarget\.phrase !== mintTarget\.phrase/);
});

test("scheduled co-Mint sweeps honor the live Coins opt-in, serialize, and abort", () => {
  const start = networkingSource.indexOf("function CoMintsSection()");
  const end = networkingSource.indexOf("\n  if (!isTauri())", start);
  assert.ok(start >= 0 && end > start);
  const section = networkingSource.slice(start, end);
  assert.match(
    section,
    /useSyncExternalStore\([\s\S]*?subscribeKademliaConfig[\s\S]*?kademliaEnabledSnapshot/,
  );
  assert.match(section, /if \(!coinsEnabled\) \{[\s\S]*?setMatches\(\[\]\)[\s\S]*?return;/);
  assert.ok(
    section.indexOf("if (!coinsEnabled)") < section.indexOf("await listPeers()"),
    "disabled Coins must return before reading peers",
  );
  assert.match(section, /if \(running \|\| cancelled\) return/);
  assert.match(section, /detectCoMints\(peers, 100, controller\.signal\)/);
  assert.match(section, /activeSweep\?\.abort\(new Error\("co-Mint view closed"\)\)/);
  assert.match(section, /\}, \[coinsEnabled\]\);/);
});

test("foreground Mint is fenced to its captured vault through completion", () => {
  const capture = appSource.match(
    /function captureForegroundMintLease\([\s\S]*?(?=async function mintCoinTrace)/,
  )?.[0];
  const mint = appSource.match(
    /async function mintCoinTrace\([\s\S]*?(?=\/\*\* Mint the text entered)/,
  )?.[0];
  assert.ok(capture);
  assert.ok(mint);
  assert.match(capture, /const generation = vaultStorageGeneration\(\)/);
  assert.match(capture, /const workspace = backendRef\.current/);
  assert.match(capture, /subscribeVaultStorage\(abortIfInvalid\)/);
  assert.match(capture, /subscribeKademliaConfig\(abortIfInvalid\)/);
  assert.match(capture, /controller\.abort\(error\)/);
  assert.match(mint, /capturedLease \?\? captureForegroundMintLease\(folder\.id\)/);
  assert.match(mint, /recoverPendingCoinMints\(operationKey, publicationController\.signal\)/);
  assert.match(mint, /getOrCreateMintFolder\([\s\S]*?foregroundPublicationFence/);
  assert.match(mint, /coinMintCompletionFor\([\s\S]*?publicationController\.signal/);
  assert.match(mint, /finally \{[\s\S]*?mintLease\.release\(\)/);
});

test("the Coins opt-in gates Mint and discovery without gating ordinary Cite", () => {
  assert.match(
    appSource,
    /const coinsEnabled = useSyncExternalStore\([\s\S]*?subscribeKademliaConfig[\s\S]*?kademliaEnabledSnapshot/,
  );
  const mint = appSource.match(
    /async function mintCoinTrace\([\s\S]*?(?=\/\*\* Mint the text entered)/,
  )?.[0];
  assert.ok(mint);
  assert.match(mint, /if \(!kademliaEnabledSnapshot\(\)\)[\s\S]*?Enable Coins in Networking/);
  assert.match(
    appSource,
    /isRoot && node\.systemKind === "mint"[\s\S]*?disabled=\{!coinsEnabled\}/,
  );
  assert.match(
    appSource,
    /const enabled =[\s\S]*?\(!hasMintablePassage \|\| coinsEnabled\)/,
  );
  const picker = appSource.slice(
    appSource.indexOf("pickerDisabled={"),
    appSource.indexOf("mergeCandidates={mergeCandidates}"),
  );
  assert.doesNotMatch(picker, /!coinsEnabled|!kademliaEnabledSnapshot\(\)/);
  assert.match(picker, /onAddCitation=\{\(nodeId\) => \{[\s\S]*?editCitations/);
  const copy = appSource.match(
    /function copySelectionWithCoin\([\s\S]*?(?=\/\*\* Resolve a clipboard ticket)/,
  )?.[0];
  const paste = appSource.match(
    /function pasteSelectionWithCoin\([\s\S]*?(?=\/\/ Resolve the right-click surface)/,
  )?.[0];
  assert.ok(copy && paste);
  assert.doesNotMatch(copy, /kademliaEnabledSnapshot/);
  assert.doesNotMatch(paste, /kademliaEnabledSnapshot/);
  assert.match(appSource, /function copiedTraceCitation[\s\S]*?lastSteppedRef\.current\.get/);
  assert.match(modalSource, /const canMint = enabled && phrase\.trim\(\)\.length > 0 && !busy/);
  assert.match(
    appSource,
    /: coinActive \? \([\s\S]*?<CoinView[\s\S]*?phrase=\{flatten\(file\.runs\)\}/,
    "existing Coin inspection stays available while authoring is disabled",
  );
});

test("Mint completes Step, Publish, and minter-Attest before success", () => {
  const completion = appSource.match(
    /function coinMintCompletionFor\([\s\S]*?(?=\/\*\* Retry every durable Mint)/,
  )?.[0];
  const mint = appSource.match(
    /async function mintCoinTrace\([\s\S]*?(?=\/\*\* Mint the text entered)/,
  )?.[0];
  assert.ok(completion);
  assert.ok(mint);
  assert.match(mint, /publish(?:DirectCoin|HardenedSpan)\(/);
  assert.match(mint, /prepareOnly: true/);
  assert.match(mint, /const operationId = createTraceOperationId\(\)/);
  assert.match(mint, /mintedPath\(phrase, new Date\(\), taken, operationId\)/);
  assert.match(mint, /publishDirectCoin\([\s\S]*?operationId/);
  assert.match(mint, /publishHardenedSpan\([\s\S]*?operationId/);
  assert.match(
    mint,
    /const receipt = await completePendingCoinMintTransaction\([\s\S]*?pending,[\s\S]*?coinMintCompletionFor\([\s\S]*?mintSigner,[\s\S]*?sourceCompletion\?\.finalize,[\s\S]*?publicationController\.signal/,
  );
  assert.match(
    completion,
    /publishPair: \(coin: Event\) => completeCoinMint\(coin, signer, publicationFence\)/,
  );
  assert.match(completion, /vaultStorageSessionAcceptsWork\(\)[\s\S]*?kademliaEnabledSnapshot\(\)/);
  assert.match(completion, /coinComplete: true/);
  assert.match(mint, /attestationId: receipt\.attestation\.id/);
  assert.ok(
    mint.indexOf("completePendingCoinMintTransaction(") <
      mint.indexOf("attestationId: receipt.attestation.id"),
    "unfinished Mint attempts must not report a successful attestation",
  );
  assert.ok(
    mint.indexOf("await recoverPendingCoinMints(operationKey)") <
      mint.indexOf("currentNodeId !== source.sourceNodeId") &&
      mint.indexOf("currentNodeId !== source.sourceNodeId") <
      mint.indexOf("preparePendingCoinMint(operationKey"),
    "desktop Mint must revalidate its captured source after recovery and before preparation",
  );
  assert.match(mint, /await sha256HexLocal\(currentText\) !== source\.sourceContentHash/);
  assert.match(mint, /bracket\.matchStart === source\.bracketRange\.start/);
  assert.match(
    mint,
    /pendingCoinMints\(\)[\s\S]*?record\.sourceFolderId === sourceFolderId[\s\S]*?record\.localPath/,
    "durable unfinished Mint paths remain reserved while allocating a new Coin",
  );
  assert.match(
    mint,
    /Object\.keys\(loadLocalFolder\(sourceFolderId\)\?\.files \?\? \{\}\)/,
    "durable local inventory participates in path allocation before React commits",
  );
  assert.match(completion, /filesRef\.current = \{ \.\.\.filesRef\.current, \[record\.localPath\]: nextFile \}/);
  assert.match(completion, /finalizeSource/);
  assert.match(
    appSource,
    /finalizeStoredMintSource\(record, signer, \{[\s\S]*?generation,[\s\S]*?folderId: sourceFolderId,[\s\S]*?signal: publicationSignal/,
    "startup recovery must carry its captured vault lease into source finalization",
  );
  assert.match(
    appSource,
    /lease\.workspace\.writeFile\([\s\S]*?\{ signal: lease\.signal, enabled:/,
    "the source Step itself must share the recovery cancellation fence",
  );
  assert.match(
    appSource,
    /const sourceStepKedits = finalizedCoinMintSourceStepKEdits\([\s\S]*?lease\.workspace\.writeFile\([\s\S]*?sourceStepKedits/,
    "source recovery must publish the exact pending editor log plus its citation transaction",
  );
  assert.match(appSource, /rebaseFinalizedCoinMintSourceFile\(/);
  assert.match(appSource, /resumePendingCoinMints\([\s\S]*?vaultStorage/);
  assert.match(
    appSource,
    /useEffect\(\(\) => \{[\s\S]*?bootState !== "ready"[\s\S]*?activeMintRecoveriesRef\.current\.acquire\(session, async \(signal\)/,
    "pending Mints recover as soon as the active vault workspace is ready",
  );
  assert.match(
    appSource,
    /activeMintRecoveriesRef\.current\.acquire\(session, async \(signal\)[\s\S]*?recoverPendingCoinMints\(undefined, signal\)[\s\S]*?return recovery\.release/,
    "disabling Coins must fence every recovery phase that has not begun publishing",
  );
  const recoveryEffect = appSource.match(
    /const session = `\$\{generation\}:\$\{folder\.id\}:\$\{keyFingerprint\}`[\s\S]*?\}, \[bootState, coinsEnabled, folder\?\.id, keys, mintRecoveryEpoch\]\);/,
  )?.[0];
  assert.ok(recoveryEffect);
  assert.doesNotMatch(recoveryEffect, /recoveredMintSessionsRef/);
  assert.match(recoveryEffect, /retryCoinMintRecovery\(/);
  assert.match(recoveryEffect, /waitForMintRecoveryRetry/);
  assert.match(recoveryEffect, /mintRecoveryEpoch/);
  assert.match(
    appSource,
    /pendingCoinMints\(\)\.some\(\(record\) => record\.operationKey === operationKey\)[\s\S]*?setMintRecoveryEpoch/,
    "a failed foreground Mint must restart recovery after an initially empty startup",
  );
  assert.match(
    appSource,
    /function moveNodes[\s\S]*?blocksPendingMintSourceMutation\([\s\S]*?function stepFolderPath/,
    "moving an unfinished extracted-Mint source must be blocked before optimistic state changes",
  );
  assert.match(
    appSource,
    /function deleteNodes[\s\S]*?blocksPendingMintSourceMutation\([\s\S]*?function hardDelete[\s\S]*?blocksPendingMintSourceMutation\(/,
    "both recycle-bin and permanent deletes must retain unfinished Mint sources",
  );
  assert.match(
    appSource,
    /function renameNode[\s\S]*?blocksPendingMintSourceMutation\(/,
    "renaming an unfinished extracted-Mint source must fail before rebasing UI paths",
  );
  const extractedMintGesture = appSource.match(
    /async function zinePhrase\([\s\S]*?(?=\/\*\* Copy can carry)/,
  )?.[0];
  assert.ok(extractedMintGesture);
  assert.ok(
    extractedMintGesture.indexOf("mintSourceReservations.reserve") <
      extractedMintGesture.indexOf("sha256HexLocal(sourceSnapshot)"),
    "the extracted source must be reserved synchronously before the first Mint awaitable starts",
  );
  assert.match(
    extractedMintGesture,
    /flushEditorLocally\([\s\S]*?mintLease\.fence[\s\S]*?mintCoinTrace\([\s\S]*?mintLease/,
    "the source Step and compound Mint must share one captured lease",
  );
  assert.match(
    extractedMintGesture,
    /finally \{\s*mintLease\.release\(\);\s*releaseSourceReservation\(\);\s*\}/,
  );
  assert.match(
    appSource,
    /waitForMintRecoveryRetry[\s\S]*?window\.addEventListener\("online", onOnline/,
    "network recovery must wake a failed Mint transaction before its next timer",
  );
  assert.match(appSource, /className="mint-recovery-alert" role="alert"/);
  assert.match(
    appSource,
    /refreshMintRecoveryNotice\(\);[\s\S]*?if \(!coinsEnabled\) \{[\s\S]*?return;/,
    "pending Mint status is visible even when automatic recovery is disabled",
  );
  assert.match(appSource, /result\.failures\.map\(\(failure\) => failure\.error\)/);
  assert.match(appSource, /may already be public/);
  const recoveryAlert = appSource.match(
    /\{mintRecoveryNotice && \([\s\S]*?(?=\{oblivionModalPath)/,
  )?.[0];
  assert.ok(recoveryAlert);
  assert.doesNotMatch(recoveryAlert, />Dismiss</);
  const phraseMint = appSource.match(
    /async function zinePhrase\([\s\S]*?(?=\/\*\* Copy can carry)/,
  )?.[0];
  assert.ok(phraseMint);
  assert.match(phraseMint, /sourceFinalization|metadata:[\s\S]*?kind: "pending-bracket"/);
  assert.match(
    phraseMint,
    /resolvedFinalizedCoinMintSourceText\(\s*record,\s*sourceSnapshot,\s*afterWrite/,
  );
  assert.ok(
    phraseMint.indexOf("await mintCoinTrace(") <
      phraseMint.indexOf("activateLiveTab(coin.path"),
    "the source citation phase must finish before Mint reports success",
  );
});

test("copy carries an exact stepped-source citation and never mints", () => {
  const copy = appSource.match(
    /function copiedTraceCitation\([\s\S]*?(?=\/\*\* Resolve a clipboard ticket)/,
  )?.[0];
  assert.ok(copy);
  assert.match(copy, /findResolvedBrackets\(docText\)/);
  assert.match(copy, /lastSteppedRef\.current\.get\(path\)/);
  assert.match(copy, /stepped\?\.content === docText/);
  assert.doesNotMatch(copy, /mintCoinTrace|publishHardenedSpan|flushEditorLocally/);
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
