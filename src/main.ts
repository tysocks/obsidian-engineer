/**
 * main.ts — Engineer plugin entry point.
 *
 * INSTALLATION (no Node.js required)
 * Drop main.js, manifest.json, styles.css into:
 *   YourVault/.obsidian/plugins/obsidian-engineer/
 * Enable in Settings → Community Plugins.
 *
 * BUILDING FROM SOURCE
 * Requires Node.js 18+.
 *   npm install && npm run build
 */

import {
  Plugin, TFile, MarkdownView, Notice, addIcon,
  App, PluginSettingTab, Setting, Editor, Modal,
} from "obsidian";

import { VariableStore } from "./VariableStore";
import { VarsBlockParser } from "./VarsBlockParser";
import { MathEngine } from "./MathEngine";
import { EngSheetView, ENGSHEET_VIEW_TYPE, ENGSHEET_EXTENSION } from "./EngSheetView";
import { VariablePanel, VARIABLE_PANEL_VIEW_TYPE } from "./VariablePanel";
import { PythonEngine } from "./PythonEngine";

interface EngineerPluginSettings {
  autosaveIntervalSeconds: number;
  defaultSigFigs: number;
  showUnitsInMath: boolean;
  parseOnStartup: boolean;
  panelShowActiveNoteSection: boolean;
  panelShowLocalSection: boolean;
  panelShowFolderSection: boolean;
  panelShowParentFolderSection: boolean;
  panelShowTagSection: boolean;
  panelShowGlobalSection: boolean;
  mathCalcColor: string;
  mathErrorColor: string;
  pythonRunOnParseEnabled: boolean;
  pythonShowExportTable: boolean;
}

const DEFAULT_SETTINGS: EngineerPluginSettings = {
  autosaveIntervalSeconds: 150,
  defaultSigFigs: 4,
  showUnitsInMath: true,
  parseOnStartup: true,
  mathCalcColor: "teal",
  mathErrorColor: "red",
  pythonRunOnParseEnabled: true,
  pythonShowExportTable: true,
  panelShowActiveNoteSection: true,
  panelShowLocalSection: true,
  panelShowFolderSection: true,
  panelShowParentFolderSection: true,
  panelShowTagSection: true,
  panelShowGlobalSection: true,
};

export default class EngineerPlugin extends Plugin {
  settings!: EngineerPluginSettings;
  store!: VariableStore;
  varsParser!: VarsBlockParser;
  mathEngine!: MathEngine;
  pythonEngine!: PythonEngine;
  private autosaveInterval?: ReturnType<typeof setInterval>;

