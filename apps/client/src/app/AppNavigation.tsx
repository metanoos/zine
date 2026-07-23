import {
  BarChart3,
  Cpu,
  Download,
  FileText,
  Globe,
  KeyRound,
  Layers3,
  Megaphone,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Sun,
  Vault,
  type LucideIcon,
} from "lucide-react";
import { Component, type ReactNode } from "react";
import { isTauri } from "../identity/identity.js";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";

// Views reachable from the nav rail. `editor` is the existing two-panel
// workspace; the rest are placeholders awaiting real implementations
// (globe → maplibre, keys/relays → nostr, models → LLM keys).
type View = "about" | "listings" | "editor" | "stats" | "globe" | "vaults" | "keys" | "networking" | "models" | "download" | "operator";

// Theme: "auto" follows prefers-color-scheme; "light"/"dark" are explicit
// overrides applied via <html data-theme>. main.tsx sets the attribute before
// React mounts to avoid a flash; these helpers keep the attribute + storage
// in sync as the user toggles.
const THEME_STORAGE_KEY = "zine-theme";
type Theme = "auto" | "light" | "dark";

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "auto") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

// Whether the far-left nav rail is expanded (labels + wordmark visible) or
// collapsed (icon-only). Default open so first-time users see the labeled nav;
// once the user collapses it the choice is remembered across reloads.
const RAIL_EXPANDED_KEY = "zine.navRailExpanded";
function readRailExpanded(): boolean {
  const stored = localStorage.getItem(RAIL_EXPANDED_KEY);
  // Anything other than an explicit "false" → expanded (first-time users and
  // corrupt values both fall back to open).
  return stored !== "false";
}

// The resolved mode (what the user actually sees) drives which toggle icon to show.
function resolvedMode(theme: Theme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const EYE_SPEECH = "👁️\u200d🗨️";

// --- nav rail ----------------------------------------------------------

// The brand glyph (eye-in-speech-bubble) anchors the rail's head and is also
// the entry to the About page. Below it sit the work views (editor → globe);
// the bottom group holds management views (keys, relays, models). The top
// group flex-grows to push the bottom group to the rail's foot.
type RailItem = { view: View; Icon: LucideIcon; label: string };

const RAIL_TOP: RailItem[] = [
  { view: "editor", Icon: FileText, label: "The Press" },
];
const RAIL_LISTS: RailItem[] = [
  { view: "listings", Icon: Layers3, label: "Stacks" },
  { view: "stats", Icon: BarChart3, label: "Times" },
  { view: "globe", Icon: Globe, label: "Spaces" },
];
const RAIL_BOTTOM_TOP: RailItem[] = [
  { view: "download", Icon: Download, label: "Download" },
];
const RAIL_BOTTOM: RailItem[] = [
  { view: "vaults", Icon: Vault, label: "Vaults" },
  { view: "keys", Icon: KeyRound, label: "Keys" },
  { view: "models", Icon: Cpu, label: "Models" },
  { view: "networking", Icon: Radio, label: "Networks" },
];

function RailButton({
  item,
  active,
  onSelect,
  expanded,
}: {
  item: RailItem;
  active: boolean;
  onSelect: (v: View) => void;
  expanded: boolean;
}) {
  const { Icon, label } = item;
  return (
    <button
      type="button"
      className={"rail-item" + (active ? " active" : "")}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      onClick={() => onSelect(item.view)}
    >
      <Icon size={20} strokeWidth={1.75} />
      {expanded && <span className="rail-item-label">{label}</span>}
    </button>
  );
}

function NavRail({
  activeView,
  onSelect,
  expanded,
  onToggleExpanded,
  theme,
  onToggleTheme,
  showOperator,
}: {
  activeView: View;
  onSelect: (v: View) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Web-only: show the operator entry when the current voice is operator or
   *  curation team. Driven by operator-store.isStaff(). */
  showOperator?: boolean;
}) {
  const mode = resolvedMode(theme);
  return (
    <nav className={"nav-rail" + (expanded ? " expanded" : "")} aria-label="Views">
      <button
        type="button"
        className={"rail-brand" + (activeView === "about" ? " active" : "")}
        aria-label="Docs"
        aria-current={activeView === "about" ? "page" : undefined}
        title="Docs"
        onClick={() => onSelect("about")}
      >
        <span className="rail-brand-emoji" aria-hidden="true">{EYE_SPEECH}</span>
        {expanded && <span className="rail-brand-wordmark">zine</span>}
      </button>
      <div className="rail-divider" aria-hidden="true" />
      <div className="nav-rail-top">
        {RAIL_TOP.map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={activeView === item.view}
            onSelect={onSelect}
            expanded={expanded}
          />
        ))}
      </div>
      <div className="rail-divider" aria-hidden="true" />
      <div className="nav-rail-lists">
        {RAIL_LISTS.map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={activeView === item.view}
            onSelect={onSelect}
            expanded={expanded}
          />
        ))}
      </div>
      <div className="rail-divider" aria-hidden="true" />
      <div className="nav-rail-bottom">
        {RAIL_BOTTOM.filter((item) => item.view !== "vaults" || isTauri()).map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={activeView === item.view}
            onSelect={onSelect}
            expanded={expanded}
          />
        ))}
        {!isTauri() && (
          <>
            <div className="rail-divider" aria-hidden="true" />
            <div className="nav-rail-bottom-bottom">
              {RAIL_BOTTOM_TOP.map((item) => (
                <RailButton
                  key={item.view}
                  item={item}
                  active={activeView === item.view}
                  onSelect={onSelect}
                  expanded={expanded}
                />
              ))}
              {showOperator && (
                <RailButton
                  item={{ view: "operator", Icon: Megaphone, label: "Operator" }}
                  active={activeView === "operator"}
                  onSelect={onSelect}
                  expanded={expanded}
                />
              )}
            </div>
          </>
        )}
      </div>
      <div className="rail-footer">
        <div className="rail-divider" aria-hidden="true" />
        <button
          type="button"
          className="rail-item"
          aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={mode === "dark" ? "Light mode" : "Dark mode"}
          onClick={onToggleTheme}
        >
          {mode === "dark" ? (
            <Sun size={20} strokeWidth={1.75} />
          ) : (
            <Moon size={20} strokeWidth={1.75} />
          )}
          {expanded && (
            <span className="rail-item-label">{mode === "dark" ? "Light" : "Dark"}</span>
          )}
        </button>
        <button
          type="button"
          className="rail-item"
          aria-label={expanded ? "Collapse rail" : "Expand rail"}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
          onClick={onToggleExpanded}
        >
          {expanded ? (
            <PanelLeftClose size={20} strokeWidth={1.75} />
          ) : (
            <PanelLeftOpen size={20} strokeWidth={1.75} />
          )}
          {expanded && (
            <span className="rail-item-label">{expanded ? "Collapse" : "Expand"}</span>
          )}
        </button>
      </div>
    </nav>
  );
}

