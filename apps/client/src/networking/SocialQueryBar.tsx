import { Search, X } from "lucide-react";
import type { SocialQuery, SocialScope, SocialWindow } from "./social-query.js";

const WINDOWS: SocialWindow[] = ["24h", "7d", "30d", "all"];
const SCOPES: Array<{ value: SocialScope; label: string }> = [
  { value: "read-relays", label: "read relays" },
  { value: "following", label: "following" },
  { value: "peers", label: "peers" },
  { value: "mine", label: "mine" },
];

/** One persistent bound shared by Stacks, Times, and Spaces. It deliberately
 * says "read relays", not "network": Kademlia global discovery is planned but
 * not implemented, so every aggregate is a partial view of reachable events. */
export function SocialQueryBar({
  query,
  onChange,
}: {
  query: SocialQuery;
  onChange: (query: SocialQuery) => void;
}) {
  const patch = (next: Partial<SocialQuery>) => onChange({ ...query, ...next });
  return (
    <section className="social-query-bar" aria-label="Shared social query">
      <label className="social-query-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query.text}
          placeholder="zine, tag, or id…"
          aria-label="Filter zines"
          onChange={(event) => patch({ text: event.target.value })}
        />
        {query.text && (
          <button type="button" aria-label="Clear query" onClick={() => patch({ text: "" })}>
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </label>

      <label className="social-query-scope">
        <span>from</span>
        <select
          value={query.scope}
          onChange={(event) => patch({ scope: event.target.value as SocialScope })}
        >
          {SCOPES.map((scope) => (
            <option key={scope.value} value={scope.value}>{scope.label}</option>
          ))}
        </select>
      </label>

      <div className="social-query-windows" role="group" aria-label="Time window">
        {WINDOWS.map((window) => (
          <button
            key={window}
            type="button"
            className={query.window === window ? "active" : ""}
            aria-pressed={query.window === window}
            onClick={() => patch({ window })}
          >
            {window}
          </button>
        ))}
      </div>

      <span
        className="social-query-partial"
        title="Partial aggregate: only events reachable from your configured read relays. The planned Kademlia layer will discover event pointers, not compute global counts."
      >
        partial · read relays
      </span>
    </section>
  );
}