  async onload(): Promise<void> {
    console.log("[Engineer] Loading plugin v" + this.manifest.version);

    await this.loadSettings();

    this.store = new VariableStore(this);
    await this.store.load();

    this.varsParser = new VarsBlockParser(this.app, this.store);
    this.mathEngine = new MathEngine(this, this.store);
    this.mathEngine.calcColor = this.settings.mathCalcColor;
    this.mathEngine.errColor  = this.settings.mathErrorColor;
    this.mathEngine.register();

    this.pythonEngine = new PythonEngine(this.store);
    this.pythonEngine.runOnParseEnabled = this.settings.pythonRunOnParseEnabled;
    this.pythonEngine.showExportTable   = this.settings.pythonShowExportTable;
    this.registerMarkdownCodeBlockProcessor(
      "python",
      (source, el, ctx) => this.pythonEngine.render(source, el, ctx)
    );

    // Register .engsheet file type and view
    this.registerView(
      ENGSHEET_VIEW_TYPE,
      (leaf) => new EngSheetView(leaf, this.store, tagResolver)
    );
    this.registerExtensions([ENGSHEET_EXTENSION], ENGSHEET_VIEW_TYPE);

    // Command: create a new .engsheet file
    this.addCommand({
      id: "new-engsheet",
      name: "New engineering spreadsheet (.engsheet)",
      callback: async () => {
        const folder = this.app.fileManager.getNewFileParent("");
        const path = folder.path + (folder.path === "/" ? "" : "/") + "Untitled.engsheet";
        const file = await this.app.vault.create(path, JSON.stringify({
          version: 1,
          sheets: [{ name: "Sheet1", cells: {}, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, numRows: 30, numCols: 12 }],
          meta: { exports: [], exportNames: {} }
        }, null, 2));
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      },
    });

    const tagResolver = (filePath: string): string[] => {
      const cache = this.app.metadataCache.getCache(filePath);
      if (!cache) return [];

      // Standard Obsidian tags: tags: [structural] in frontmatter and #inline tags
      const fmTags: string[] = cache.frontmatter?.tags
        ? (Array.isArray(cache.frontmatter.tags) ? cache.frontmatter.tags : [cache.frontmatter.tags])
        : [];
      const inlineTags = (cache.tags ?? []).map((t) => t.tag.replace(/^#/, ""));

      // Frontmatter properties as virtual "key:value" tags.
      // This lets you scope variables to files with e.g. `project: pr1`
      // in frontmatter using `tag:project:pr1` in the ---vars block.
      const fmProps: string[] = [];
      const SKIP_KEYS = new Set(["tags", "aliases", "cssclass", "cssClasses", "position"]);
      if (cache.frontmatter) {
        for (const [k, v] of Object.entries(cache.frontmatter)) {
          if (SKIP_KEYS.has(k)) continue;
          if (typeof v === "string" || typeof v === "number") {
            fmProps.push(`${k}:${v}`);
          }
        }
      }

      return [...new Set([...fmTags, ...inlineTags, ...fmProps])];
    };

    // Share the resolver with both the math engine and vars parser
    // so tag-scoped variables are correctly resolved everywhere.
    this.mathEngine.tagResolver = tagResolver;
    this.varsParser.tagResolver = tagResolver;
    this.pythonEngine.tagResolver = tagResolver;

    const getPanelConfig = () => ({
      showActiveNoteSection: this.settings.panelShowActiveNoteSection,
      showLocalSection: this.settings.panelShowLocalSection,
      showFolderSection: this.settings.panelShowFolderSection,
      showParentFolderSection: this.settings.panelShowParentFolderSection,
      showTagSection: this.settings.panelShowTagSection,
      showGlobalSection: this.settings.panelShowGlobalSection,
    });

    this.registerView(
      VARIABLE_PANEL_VIEW_TYPE,
      (leaf) => new VariablePanel(leaf, this.store, tagResolver, getPanelConfig)
    );

    // {x} icon — braces with variable cross. addIcon wraps content in <svg viewBox="0 0 100 100">
    // so pass inner <g> scaled from the 24×24 design coords (scale = 100/24 ≈ 4.167).
    addIcon("engineer-var",
      `<g transform="scale(4.167)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/>
        <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>
        <line x1="10" y1="9" x2="14" y2="15"/>
        <line x1="14" y1="9" x2="10" y2="15"/>
      </g>`
    );
    this.addRibbonIcon("engineer-var", "Open Variable Store", () => this.activateVariablePanel());
    this.addRibbonIcon("table", "New engineering spreadsheet", () => {
      this.app.commands.executeCommandById("obsidian-engineer:new-engsheet");
    });

    // Re-parse and re-cache when any markdown file is saved
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const content = await this.app.vault.read(file);
        // Keep the math engine's source cache fresh for inline substitution
        this.mathEngine.cacheFileSource(file.path, content);
        if (content.includes("---vars")) this.varsParser.parseAndLoad(content, file.path);
        if (this.settings.pythonRunOnParseEnabled && content.includes("```python"))
          this.pythonEngine.runOnParseBlocks(content, file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.store.clearFromSource(file.path);
          this.mathEngine.fileSourceCache.delete(file.path);
        }
      })
    );

    // Right-click in editor → "Insert variable definition"
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor: Editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        menu.addItem((item) =>
          item
            .setTitle("Insert variable definition")
            .setIcon("plus-square")
            .onClick(() => new InsertVarModal(this.app, editor).open())
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("engineer:refresh-all" as never, async () => {
        await this.parseAllFiles();
        new Notice("Engineer: All variable blocks refreshed.");
      })
    );

    this.addCommand({
      id: "open-variable-store",
      name: "Open Variable Store",
      callback: () => this.activateVariablePanel(),
    });

