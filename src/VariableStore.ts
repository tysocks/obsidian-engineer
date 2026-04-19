/**
 * VariableStore — the central data store for the Engineer plugin.
 *
 * MULTI-ENTRY MODEL
 * -----------------
 * Each variable name maps to an array of entries, one per source file.
 * This allows the same name (e.g. "E") to exist in multiple files with
 * different scopes — a local "E" in fileA and a global "E" in fileB no
 * longer clobber each other.
 *
 * When resolving a variable for a requesting file, getBestEntry() picks
 * the most-specific visible entry using this priority order:
 *   user-override > local > folder > tag > global
 *
 * VISIBILITY SCOPES
 * -----------------
 *   global  — visible to all notes (default)
 *   folder  — visible only to notes in the same folder tree as the source
 *   tag     — visible only to notes sharing a specified frontmatter tag
 *   local   — visible only within the source file itself
 *   block   — ephemeral, never persisted, never returned by getAll()
 *
 * PERSISTENCE
 * -----------
 * Saved to .obsidian/engineer-vars.json as a JSON array. Only user-override
 * entries need to persist — all file-sourced variables are re-parsed on
 * startup. Legacy Record<string,VariableEntry> format is still accepted on
 * load for backward compatibility.
 */

import { Plugin } from "obsidian";

export type VariableVisibility = "global" | "folder" | "tag" | "local" | "block";

export interface VariableEntry {
  value: unknown;
  unit?: string;
  source: string;
  block: string;
  timestamp: number;
  scope: "global" | "local" | "block";
  visibility: VariableVisibility;
  scopeTag?: string;
  scopeFolder?: string;
}

type StoreListener = (key: string, entry: VariableEntry | null) => void;
type TagResolver = (filePath: string) => string[];

/** Shape used when persisting to JSON. */
interface SavedEntry extends VariableEntry { _name: string; }

const SCOPE_PRIORITY: Record<string, number> = {
  local: 4, folder: 3, tag: 2, global: 1, block: 0,
};

export class VariableStore {
  private data: Map<string, VariableEntry[]> = new Map();
  private listeners: StoreListener[] = [];
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const path = `${this.plugin.app.vault.configDir}/engineer-vars.json`;
      if (!(await adapter.exists(path))) return;
      const raw = await adapter.read(path);
      const parsed: unknown = JSON.parse(raw);

      const loadEntry = async (name: string, entry: VariableEntry) => {
        if (entry.source !== "user-override" && entry.source !== "unknown") {
          if (!(await adapter.exists(entry.source))) return;
        }
        this.addEntryToMap(name, entry);
      };

