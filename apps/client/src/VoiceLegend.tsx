/** Document-level voice legend shown directly beneath outgoing citations. */

import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import {
  identityColors,
  identityForDisplayVoice,
  identityForPubkey,
  loadKeys,
} from "./keys-store.js";
import type { Run } from "./workspace-core.js";
import {
  collectVoiceAttributions,
  loadVoiceNicknames,
  saveVoiceNickname,
  shortVoiceKey,
  shouldShowVoiceLegend,
  voiceNpub,
} from "./voice-attribution-ui.js";

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
  const [copied, setCopied] = useState(false);
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
      setCopied(false);
      return;
    }
    setDraftNickname(selectedItem.local ? "" : nicknames[selectedItem.pubkey] ?? "");
    setCopied(false);
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

  async function copyKey(pubkey: string) {
    try {
      await navigator.clipboard.writeText(voiceNpub(pubkey));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
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
          const { fg, bg } = identityColors(identity, 0.13);
          const keyLabel = shortVoiceKey(item.pubkey);
          return (
            <button
              key={item.pubkey}
              type="button"
              className={
                "panel-voice-chip" +
                (selected === item.pubkey ? " is-selected" : "")
              }
              title={`${item.label ? `${item.label}\n` : ""}${voiceNpub(item.pubkey)}\n${item.charCount.toLocaleString()} attributed character${item.charCount === 1 ? "" : "s"}`}
              aria-pressed={selected === item.pubkey}
              onMouseEnter={() => setHovered(item.pubkey)}
              onMouseLeave={() => setHovered("")}
              onClick={() => setSelected((current) => (current === item.pubkey ? "" : item.pubkey))}
            >
              <span
                className="panel-voice-chip-identity voice-span"
                style={{ color: fg, background: bg, fontFamily: identity.font }}
              >
                {item.label ? <span className="panel-voice-chip-name">{item.label}</span> : null}
                <span className="panel-voice-chip-key">{keyLabel}</span>
              </span>
            </button>
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
            <code title={voiceNpub(selectedItem.pubkey)}>{voiceNpub(selectedItem.pubkey)}</code>
            <button
              type="button"
              className="panel-voice-copy"
              aria-label="Copy voice public key"
              onClick={() => void copyKey(selectedItem.pubkey)}
            >
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
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
