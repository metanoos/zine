/** Document-level voice legend shown directly above outgoing citations. */

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import {
  identityForDisplayVoice,
  identityForPubkey,
  loadKeys,
} from "./keys-store.js";
import type { Run } from "../workspace/workspace-core.js";
import {
  collectVoiceAttributions,
  loadVoiceNicknames,
  saveVoiceNickname,
  shouldShowVoiceLegend,
  voiceKeyForCopy,
} from "./voice-attribution-ui.js";
import { PubkeyDisplay } from "./PubkeyDisplay.js";
import { VoiceChip } from "./VoiceChip.js";

const COLLAPSED_VOICE_COUNT = 5;

export function VoiceLegend({
  runs,
  onFocusVoice,
}: {
  runs: readonly Run[];
  /** Empty string clears the document's temporary voice isolation. */
  onFocusVoice: (pubkey: string) => void;
}) {
  const [nicknames, setNicknames] = useState(loadVoiceNicknames);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState("");
  const [selected, setSelected] = useState("");
  const [draftNickname, setDraftNickname] = useState("");
  const [copiedNpub, setCopiedNpub] = useState(false);
  // Resolving a published foreign style mutates the shared identity cache.
  // This revision makes the legend itself repaint; FileEditor separately
  // subscribes to the same cache and refreshes CodeMirror decorations.
  const [, setStyleRevision] = useState(0);

  const items = collectVoiceAttributions(runs, loadKeys(), nicknames);
  const itemSignature = items.map((item) => item.pubkey).join("\u0000");
  const visible = expanded ? items : items.slice(0, COLLAPSED_VOICE_COUNT);
  const hiddenCount = Math.max(0, items.length - visible.length);
  const selectedItem = items.find((item) => item.pubkey === selected) ?? null;
  const activeFocus = hovered || selected;
  const onFocusVoiceRef = useRef(onFocusVoice);
  onFocusVoiceRef.current = onFocusVoice;

  useEffect(() => {
    onFocusVoiceRef.current(activeFocus);
  }, [activeFocus]);

  useEffect(() => {
    return () => onFocusVoiceRef.current("");
  }, []);

  // A tab switch can reuse this component instance. Drop stale interaction
  // state if the newly visible document no longer contains the selected voice.
  useEffect(() => {
    setExpanded(false);
    setHovered("");
    setSelected((current) => (items.some((item) => item.pubkey === current) ? current : ""));
  }, [itemSignature]);

  useEffect(() => {
    if (!selectedItem) {
      setDraftNickname("");
      setCopiedNpub(false);
      return;
    }
    setDraftNickname(selectedItem.local ? "" : nicknames[selectedItem.pubkey] ?? "");
    setCopiedNpub(false);
  }, [selectedItem?.pubkey, selectedItem?.local, nicknames]);

  // Resolve remote kind-34292 styles (or the deterministic per-pubkey
  // fallback) once per document voice set. The immediate render already uses
  // the deterministic style, so a slow/offline relay never leaves bare text.
  useEffect(() => {
    const foreign = items
      .filter((item) => !item.local && /^[0-9a-f]{64}$/i.test(item.pubkey))
      .map((item) => item.pubkey);
    if (foreign.length === 0) return;
    let cancelled = false;
    Promise.allSettled(foreign.map((pubkey) => identityForPubkey(pubkey))).then(() => {
      if (!cancelled) setStyleRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
    // itemSignature is the stable voice-set identity; labels/text edits do not
    // need to re-query relays.
  }, [itemSignature]);

  if (!shouldShowVoiceLegend(items)) return null;

  function commitNickname(pubkey: string) {
    setNicknames(saveVoiceNickname(pubkey, draftNickname));
  }

  async function copyNpub(pubkey: string) {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(voiceKeyForCopy(pubkey, "npub"));
      setCopiedNpub(true);
      window.setTimeout(() => setCopiedNpub(false), 1200);
    } catch {
      setCopiedNpub(false);
    }
  }

  return (
    <div
      className="panel-voices-bar"
      aria-label={`Text attribution: ${items.length} voice${items.length === 1 ? "" : "s"}`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <span className="panel-voices-summary">VOICES: {items.length}</span>
      <div className="panel-voice-list">
        {visible.map((item) => {
          const identity = identityForDisplayVoice(item.pubkey);
          return (
            <VoiceChip
              key={item.pubkey}
              className="panel-voice-chip"
              label={item.label || "Voice"}
              pubkey={item.pubkey}
              identity={identity}
              selected={selected === item.pubkey}
              onMouseEnter={() => setHovered(item.pubkey)}
              onMouseLeave={() => setHovered("")}
              actionProps={{
                title: `${item.label ? `${item.label}\n` : ""}${item.pubkey}\n${item.charCount.toLocaleString()} attributed character${item.charCount === 1 ? "" : "s"}`,
                "aria-pressed": selected === item.pubkey,
                onClick: () => setSelected((current) => (current === item.pubkey ? "" : item.pubkey)),
              }}
            />
          );
        })}
        {hiddenCount > 0 ? (
          <button type="button" className="panel-voice-more" onClick={() => setExpanded(true)}>
            +{hiddenCount} voice{hiddenCount === 1 ? "" : "s"}
          </button>
        ) : expanded && items.length > COLLAPSED_VOICE_COUNT ? (
          <button type="button" className="panel-voice-more" onClick={() => setExpanded(false)}>
            show less
          </button>
        ) : null}
      </div>

      {selectedItem ? (
        <div className="panel-voice-popover" role="dialog" aria-label="Voice details">
          <div className="panel-voice-popover-head">
            <span>{selectedItem.local ? "personal voice" : "foreign voice"}</span>
            <button
              type="button"
              className="panel-voice-popover-close"
              aria-label="Close voice details"
              onClick={() => setSelected("")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="panel-voice-full-key">
            <PubkeyDisplay pubkey={selectedItem.pubkey} className="panel-voice-pubkey-display" />
            <button
              type="button"
              className="panel-voice-format-copy"
              title="Copy npub"
              aria-label="Copy npub"
              onClick={() => void copyNpub(selectedItem.pubkey)}
            >
              {copiedNpub ? <Check size={12} aria-hidden="true" /> : "npub"}
            </button>
          </div>
          <span className="panel-voice-coverage">
            {selectedItem.charCount.toLocaleString()} attributed character{selectedItem.charCount === 1 ? "" : "s"}
          </span>
          {!selectedItem.local ? (
            <label className="panel-voice-nickname">
              <span>name locally</span>
              <input
                value={draftNickname}
                placeholder="optional nickname"
                onChange={(event) => setDraftNickname(event.target.value)}
                onBlur={() => commitNickname(selectedItem.pubkey)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitNickname(selectedItem.pubkey);
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    setDraftNickname(nicknames[selectedItem.pubkey] ?? "");
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
          ) : (
            <span className="panel-voice-local-label">label · {selectedItem.label}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
