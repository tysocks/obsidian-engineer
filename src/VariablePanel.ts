import {
  ItemView,
  WorkspaceLeaf,
  setIcon,
  TFile,
  MarkdownView,
  FileView,
  Notice,
} from "obsidian";
import { VariableStore, VariableEntry, VariableVisibility } from "./VariableStore";
import {
  VariableReferenceGraph,
  renderVariableReferenceGraph,
} from "./VariableReferenceGraphView";

export const VARIABLE_PANEL_VIEW_TYPE = "engineer-variable-panel";

type TagResolver = (filePath: string) => string[];

export interface PanelConfig {
  showActiveNoteSection: boolean;
  showLocalSection: boolean;
  showFolderSection: boolean;
  showParentFolderSection: boolean;
  showTagSection: boolean;
  showGlobalSection: boolean;
}

export class VariablePanel extends ItemView {
  private store: VariableStore;
  private searchTerm = "";
  private activeFilePath: string | null = null;
  private storeListener: (key: string, entry: VariableEntry | null) => void;
  private tagResolver?: TagResolver;
  private getConfig: () => PanelConfig;
  private isGraphEnabled: () => boolean;
  private activeNoteEntries: Array<{ key: string; entry: VariableEntry }> = [];
  private graphVisible = false;
  private graphSourcePath: string | null = null;
  private activeGraph: VariableReferenceGraph | null = null;
  private graphCleanup: (() => void) | null = null;
  private splitterCleanup: (() => void) | null = null;
  private splitRatio = 0.5;

  constructor(
    leaf: WorkspaceLeaf,
    store: VariableStore,
    tagResolver?: TagResolver,
    getConfig?: () => PanelConfig,
    isGraphEnabled?: () => boolean
  ) {
    super(leaf);
    this.store = store;
    this.tagResolver = tagResolver;
    this.getConfig = getConfig ?? (() => ({
      showActiveNoteSection: true,
      showLocalSection: true,
      showFolderSection: true,
      showParentFolderSection: true,
      showTagSection: true,
      showGlobalSection: true,
    }));
    this.isGraphEnabled = isGraphEnabled ?? (() => true);
    this.storeListener = () => this.render();
    this.store.on("change", this.storeListener);
  }