    this.addCommand({
      id: "refresh-all-vars",
      name: "Parse all variable blocks",
      callback: async () => {
        await this.parseAllFiles();
        new Notice("Engineer: Variable blocks refreshed.");
      },
    });

    this.addCommand({
      id: "recalculate",
      name: "Recalculate current note",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking && view.previewMode) view.previewMode.rerender(false);
        return true;
      },
    });

    this.addSettingTab(new EngineerSettingsTab(this.app, this));

    if (this.settings.parseOnStartup) {
      this.app.workspace.onLayoutReady(() => this.parseAllFiles());
    }

    if (this.settings.autosaveIntervalSeconds > 0) {
      this.autosaveInterval = setInterval(
        () => this.store.save(),
        this.settings.autosaveIntervalSeconds * 1000
      );
    }

    this.app.workspace.onLayoutReady(() => this.restoreVariablePanel());
    console.log("[Engineer] Plugin loaded.");
  }

  async onunload(): Promise<void> {
    await this.store.save();
    if (this.autosaveInterval) clearInterval(this.autosaveInterval);
    console.log("[Engineer] Plugin unloaded.");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async parseAllFiles(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let count = 0;
    const pythonPromises: Promise<void>[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      this.mathEngine.cacheFileSource(file.path, content);
      if (content.includes("---vars")) {
        this.varsParser.parseAndLoad(content, file.path);
        count++;
      }
      if (this.settings.pythonRunOnParseEnabled && content.includes("```python")) {
        pythonPromises.push(this.pythonEngine.runOnParseBlocks(content, file.path));
      }
    }
    if (pythonPromises.length > 0) await Promise.all(pythonPromises);
    console.log(`[Engineer] Parsed ${count} files with variable blocks.`);
  }

  async activateVariablePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VARIABLE_PANEL_VIEW_TYPE);
    if (existing.length > 0) { this.app.workspace.revealLeaf(existing[0]); return; }
    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({ type: VARIABLE_PANEL_VIEW_TYPE });
      this.app.workspace.revealLeaf(rightLeaf);
    }
  }

  restoreVariablePanel(): void {
    const leaves = this.app.workspace.getLeavesOfType(VARIABLE_PANEL_VIEW_TYPE);
    if (leaves.length > 0) this.app.workspace.revealLeaf(leaves[0]);
  }
}

