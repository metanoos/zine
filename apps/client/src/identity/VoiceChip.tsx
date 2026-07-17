import { forwardRef } from "react";
import type {
  ButtonHTMLAttributes,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";
import { identityColors, type KeyIdentity } from "./keys-store.js";
import { formatPubkey, PubkeyCopyButton } from "./PubkeyDisplay.js";

type VoiceChipActionProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className" | "style" | "type"
>;

export interface VoiceChipProps {
  label: string;
  pubkey?: string;
  identity?: KeyIdentity;
  selected?: boolean;
  className?: string;
  actionClassName?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  actionProps?: VoiceChipActionProps;
  copyTabIndex?: number;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

/**
 * Canonical voice identity chip: visual voice label, compact raw pubkey, and
 * one raw-pubkey copy action. Surfaces own selection behavior and selector
 * affordances; the identity presentation stays shared.
 */
export const VoiceChip = forwardRef<HTMLButtonElement, VoiceChipProps>(function VoiceChip(
  {
    label,
    pubkey,
    identity,
    selected = false,
    className = "",
    actionClassName = "",
    leading,
    trailing,
    actionProps,
    copyTabIndex,
    onMouseEnter,
    onMouseLeave,
    onKeyDown,
  },
  ref,
) {
  const colors = identity ? identityColors(identity, 0.18) : null;

  return (
    <div
      className={`voice-chip${selected ? " is-selected" : ""}${className ? ` ${className}` : ""}`}
      style={colors ? { color: colors.fg, background: colors.bg, fontFamily: identity?.font } : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <button
        {...actionProps}
        ref={ref}
        type="button"
        className={`voice-chip-action${actionClassName ? ` ${actionClassName}` : ""}`}
        onKeyDown={onKeyDown ?? actionProps?.onKeyDown}
      >
        {leading}
        <span className="voice-chip-label">{label}</span>
        {pubkey ? (
          <code className="voice-chip-pubkey" title={pubkey}>{formatPubkey(pubkey)}</code>
        ) : null}
        {trailing}
      </button>
      {pubkey ? (
        <PubkeyCopyButton
          pubkey={pubkey}
          className="voice-chip-copy"
          tabIndex={copyTabIndex}
        />
      ) : null}
    </div>
  );
});