  getViewType(): string { return VARIABLE_PANEL_VIEW_TYPE; }
  getDisplayText(): string { return "Variable Store"; }
  getIcon(): string { return "engineer-var"; }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(FileView);
        const path = view?.file?.path;
        // Keep last valid note selection when non-file leaves (like this panel)
        // become active. Context only changes when the user selects another file.
        if (!path) return;
        if (path === this.activeFilePath) return;
        this.activeFilePath = path;
        this.render();
      })
    );
    // Prefer workspace active file to preserve note context when opening panel.
    this.activeFilePath = this.app.workspace.getActiveFile()?.path ?? this.activeFilePath ?? null;
    this.render();
  }

  async onClose(): Promise<void> {
    this.store.off("change", this.storeListener);
    this.graphCleanup?.();
    this.graphCleanup = null;
    this.splitterCleanup?.();
    this.splitterCleanup = null;
  }

  /** Called externally (e.g. from settings tab) to force a re-render. */
  refresh(): void { this.render(); }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    this.graphCleanup?.();
    this.graphCleanup = null;
    this.splitterCleanup?.();
    this.splitterCleanup = null;
    container.empty();
    container.addClass("eng-variable-panel");
    if (!this.isGraphEnabled()) {
      this.graphVisible = false;
      this.activeGraph = null;
      this.graphSourcePath = null;
    }

    this.renderHeader(container);
    this.renderContextBanner(container);
    this.renderSearch(container);
    const main = container.createDiv({ cls: "eng-panel-main" });
    const listPane = main.createDiv({
      cls: `eng-panel-list${this.graphVisible && this.activeGraph ? " eng-panel-list-split" : ""}`,
    });

    const cfg = this.getConfig();
    const activePath = this.activeFilePath ?? undefined;
    const activeFolder = activePath
      ? (activePath.includes("/") ? activePath.substring(0, activePath.lastIndexOf("/")) : "")
      : null;

    const all = this.store.getAllEntries();

    // Orphaned — source file deleted (always shown, no setting)
    const orphaned = all.filter(({ entry }) =>
      entry.source !== "user-override" && !this.fileExists(entry.source)
    );

    // User overrides (always shown)
    const overrides = all.filter(({ entry }) => entry.source === "user-override");

    // Scoped groups — only entries visible from the active file
    const visible = all.filter(({ entry }) =>
      this.store.isVisibleTo(entry, activePath, this.tagResolver)
    );

    // Active Note: ALL entries defined by the active file, regardless of scope
    const activeNoteEntries = activePath
      ? all.filter(({ entry }) => entry.source === activePath && this.fileExists(entry.source))
      : [];
    this.activeNoteEntries = activeNoteEntries;

    // Local: visibility=file AND source is the active file
    const localEntries = visible.filter(({ entry }) =>
      entry.visibility === "file" && entry.source === activePath
    );

    // Folder (same level): visibility=folder AND scopeFolder === activeFolder
    const folderEntries = visible.filter(({ entry }) => {
      if (entry.visibility !== "folder") return false;
      const sf = this.store.getScopeFolder(entry);
      return activeFolder !== null && sf === activeFolder;
    });

    // Parent folders: visibility=folder AND activeFolder starts with scopeFolder+"/"
    const parentFolderEntries = visible.filter(({ entry }) => {
      if (entry.visibility !== "folder") return false;
      const sf = this.store.getScopeFolder(entry);
      return activeFolder !== null && sf !== activeFolder && activeFolder.startsWith(sf + "/");
    });

    // Tag-scoped
    const tagEntries = visible.filter(({ entry }) => entry.visibility === "tag");

    // Global (non-override, non-scoped)
    const globalEntries = visible.filter(({ entry }) =>
      entry.visibility === "global" &&
      entry.source !== "user-override" &&
      this.fileExists(entry.source)
    );

    // Apply search filter
    const applySearch = (items: typeof all) =>
      this.searchTerm
        ? items.filter(({ key, entry }) =>
            key.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
            String(entry.value).toLowerCase().includes(this.searchTerm.toLowerCase())
          )
        : items;

    const totalVisible = visible.length;
    if (totalVisible === 0 && orphaned.length === 0 && overrides.length === 0) {
      listPane.createDiv({
        cls: "eng-empty-state",
        text: all.length === 0
          ? "No variables defined yet.\nAdd a ---vars block to any note."
          : "No variables visible from the active note.",
      });
      if (this.graphVisible && this.activeGraph) {
        this.renderEmbeddedGraph(main, listPane, this.activeGraph);
      }
      this.renderFooter(container, visible);
      return;
    }

    if (applySearch(orphaned).length > 0) {
      this.renderSection(listPane, "⚠ Orphaned", applySearch(orphaned), "eng-section-orphan", true);
    }
    if (applySearch(overrides).length > 0) {
      this.renderSection(listPane, "✏ User overrides", applySearch(overrides), "eng-section-override", true);
    }
    if (cfg.showActiveNoteSection && applySearch(activeNoteEntries).length > 0) {
      this.renderSection(listPane, "📝 Active Note", applySearch(activeNoteEntries), "eng-section-active-note", false);
    }
    if (cfg.showLocalSection && applySearch(localEntries).length > 0) {
      this.renderSection(listPane, "📄 File", applySearch(localEntries), "eng-section-file", false);
    }
    if (cfg.showFolderSection && applySearch(folderEntries).length > 0) {
      const folderName = activeFolder ? (activeFolder.split("/").pop() ?? activeFolder) : "Folder";
      this.renderSection(listPane, `📁 Folder · ${folderName}`, applySearch(folderEntries), "eng-section-folder", false);
    }
    if (cfg.showParentFolderSection && applySearch(parentFolderEntries).length > 0) {
      this.renderSectionByFolder(listPane, applySearch(parentFolderEntries));
    }
    if (cfg.showTagSection && applySearch(tagEntries).length > 0) {
      this.renderSectionByTag(listPane, applySearch(tagEntries));
    }
    if (cfg.showGlobalSection && applySearch(globalEntries).length > 0) {
      this.renderSectionByFile(listPane, "🌐 Global", applySearch(globalEntries), "eng-section-global");
    }

    if (this.graphVisible && this.activeGraph) {
      this.renderEmbeddedGraph(main, listPane, this.activeGraph);
    }

    this.renderFooter(container, visible);
  }

  // ─── Section renderers ─────────────────────────────────────────────────────

  /** Flat list section (local, folder, overrides, orphaned). */
  private renderSection(
    container: HTMLElement,
    label: string,
    items: Array<{ key: string; entry: VariableEntry }>,
    cls: string,
    deletable: boolean
  ): void {
    const section = container.createDiv({ cls: `eng-scope-section ${cls}`.trim() });
    const hdr = section.createDiv({ cls: "eng-section-header" });
    const chevron = hdr.createSpan({ cls: "eng-chevron", text: "▾" });
    hdr.createSpan({ cls: "eng-section-label", text: label });
    hdr.createSpan({ cls: "eng-group-count", text: ` (${items.length})` });

    const list = section.createDiv({ cls: "eng-var-list" });
    for (const { key, entry } of items) {
      this.renderVariableRow(list, key, entry, deletable);
    }
    this.makeCollapsible(chevron, list);
  }

  /** Global vars grouped by source file. */
  private renderSectionByFile(
    container: HTMLElement,
    label: string,
    items: Array<{ key: string; entry: VariableEntry }>,
    cls: string
  ): void {
    const section = container.createDiv({ cls: `eng-scope-section ${cls}`.trim() });
    const hdr = section.createDiv({ cls: "eng-section-header" });
    const chevron = hdr.createSpan({ cls: "eng-chevron", text: "▾" });
    hdr.createSpan({ cls: "eng-section-label", text: label });
    hdr.createSpan({ cls: "eng-group-count", text: ` (${items.length})` });

    const body = section.createDiv({ cls: "eng-section-body" });

    const byFile = new Map<string, typeof items>();
    for (const item of items) {
      const src = item.entry.source;
      if (!byFile.has(src)) byFile.set(src, []);
      byFile.get(src)!.push(item);
    }

    for (const [src, group] of byFile) {
      const name = src.split("/").pop() ?? src;
      const groupEl = body.createDiv({ cls: "eng-var-group" });
      const gHdr = groupEl.createDiv({ cls: "eng-group-header" });
      const gChevron = gHdr.createSpan({ cls: "eng-chevron", text: "▾" });
      const nameSpan = gHdr.createSpan({ cls: "eng-group-name", text: name });
      nameSpan.title = src;
      nameSpan.onclick = () => this.openFile(src);
      gHdr.style.cursor = "pointer";
      gHdr.createSpan({ cls: "eng-group-count", text: ` (${group.length})` });

      const list = groupEl.createDiv({ cls: "eng-var-list" });
      for (const { key, entry } of group) {
        this.renderVariableRow(list, key, entry, false);
      }
      this.makeCollapsible(gChevron, list);
    }

    this.makeCollapsible(chevron, body);
  }

  /** Parent-folder entries grouped by their scope folder. */
  private renderSectionByFolder(
    container: HTMLElement,
    items: Array<{ key: string; entry: VariableEntry }>
  ): void {
    const section = container.createDiv({ cls: "eng-scope-section eng-section-parent-folder" });
    const hdr = section.createDiv({ cls: "eng-section-header" });
    const chevron = hdr.createSpan({ cls: "eng-chevron", text: "▾" });
    hdr.createSpan({ cls: "eng-section-label", text: "📂 Path" });
    hdr.createSpan({ cls: "eng-group-count", text: ` (${items.length})` });

    const body = section.createDiv({ cls: "eng-section-body" });

    const byFolder = new Map<string, typeof items>();
    for (const item of items) {
      const sf = this.store.getScopeFolder(item.entry);
      if (!byFolder.has(sf)) byFolder.set(sf, []);
      byFolder.get(sf)!.push(item);
    }

    for (const [folder, group] of byFolder) {
      const displayName = folder || "(vault root)";
      const groupEl = body.createDiv({ cls: "eng-var-group" });
      const gHdr = groupEl.createDiv({ cls: "eng-group-header" });
      const gChevron = gHdr.createSpan({ cls: "eng-chevron", text: "▾" });
      gHdr.createSpan({ cls: "eng-group-name", text: `📁 ${displayName}` });
      gHdr.createSpan({ cls: "eng-group-count", text: ` (${group.length})` });

      const list = groupEl.createDiv({ cls: "eng-var-list" });
      for (const { key, entry } of group) {
        this.renderVariableRow(list, key, entry, false);
      }
      this.makeCollapsible(gChevron, list);
    }

    this.makeCollapsible(chevron, body);
  }

  /** Tag-scoped entries grouped by tag name. */
  private renderSectionByTag(
    container: HTMLElement,
    items: Array<{ key: string; entry: VariableEntry }>
  ): void {
    const section = container.createDiv({ cls: "eng-scope-section eng-section-tag" });
    const hdr = section.createDiv({ cls: "eng-section-header" });
    const chevron = hdr.createSpan({ cls: "eng-chevron", text: "▾" });
    hdr.createSpan({ cls: "eng-section-label", text: "🏷 Tag" });
    hdr.createSpan({ cls: "eng-group-count", text: ` (${items.length})` });

    const body = section.createDiv({ cls: "eng-section-body" });

    const byTag = new Map<string, typeof items>();
    for (const item of items) {
      const tag = item.entry.scopeTag ?? "(untagged)";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(item);
    }

    for (const [tag, group] of byTag) {
      const groupEl = body.createDiv({ cls: "eng-var-group" });
      const gHdr = groupEl.createDiv({ cls: "eng-group-header" });
      const gChevron = gHdr.createSpan({ cls: "eng-chevron", text: "▾" });
      gHdr.createSpan({ cls: "eng-group-name", text: `#${tag}` });
      gHdr.createSpan({ cls: "eng-group-count", text: ` (${group.length})` });

      const list = groupEl.createDiv({ cls: "eng-var-list" });
      for (const { key, entry } of group) {
        this.renderVariableRow(list, key, entry, false);
      }
      this.makeCollapsible(gChevron, list);
    }

    this.makeCollapsible(chevron, body);
  }

  // ─── Header / banner / search ───────────────────────────────────────────────

  private renderContextBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: "eng-context-banner" });
    if (this.activeFilePath) {
      const parts = this.activeFilePath.split("/");
      const fileName = parts.pop() ?? this.activeFilePath;
      const folder = parts.join("/") || "(vault root)";

      const fileSpan = banner.createSpan({ cls: "eng-context-chip eng-context-file" });
      fileSpan.createSpan({ text: "📄 " });
      fileSpan.createSpan({ text: fileName, cls: "eng-context-name" });
      fileSpan.title = this.activeFilePath;

      banner.createSpan({ cls: "eng-context-sep", text: "·" });

      const folderSpan = banner.createSpan({ cls: "eng-context-chip eng-context-folder" });
      folderSpan.createSpan({ text: "📁 " });
      folderSpan.createSpan({ text: folder, cls: "eng-context-name" });

      const clearBtn = banner.createEl("button", {
        cls: "eng-icon-btn",
        attr: { title: "Clear active note context" },
      });
      setIcon(clearBtn, "x");
      clearBtn.style.marginLeft = "auto";
      clearBtn.onclick = (e) => {
        e.stopPropagation();
        this.activeFilePath = null;
        this.render();
      };

      // Clicking empty space in the banner clears context.
      banner.onclick = (e) => {
        if (e.target === banner) {
          this.activeFilePath = null;
          this.render();
        }
      };
    } else {
      banner.createSpan({ cls: "eng-context-none", text: "No active note" });
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "eng-panel-header" });
    header.createSpan({ text: "Variable Store", cls: "eng-panel-title" });
    const controls = header.createDiv({ cls: "eng-panel-controls" });

    const refreshBtn = controls.createEl("button", {
      cls: "eng-icon-btn",
      attr: { title: "Re-parse all variable blocks" }
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.onclick = () => {
      refreshBtn.addClass("eng-spinning");
      this.app.workspace.trigger("engineer:refresh-all");
      setTimeout(() => refreshBtn.removeClass("eng-spinning"), 1000);
    };

    const addBtn = controls.createEl("button", {
      cls: "eng-icon-btn",
      attr: { title: "Add a temporary variable" }
    });
    setIcon(addBtn, "plus-circle");
    addBtn.onclick = () => this.showAddDialog(container);

    if (this.isGraphEnabled()) {
      const graphBtn = controls.createEl("button", {
        cls: "eng-icon-btn",
        attr: { title: this.graphVisible ? "Close reference dependency graph" : "Show reference dependency graph" }
      });
      setIcon(graphBtn, "git-branch");
      if (this.graphVisible) graphBtn.addClass("is-active");
      graphBtn.onclick = () => {
        this.toggleReferenceGraph().catch((e) => {
          console.error("[Engineer] Failed to build variable reference graph:", e);
          new Notice("Failed to build reference graph.");
        });
      };
    }

  }

  private renderSearch(container: HTMLElement): void {
    const row = container.createDiv({ cls: "eng-search-row" });
    const input = row.createEl("input", {
      cls: "eng-search-input",
      attr: { type: "text", placeholder: "Search variables…" }
    });
    input.value = this.searchTerm;
    input.oninput = () => { this.searchTerm = input.value; this.render(); };
  }

  // ─── Variable row ──────────────────────────────────────────────────────────

  private renderVariableRow(
    container: HTMLElement,
    key: string,
    entry: VariableEntry,
    isDeletable: boolean
  ): void {
    const row = container.createDiv({ cls: "eng-var-row" });

    const nameEl = row.createSpan({ cls: "eng-var-name", text: key });
    if (entry.source !== "user-override" && this.fileExists(entry.source)) {
      nameEl.onclick = () => this.openFile(entry.source);
      nameEl.title = `From: ${entry.source}`;
    }

    const valueEl = row.createSpan({
      cls: "eng-var-value",
      text: this.formatValueForDisplay(entry.value)
    });
    valueEl.title = "Click to temporarily override this value";
    valueEl.onclick = (e) => { e.stopPropagation(); this.showInlineEditor(row, key, entry); };

    if (entry.unit) {
      row.createSpan({ cls: "eng-unit-badge", text: entry.unit });
    }

    if (entry.block === "math-block") {
      row.createSpan({ cls: "eng-source-badge eng-source-computed", text: "⚡" });
    }

    const showDelete = isDeletable || !this.fileExists(entry.source);
    if (showDelete) {
      const delBtn = row.createEl("button", {
        cls: "eng-delete-btn",
        attr: { title: `Remove "${key}" from the store` }
      });
      setIcon(delBtn, "x");
      delBtn.onclick = (e) => { e.stopPropagation(); this.store.delete(key, entry.source); };
    }
  }

  // ─── Inline editor ─────────────────────────────────────────────────────────

  private showInlineEditor(row: HTMLElement, key: string, entry: VariableEntry): void {
    if (row.querySelector(".eng-inline-editor")) return;

    const editor = row.createEl("input", {
      cls: "eng-inline-editor",
      attr: { type: "text", value: String(entry.value) }
    });

    editor.onkeydown = (e) => {
      if (e.key === "Enter") {
        const raw = editor.value.trim();
        if (!raw) { editor.remove(); return; }
        let parsed: unknown = raw;
        const n = Number(raw);
        if (!isNaN(n) && raw !== "") parsed = n;
        this.store.set(key, parsed, entry.unit, "user-override", "override", "global", "global");
        editor.remove();
      }
      if (e.key === "Escape") editor.remove();
    };

    editor.focus();
    editor.select();
    editor.onclick = (e) => e.stopPropagation();
  }

  // ─── Add dialog ────────────────────────────────────────────────────────────

  private showAddDialog(container: HTMLElement): void {
    container.querySelector(".eng-add-dialog")?.remove();
    const dialog = container.createDiv({ cls: "eng-add-dialog" });

    const nameInput = dialog.createEl("input", {
      cls: "eng-add-input",
      attr: { type: "text", placeholder: "Variable name (e.g. F_wind)" }
    });
    const valueInput = dialog.createEl("input", {
      cls: "eng-add-input",
      attr: { type: "text", placeholder: "Value or expression (e.g. 50e3)" }
    });
    const unitInput = dialog.createEl("input", {
      cls: "eng-add-input",
      attr: { type: "text", placeholder: "Unit (optional, e.g. kN)" }
    });

    const scopeRow = dialog.createDiv({ cls: "eng-add-scope-row" });
    scopeRow.createSpan({ text: "Scope:", cls: "eng-add-scope-label" });
    const scopeSelect = scopeRow.createEl("select", { cls: "eng-scope-dropdown" });
    [
      { value: "global", label: "🌐 Global" },
      { value: "folder", label: "📁 Folder" },
      { value: "tag",    label: "🏷 Tag" },
    ].forEach(({ value, label }) => scopeSelect.createEl("option", { value, text: label }));

    let tagRow: HTMLElement | null = null;
    let tagInput: HTMLInputElement | null = null;

    scopeSelect.onchange = () => {
      if (scopeSelect.value === "tag" && !tagRow) {
        tagRow = dialog.createDiv({ cls: "eng-add-tag-row" });
        tagInput = tagRow.createEl("input", {
          cls: "eng-add-input",
          attr: { type: "text", placeholder: "Tag name (e.g. project/structural)" }
        });
      } else if (scopeSelect.value !== "tag" && tagRow) {
        tagRow.remove(); tagRow = null; tagInput = null;
      }
    };

    const btnRow = dialog.createDiv({ cls: "eng-add-btn-row" });
    const addBtn = btnRow.createEl("button", { text: "Add", cls: "eng-add-confirm" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "eng-add-cancel" });

    addBtn.onclick = () => {
      const name = nameInput.value.trim();
      const rawVal = valueInput.value.trim();
      if (!name || !rawVal) {
        if (!name) nameInput.addClass("eng-input-error");
        if (!rawVal) valueInput.addClass("eng-input-error");
        return;
      }
      const unit = unitInput.value.trim() || undefined;
      const vis = scopeSelect.value as VariableVisibility;
      const tag = tagInput?.value.trim() || undefined;
      let value: unknown = rawVal;
      const n = Number(rawVal);
      if (!isNaN(n) && rawVal !== "") value = n;
      this.store.set(name, value, unit, "user-override", "manual", "global", vis, tag);
      dialog.remove();
    };

    cancelBtn.onclick = () => dialog.remove();
    nameInput.focus();
  }

  // ─── Reference graph ────────────────────────────────────────────────────────

  private async toggleReferenceGraph(): Promise<void> {
    if (!this.isGraphEnabled()) {
      new Notice("Variable dependency graph is disabled in settings.");
      return;
    }
    const sourcePath = this.activeFilePath;
    if (!sourcePath) {
      new Notice("No active note selected.");
      return;
    }
    if (this.graphVisible && this.graphSourcePath === sourcePath) {
      this.graphVisible = false;
      this.graphSourcePath = null;
      this.activeGraph = null;
      this.render();
      return;
    }

    const sourceEntries = this.getSourceEntries(sourcePath);
    const variableNames = [...new Set(sourceEntries.map((v) => v.key))];
    if (variableNames.length === 0) {
      new Notice("No active-note variables to graph.");
      return;
    }
    this.graphSourcePath = sourcePath;
    const graph = await this.buildReferenceGraph(sourcePath, variableNames, sourceEntries);
    if (this.graphSourcePath !== sourcePath) return;
    this.activeGraph = graph;
    this.graphVisible = true;
    this.render();
  }

  private getSourceEntries(sourcePath: string): Array<{ key: string; entry: VariableEntry }> {
    return this.store
      .getAllEntries()
      .filter(({ entry }) => entry.source === sourcePath && this.fileExists(entry.source));
  }

  private renderEmbeddedGraph(container: HTMLElement, listPane: HTMLElement, graph: VariableReferenceGraph): void {
    const splitter = container.createDiv({ cls: "eng-panel-splitter" });
    const pane = container.createDiv({ cls: "eng-panel-graph-pane" });
    this.applySplitRatio(listPane, pane);
    this.splitterCleanup = this.attachSplitter(container, splitter, listPane, pane);

    const header = pane.createDiv({ cls: "eng-ref-graph-view-header" });
    const sourceName = graph.sourcePath.split("/").pop() ?? graph.sourcePath;
    header.createSpan({ text: `Dependency graph: ${sourceName}`, cls: "eng-ref-graph-view-title" });
    const subtitle = header.createSpan({ cls: "eng-ref-graph-view-subtitle" });
    subtitle.textContent = graph.sourcePath;
    const stage = pane.createDiv({ cls: "eng-ref-graph-stage" });
    this.graphCleanup = renderVariableReferenceGraph({
      app: this.app,
      stageEl: stage,
      graph,
      interactionMultiplier: 2,
    });
  }

  private applySplitRatio(listPane: HTMLElement, graphPane: HTMLElement): void {
    const ratio = Math.max(0.2, Math.min(0.8, this.splitRatio));
    this.splitRatio = ratio;
    listPane.style.flexBasis = `${ratio * 100}%`;
    graphPane.style.flexBasis = `${(1 - ratio) * 100}%`;
  }

  private attachSplitter(
    mainPane: HTMLElement,
    splitter: HTMLElement,
    listPane: HTMLElement,
    graphPane: HTMLElement
  ): () => void {
    let dragging = false;
    let pointerId: number | null = null;

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      pointerId = e.pointerId;
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add("is-dragging");
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || pointerId !== e.pointerId) return;
      const rect = mainPane.getBoundingClientRect();
      if (rect.height <= 1) return;
      const y = e.clientY - rect.top;
      this.splitRatio = y / rect.height;
      this.applySplitRatio(listPane, graphPane);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging || pointerId !== e.pointerId) return;
      dragging = false;
      pointerId = null;
      splitter.classList.remove("is-dragging");
      splitter.releasePointerCapture(e.pointerId);
    };

    splitter.addEventListener("pointerdown", onPointerDown);
    splitter.addEventListener("pointermove", onPointerMove);
    splitter.addEventListener("pointerup", onPointerUp);
    splitter.addEventListener("pointercancel", onPointerUp);

    return () => {
      splitter.removeEventListener("pointerdown", onPointerDown);
      splitter.removeEventListener("pointermove", onPointerMove);
      splitter.removeEventListener("pointerup", onPointerUp);
      splitter.removeEventListener("pointercancel", onPointerUp);
    };
  }

  private async buildReferenceGraph(
    sourcePath: string,
    variableNames: string[],
    sourceEntries: Array<{ key: string; entry: VariableEntry }>
  ): Promise<VariableReferenceGraph> {
    const references = new Map<string, Map<string, number>>();
    const variableScopes: Record<string, string> = {};
    for (const name of variableNames) references.set(name, new Map<string, number>());
    for (const { key, entry } of sourceEntries) {
      if (!variableScopes[key]) variableScopes[key] = entry.visibility;
    }

    const mdFiles = this.app.vault.getMarkdownFiles();
    for (const file of mdFiles) {
      const content = await this.app.vault.read(file);
      for (const name of variableNames) {
        const count = this.countMarkdownRefs(content, name);
        if (count > 0) references.get(name)!.set(file.path, count);
      }
    }

    const engFiles = this.app.vault.getFiles().filter((f) => f.extension === "engsheet");
    for (const file of engFiles) {
      const content = await this.app.vault.read(file);
      for (const name of variableNames) {
        const count = this.countEngSheetRefs(content, name);
        if (count > 0) {
          const curr = references.get(name)!.get(file.path) ?? 0;
          references.get(name)!.set(file.path, curr + count);
        }
      }
    }

    return { sourcePath, variables: variableNames, references, variableScopes };
  }

  private countMarkdownRefs(content: string, varName: string): number {
    let count = 0;
    const subst = /<<([^<>]+)>>/g;
    for (const m of content.matchAll(subst)) {
      const inner = m[1];
      if (this.containsSymbol(inner, varName)) count++;
    }
    return count;
  }

  private countEngSheetRefs(content: string, varName: string): number {
    const escaped = this.escapeRegex(varName);
    const storePattern = new RegExp(`STORE\\s*\\(\\s*["']${escaped}["']\\s*\\)`, "gi");
    const formulaPattern = new RegExp(`\\b${escaped}\\b`, "g");
    let count = 0;
    const storeMatches = content.match(storePattern);
    if (storeMatches) count += storeMatches.length;
    try {
      const json = JSON.parse(content) as { sheets?: Array<{ cells?: Record<string, { f?: string | null }> }> };
      for (const sheet of json.sheets ?? []) {
        for (const cell of Object.values(sheet.cells ?? {})) {
          const f = cell?.f;
          if (!f) continue;
          const localMatches = f.match(formulaPattern);
          if (localMatches) count += localMatches.length;
        }
      }
    } catch {
      // ignore malformed .engsheet files
    }
    return count;
  }

  private containsSymbol(expr: string, symbol: string): boolean {
    const re = new RegExp(`\\b${this.escapeRegex(symbol)}\\b`);
    return re.test(expr);
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ─── Footer ────────────────────────────────────────────────────────────────

  private renderFooter(
    container: HTMLElement,
    visibleEntries: Array<{ key: string; entry: VariableEntry }>
  ): void {
    const footer = container.createDiv({ cls: "eng-panel-footer" });
    const total = visibleEntries.length;
    const overrides = visibleEntries.filter(e => e.entry.source === "user-override").length;
    let text = `${total} variable${total !== 1 ? "s" : ""}`;
    if (overrides) text += ` · ${overrides} override${overrides !== 1 ? "s" : ""}`;
    footer.createSpan({ text, cls: "eng-footer-text" });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private makeCollapsible(chevron: HTMLElement, body: HTMLElement): void {
    let collapsed = false;
    chevron.onclick = (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "";
      chevron.textContent = collapsed ? "▸" : "▾";
    };
  }

  private fileExists(sourcePath: string): boolean {
    if (sourcePath === "user-override" || sourcePath === "unknown") return true;
    return this.app.vault.getAbstractFileByPath(sourcePath) instanceof TFile;
  }

  private openFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.app.workspace.openLinkText(path, "", false);
    }
  }

  private formatValueForDisplay(value: unknown): string {
    if (typeof value === "number") {
      if (!isFinite(value)) return value > 0 ? "∞" : "-∞";
      const abs = Math.abs(value);
      if (abs >= 1e6 || (abs < 1e-3 && value !== 0)) return value.toExponential(3);
      return parseFloat(value.toPrecision(6)).toString();
    }
    if (Array.isArray(value)) {
      return `[${value.slice(0, 3).join(", ")}${value.length > 3 ? " …" : ""}]`;
    }
    return String(value);
  }
}