class EngineerSettingsTab extends PluginSettingTab {
  plugin: EngineerPlugin;
  constructor(app: App, plugin: EngineerPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Engineer Plugin Settings" });
    containerEl.createEl("h3", { text: "Variable Store" });

    new Setting(containerEl)
      .setName("Auto-save interval")
      .setDesc("How often (in seconds) the variable store is saved to disk. 0 = on unload only.")
      .addText(text => text.setPlaceholder("150")
        .setValue(String(this.plugin.settings.autosaveIntervalSeconds))
        .onChange(async value => {
          const n = parseInt(value);
          if (!isNaN(n) && n >= 0) {
            this.plugin.settings.autosaveIntervalSeconds = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName("Parse all variable blocks on startup")
      .setDesc("Parse ---vars blocks across the vault when Obsidian opens.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.parseOnStartup)
        .onChange(async value => {
          this.plugin.settings.parseOnStartup = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "Math rendering" });

    new Setting(containerEl)
      .setName("Calculation result color")
      .setDesc("Color for computed values in math blocks. Accepts CSS color names (teal, blue) or hex (#00897B).")
      .addText(text => text.setPlaceholder("teal")
        .setValue(this.plugin.settings.mathCalcColor)
        .onChange(async value => {
          this.plugin.settings.mathCalcColor = value.trim() || "teal";
          await this.plugin.saveSettings();
          this.plugin.mathEngine.calcColor = this.plugin.settings.mathCalcColor;
          this.plugin.mathEngine.rerenderAll();
        }));

    new Setting(containerEl)
      .setName("Error placeholder color")
      .setDesc("Color for unresolved or errored expressions. Accepts CSS color names or hex.")
      .addText(text => text.setPlaceholder("red")
        .setValue(this.plugin.settings.mathErrorColor)
        .onChange(async value => {
          this.plugin.settings.mathErrorColor = value.trim() || "red";
          await this.plugin.saveSettings();
          this.plugin.mathEngine.errColor = this.plugin.settings.mathErrorColor;
          this.plugin.mathEngine.rerenderAll();
        }));

    containerEl.createEl("h3", { text: "Python" });

    new Setting(containerEl)
      .setName("Run #runOnParse blocks automatically")
      .setDesc("When enabled, python blocks containing `# runOnParse` are executed on startup and when the file is saved.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.pythonRunOnParseEnabled)
        .onChange(async value => {
          this.plugin.settings.pythonRunOnParseEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.pythonEngine.runOnParseEnabled = value;
        }));

    new Setting(containerEl)
      .setName("Show \"Exported to store\" table")
      .setDesc("Show the variable summary table below Python output after a successful run.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.pythonShowExportTable)
        .onChange(async value => {
          this.plugin.settings.pythonShowExportTable = value;
          await this.plugin.saveSettings();
          this.plugin.pythonEngine.showExportTable = value;
        }));

    containerEl.createEl("h3", { text: "Variable Panel sections" });
    containerEl.createEl("p", {
      text: "Choose which scope sections appear in the Variable Store sidebar.",
      cls: "setting-item-description",
    });

    const panelToggles: Array<{ name: string; desc: string; key: keyof EngineerPluginSettings }> = [
      { name: "Show Active Note section", desc: "All variables defined by the active file, regardless of their scope.", key: "panelShowActiveNoteSection" },
      { name: "Show File section",   desc: "Variables scoped to the active note only (# file).", key: "panelShowLocalSection" },
      { name: "Show Folder section", desc: "Variables scoped to the active note's folder (# folder or # folder:path).", key: "panelShowFolderSection" },
      { name: "Show Path section",   desc: "Variables scoped to ancestor folders of the active note.", key: "panelShowParentFolderSection" },
      { name: "Show Tag section",    desc: "Variables visible via shared frontmatter tags (# tag:tagname).", key: "panelShowTagSection" },
      { name: "Show Global section", desc: "Variables visible to all notes in the vault (default).", key: "panelShowGlobalSection" },
    ];

    for (const { name, desc, key } of panelToggles) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange(async value => {
            (this.plugin.settings[key] as boolean) = value;
            await this.plugin.saveSettings();
            // Rerender any open panels
            for (const leaf of this.app.workspace.getLeavesOfType(VARIABLE_PANEL_VIEW_TYPE)) {
              (leaf.view as VariablePanel).refresh();
            }
          }));
    }

    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Re-parse all variable blocks")
      .setDesc("Manually trigger a full re-parse of all ---vars blocks in the vault.")
      .addButton(btn => btn.setButtonText("Parse now").onClick(async () => {
        await this.plugin.parseAllFiles();
        new Notice("Engineer: All variable blocks parsed.");
      }));

    new Setting(containerEl)
      .setName("Clear variable store")
      .setDesc("Remove all variables. They will be re-loaded on the next parse.")
      .addButton(btn => btn.setButtonText("Clear store").setWarning().onClick(async () => {
        const allKeys = [...new Set(this.plugin.store.getAllEntries().map(e => e.key))];
        for (const key of allKeys) this.plugin.store.delete(key);
        await this.plugin.store.save();
        new Notice("Engineer: Variable store cleared.");
      }));
  }
}

// ─── Insert Variable Modal ────────────────────────────────────────────────────

class InsertVarModal extends Modal {
  private editor: Editor;

  constructor(app: App, editor: Editor) {
    super(app);
    this.editor = editor;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("eng-insert-var-modal");
    contentEl.createEl("h3", { text: "Insert variable definition" });

    const grid = contentEl.createDiv({ cls: "eng-modal-grid" });

    const mkRow = (label: string, placeholder: string, required = false): HTMLInputElement => {
      const row = grid.createDiv({ cls: "eng-modal-row" });
      row.createEl("label", { text: label, cls: "eng-modal-label" });
      const input = row.createEl("input", {
        cls: "eng-modal-input",
        attr: { type: "text", placeholder },
      }) as HTMLInputElement;
      if (required) input.required = true;
      return input;
    };

    const nameInput  = mkRow("Name",          "E",           true);
    const valueInput = mkRow("Value",         "200e9",       true);
    const unitInput  = mkRow("Unit",          "Pa");

    // Scope dropdown
    const scopeRow = grid.createDiv({ cls: "eng-modal-row" });
    scopeRow.createEl("label", { text: "Scope", cls: "eng-modal-label" });
    const scopeSelect = scopeRow.createEl("select", { cls: "eng-modal-input" }) as HTMLSelectElement;
    [
      ["global",  "Global (default — visible everywhere)"],
      ["folder",  "Folder (same folder)"],
      ["file",    "File (this note only)"],
      ["tag",     "Tag (shared tag)"],
    ].forEach(([val, text]) => {
      const opt = scopeSelect.createEl("option", { value: val, text });
      if (val === "global") opt.selected = true;
    });

    // Dynamic extra input: folder path or tag name
    const extraRow = grid.createDiv({ cls: "eng-modal-row eng-modal-extra-row" });
    extraRow.style.display = "none";
    const extraLabel = extraRow.createEl("label", { cls: "eng-modal-label" });
    const extraInput = extraRow.createEl("input", {
      cls: "eng-modal-input",
      attr: { type: "text" },
    }) as HTMLInputElement;

    const updateExtraRow = () => {
      const scope = scopeSelect.value;
      if (scope === "folder") {
        extraLabel.textContent = "Path (optional)";
        (extraInput as HTMLInputElement).placeholder = "projects/bridge";
        extraRow.style.display = "";
      } else if (scope === "tag") {
        extraLabel.textContent = "Tag name";
        (extraInput as HTMLInputElement).placeholder = "structural";
        extraRow.style.display = "";
      } else {
        extraRow.style.display = "none";
        extraInput.value = "";
      }
    };
    scopeSelect.onchange = updateExtraRow;

    const footer = contentEl.createDiv({ cls: "eng-modal-footer" });
    const insertBtn = footer.createEl("button", { text: "Insert", cls: "mod-cta" });
    const cancelBtn = footer.createEl("button", { text: "Cancel" });

    cancelBtn.onclick = () => this.close();
    insertBtn.onclick = () => {
      const scope = scopeSelect.value;
      const extra = extraInput.value.trim();
      let resolvedScope = scope;
      if (scope === "folder" && extra) resolvedScope = `folder:${extra}`;
      else if (scope === "tag" && extra) resolvedScope = `tag:${extra}`;
      else if (scope === "tag") resolvedScope = "tag:";
      this.insert(nameInput.value.trim(), valueInput.value.trim(), unitInput.value.trim(), resolvedScope);
    };

    // Allow Enter to submit
    contentEl.onkeydown = (e) => { if (e.key === "Enter") insertBtn.click(); };
    setTimeout(() => nameInput.focus(), 50);
  }

  private insert(name: string, value: string, unit: string, scope: string): void {
    if (!name || !value) return;

    // Build comment: unit and/or scope
    const parts = [unit, scope !== "global" ? scope : ""].filter(Boolean);
    const comment = parts.length ? `  # ${parts.join(", ")}` : "";
    const line = `${name}: ${value}${comment}`;

    const editor = this.editor;
    const content = editor.getValue();
    const cursor = editor.getCursor();

    // Find whether cursor is already inside a ---vars block
    const lines = content.split("\n");
    let blockStart = -1, blockEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimEnd() === "---vars") { blockStart = i; continue; }
      if (blockStart >= 0 && blockEnd < 0 && lines[i].trimEnd() === "---") { blockEnd = i; break; }
    }

    const cursorInBlock = blockStart >= 0 && blockEnd >= 0 &&
      cursor.line > blockStart && cursor.line < blockEnd;

    if (cursorInBlock) {
      // Insert at cursor line inside the block
      editor.replaceRange(line + "\n", { line: cursor.line, ch: 0 });
    } else if (blockStart >= 0 && blockEnd >= 0) {
      // Append before the closing --- of the first block
      editor.replaceRange(line + "\n", { line: blockEnd, ch: 0 });
    } else {
      // No block exists — insert a new one at the cursor
      editor.replaceRange(`\n---vars\n${line}\n---\n`, cursor);
    }

    this.close();
  }

  onClose(): void { this.contentEl.empty(); }
}