      if (Array.isArray(parsed)) {
        for (const item of parsed as SavedEntry[]) {
          const { _name, ...entry } = item;
          await loadEntry(_name, entry as VariableEntry);
        }
      } else {
        // Legacy: Record<string, VariableEntry>
        for (const [key, entry] of Object.entries(parsed as Record<string, VariableEntry>)) {
          if (entry.scope !== "global") continue;
          await loadEntry(key, entry);
        }
      }
    } catch (e) {
      console.warn("[Engineer] Could not load variable store:", e);
    }
  }

  async save(): Promise<void> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const path = `${this.plugin.app.vault.configDir}/engineer-vars.json`;
      const toSave: SavedEntry[] = [];
      for (const [name, entries] of this.data.entries()) {
        for (const entry of entries) {
          // Only persist user-overrides; file-sourced vars are re-parsed on startup
          if (entry.source === "user-override") {
            toSave.push({ _name: name, ...entry });
          }
        }
      }
      await adapter.write(path, JSON.stringify(toSave, null, 2));
    } catch (e) {
      console.warn("[Engineer] Could not save variable store:", e);
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  get(key: string, requestingFile?: string, tagResolver?: TagResolver): unknown {
    return this.getBestEntry(key, requestingFile, tagResolver)?.value;
  }

  getEntry(key: string, requestingFile?: string, tagResolver?: TagResolver): VariableEntry | undefined {
    return this.getBestEntry(key, requestingFile, tagResolver);
  }

  getAll(
    requestingFile?: string,
    tagResolver?: TagResolver
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of this.data.keys()) {
      const entry = this.getBestEntry(key, requestingFile, tagResolver);
      if (entry !== undefined) result[key] = entry.value;
    }
    return result;
  }

  getAllEntries(): Array<{ key: string; entry: VariableEntry }> {
    const result: Array<{ key: string; entry: VariableEntry }> = [];
    for (const [key, entries] of this.data.entries()) {
      for (const entry of entries) {
        result.push({ key, entry });
      }
    }
    return result;
  }

  has(key: string): boolean {
    return (this.data.get(key)?.length ?? 0) > 0;
  }

  isVisibleTo(
    entry: VariableEntry,
    requestingFile?: string,
    tagResolver?: TagResolver
  ): boolean {
    const vis = entry.visibility ?? "global";
    switch (vis) {
      case "global": return true;
      case "block":  return false;
      case "local":  return requestingFile === entry.source;
      case "folder": {
        if (!requestingFile) return false;
        const reqFolder = requestingFile.includes("/")
          ? requestingFile.substring(0, requestingFile.lastIndexOf("/"))
          : "";
        const srcFolder = entry.scopeFolder ?? (
          entry.source.includes("/")
            ? entry.source.substring(0, entry.source.lastIndexOf("/"))
            : ""
        );
        return reqFolder === srcFolder || reqFolder.startsWith(srcFolder + "/");
      }
      case "tag": {
        if (!requestingFile || !entry.scopeTag || !tagResolver) return false;
        const reqTags = tagResolver(requestingFile);
        const srcTags = tagResolver(entry.source);
        return reqTags.includes(entry.scopeTag) && srcTags.includes(entry.scopeTag);
      }
      default: return true;
    }
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  set(
    key: string,
    value: unknown,
    unit?: string,
    source?: string,
    block?: string,
    scope?: "global" | "local" | "block",
    visibility?: VariableVisibility,
    scopeTag?: string,
    explicitScopeFolder?: string
  ): void {
    const sourcePath = source ?? "unknown";
    const inferredScope = scope ?? this.inferScope(key);
    const inferredVisibility: VariableVisibility =
      visibility ?? (inferredScope === "local" ? "local" : inferredScope === "block" ? "block" : "global");
    const derivedFolder = sourcePath.includes("/")
      ? sourcePath.substring(0, sourcePath.lastIndexOf("/"))
      : "";
    const scopeFolder = explicitScopeFolder ?? derivedFolder;

    const entry: VariableEntry = {
      value, unit,
      source: sourcePath,
      block: block ?? "unknown",
      timestamp: Date.now(),
      scope: inferredScope,
      visibility: inferredVisibility,
      scopeTag,
      scopeFolder,
    };

    this.addEntryToMap(key, entry);
    this.emit(key, entry);
  }

  setBulk(
    vars: Record<string, unknown>,
    source: string,
    block: string,
    visibility: VariableVisibility = "global"
  ): void {
    const scopeFolder = source.includes("/")
      ? source.substring(0, source.lastIndexOf("/"))
      : "";
    for (const [key, value] of Object.entries(vars)) {
      const inferredScope = this.inferScope(key);
      const entry: VariableEntry = {
        value, source, block,
        timestamp: Date.now(),
        scope: inferredScope,
        visibility,
        scopeFolder,
      };
      this.addEntryToMap(key, entry);
    }
    this.emit("*", null);
  }

  /**
   * Delete a specific (key, source) entry. If source is omitted, removes all
   * entries for that key. Immediately persists so deletions survive restart.
   */
  delete(key: string, source?: string): void {
    const entries = this.data.get(key);
    if (!entries) return;

    if (source !== undefined) {
      const filtered = entries.filter(e => e.source !== source);
      if (filtered.length === entries.length) return;
      if (filtered.length === 0) this.data.delete(key);
      else this.data.set(key, filtered);
    } else {
      this.data.delete(key);
    }

    this.emit(key, null);
    this.save().catch(e => console.warn("[Engineer] Failed to persist after delete:", e));
  }

  clearFromSource(sourcePath: string): void {
    let changed = false;
    for (const [key, entries] of this.data.entries()) {
      const filtered = entries.filter(e => e.source !== sourcePath);
      if (filtered.length !== entries.length) {
        changed = true;
        if (filtered.length === 0) this.data.delete(key);
        else this.data.set(key, filtered);
      }
    }
    if (changed) {
      this.emit("*", null);
      this.save().catch(e => console.warn("[Engineer] Failed to save after clearing source:", e));
    }
  }

  clearLocalScope(sourcePath: string): void {
    let changed = false;
    for (const [key, entries] of this.data.entries()) {
      const filtered = entries.filter(e => !(e.scope === "local" && e.source === sourcePath));
      if (filtered.length !== entries.length) {
        changed = true;
        if (filtered.length === 0) this.data.delete(key);
        else this.data.set(key, filtered);
      }
    }
    if (changed) this.emit("*", null);
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  on(event: "change", listener: StoreListener): void {
    this.listeners.push(listener);
  }

  off(event: "change", listener: StoreListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  private emit(key: string, entry: VariableEntry | null): void {
    for (const listener of this.listeners) listener(key, entry);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Returns the effective scope folder for a given entry. */
  getScopeFolder(entry: VariableEntry): string {
    return entry.scopeFolder ?? (
      entry.source.includes("/")
        ? entry.source.substring(0, entry.source.lastIndexOf("/"))
        : ""
    );
  }

  private getBestEntry(
    key: string,
    requestingFile?: string,
    tagResolver?: TagResolver
  ): VariableEntry | undefined {
    const entries = this.data.get(key);
    if (!entries || entries.length === 0) return undefined;

    let best: VariableEntry | undefined;
    let bestPriority = -1;

    for (const entry of entries) {
      if (!this.isVisibleTo(entry, requestingFile, tagResolver)) continue;
      // user-override always wins
      const p = entry.source === "user-override" ? 5 : (SCOPE_PRIORITY[entry.visibility ?? "global"] ?? 1);
      if (p > bestPriority || (p === bestPriority && entry.timestamp > (best?.timestamp ?? 0))) {
        best = entry;
        bestPriority = p;
      }
    }
    return best;
  }

  private addEntryToMap(key: string, entry: VariableEntry): void {
    const entries = this.data.get(key) ?? [];
    const idx = entries.findIndex(e => e.source === entry.source);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    this.data.set(key, entries);
  }

  private inferScope(key: string): "global" | "local" | "block" {
    if (key.startsWith("block.")) return "block";
    if (key.startsWith("local.")) return "local";
    return "global";
  }
}
