import { useEffect, useState } from "react";
import { Apple, Download as DownloadIcon, Monitor, Package } from "lucide-react";
import { isTauri } from "../identity/identity.js";

/**
 * The desktop download page.
 *
 * This view is web-only by intent — when running inside the Tauri desktop
 * shell it instead shows "you're already on the desktop app," because offering
 * a second installer from inside the running installer is noise.
 *
 * The list of available builds comes from the hosted server's
 * /downloads/manifest.json, which is generated at request time from whatever
 * installers are sitting in the container's downloads dir (see
 * relay/cmd/hosted/main.go). Dropping a new dmg/msi/AppImage into that dir is
 * the whole publish flow — no rebuild, no registry.
 */

type Platform = "macos" | "windows" | "linux" | "unknown";

interface DownloadEntry {
  filename: string;
  url: string;
  platform: Platform;
  arch?: string;
  size: number;
  mtime: string;
}

/** Detect the visitor's platform from the UA so we can highlight the right card. */
function detectPlatform(): Platform {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  // Order matters: iPadOS 13+ reports as Mac, but is touch; the simpler check
  // is fine here since we don't ship an iOS build anyway.
  if (/Mac|iPhone|iPad/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "unknown";
}

const PLATFORM_META: Record<Platform, { label: string; Icon: typeof Monitor }> = {
  macos: { label: "macOS", Icon: Apple },
  windows: { label: "Windows", Icon: Monitor },
  linux: { label: "Linux", Icon: Package },
  unknown: { label: "Other", Icon: Package },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function DownloadView() {
  const [entries, setEntries] = useState<DownloadEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const visitorPlatform = detectPlatform();

  useEffect(() => {
    let cancelled = false;
    fetch("/downloads/manifest.json")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DownloadEntry[];
        if (cancelled) return;
        setEntries(json);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isTauri()) {
    return (
      <section className="view-placeholder download-view">
        <p className="view-placeholder-blurb">
          This page lists installers for the zine desktop app — but you're already running it.
        </p>
      </section>
    );
  }

  // Group by platform so the grid reads naturally: macOS / Windows / Linux.
  const byPlatform = new Map<Platform, DownloadEntry[]>();
  for (const e of entries) {
    const arr = byPlatform.get(e.platform) ?? [];
    arr.push(e);
    byPlatform.set(e.platform, arr);
  }
  const platforms = (["macos", "windows", "linux", "unknown"] as Platform[]).filter((p) =>
    byPlatform.has(p),
  );

  return (
    <section className="view-placeholder download-view">
      <p className="view-placeholder-blurb">
        Local-first by design: the desktop app bundles its own relay, so your writing and its
        provenance live on your machine. Point it at additional relays to publish out.
      </p>

      {!loaded ? (
        <p className="download-status">Checking for builds…</p>
      ) : error ? (
        <div className="download-empty">
          <p className="download-status">No builds published yet.</p>
          <p className="download-hint">
            Builds aren't generated in the container — they're produced per-platform and dropped into
            the server's <code>downloads/</code> directory. See{" "}
            <code>apps/client/README.md#release-builds</code>.
          </p>
        </div>
      ) : entries.length === 0 ? (
        <div className="download-empty">
          <p className="download-status">No builds published yet.</p>
          <p className="download-hint">
            Drop a <code>.dmg</code>, <code>.msi</code>, or <code>.AppImage</code> into the
            container's <code>downloads/</code> dir and reload.
          </p>
        </div>
      ) : (
        <div className="download-grid">
          {platforms.map((p) => {
            const { label, Icon } = PLATFORM_META[p];
            const recommended = p === visitorPlatform;
            return (
              <div
                key={p}
                className={"settings-card download-card" + (recommended ? " recommended" : "")}
                data-platform={p}
              >
                <div className="download-card-head">
                  <Icon size={22} strokeWidth={1.75} />
                  <span className="download-card-title">{label}</span>
                  {recommended && <span className="download-card-badge">For your system</span>}
                </div>
                <ul className="download-card-list">
                  {byPlatform.get(p)!.map((e) => (
                    <li key={e.filename} className="download-item">
                      <a className="download-item-link" href={e.url} download>
                        <DownloadIcon size={16} strokeWidth={1.75} />
                        <span className="download-item-name">{e.filename}</span>
                      </a>
                      <span className="download-item-meta">
                        {[e.arch, formatSize(e.size)].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