// --- view placeholder --------------------------------------------------

const VIEW_META: Record<Exclude<View, "editor">, { title: string; blurb: string }> = {
  about: { title: "Docs", blurb: "What zine is and how it fits together." },
  listings: { title: "Stacks", blurb: "An editorial selection of zines, arranged into named sections." },
  stats: { title: "Times", blurb: "Zines on this relay, ranked by metric per unit time." },
  globe: { title: "Spaces", blurb: "Zines pinned to geohashes, rendered at their level." },
  vaults: { title: "Vaults", blurb: "Parallel Roots, each protected by its own passphrase." },
  keys: { title: "Keys", blurb: "Nostr keypairs (voices) you sign and attribute text with." },
  networking: { title: "Networks", blurb: "Your node, your seeds, your peers — where your writing lives, where it's backed up, and who can reach you." },
  models: { title: "Models", blurb: "LLM providers for prompt injection." },
  download: { title: "Download", blurb: "Get the desktop app." },
  operator: { title: "Operator", blurb: "Relay operator: curation team and moderation." },
};

// Top-left title for every view. Sourced from the same labels the nav rail uses
// (RAIL_TOP/RAIL_LISTS/etc.) so a title and its rail entry can never drift.
// `editor` ("Press") is added here since VIEW_META intentionally excludes it.
const VIEW_TITLES: Record<View, string> = {
  editor: "The Press",
  about: VIEW_META.about.title,
  listings: VIEW_META.listings.title,
  stats: VIEW_META.stats.title,
  globe: VIEW_META.globe.title,
  vaults: VIEW_META.vaults.title,
  keys: VIEW_META.keys.title,
  networking: VIEW_META.networking.title,
  models: VIEW_META.models.title,
  download: VIEW_META.download.title,
  operator: VIEW_META.operator.title,
};

function viewTitle(view: View): string {
  return VIEW_TITLES[view];
}

// Shared header pinned to the top-left of every view. Renders once at the shell
// level so each view gets a consistent title without having to draw its own.
function ViewHeader({ view }: { view: View }) {
  return (
    <header className="view-header">
      <h1 className="view-header-title">{viewTitle(view)}</h1>
    </header>
  );
}

function ViewPlaceholder({ view }: { view: Exclude<View, "editor"> }) {
  const meta = VIEW_META[view];
  return (
    <section className="view-placeholder">
      <p className="view-placeholder-blurb">{meta.blurb}</p>
      <p className="view-placeholder-soon">Coming soon</p>
    </section>
  );
}

// --- view error boundary ------------------------------------------------
//
// A throw in any child view (e.g. a transient HMR module-cache inconsistency
// in keys-store.ts once crashed <KeysView> with "Cannot read properties of
// undefined" and unmounted the whole tree → blank app). React has no built-in
// recovery from a render-time throw without a boundary, so this keeps a
// single bad view from taking down the shell. The nav stays usable; the user
// can switch away and back. The error is logged for the console, matching
// how every other surface surfaces failure in this app (no global toast).
class ViewErrorBoundary extends Component<
  { children: ReactNode; view: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error(`[view] ${this.props.view} crashed:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <section className="view-placeholder">
          <p className="view-placeholder-blurb">
            {this.state.error.message || String(this.state.error)}
          </p>
          <p className="view-placeholder-blurb">
            The rest of the app is still usable — switch to another view from the
            sidebar. Details are in the console.
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}


export {
  NavRail,
  RAIL_EXPANDED_KEY,
  ViewErrorBoundary,
  ViewHeader,
  ViewPlaceholder,
  applyTheme,
  readRailExpanded,
  readTheme,
  resolvedMode,
};

export type { Theme, View };
