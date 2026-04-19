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
  App, PluginSettingTab, Setting,
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
  panelShowLocalSection: boolean;
  panelShowFolderSection: boolean;
  panelShowParentFolderSection: boolean;
  panelShowTagSection: boolean;
  panelShowGlobalSection: boolean;
}

const DEFAULT_SETTINGS: EngineerPluginSettings = {
  autosaveIntervalSeconds: 30,
  defaultSigFigs: 4,
  showUnitsInMath: true,
  parseOnStartup: true,
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
    this.mathEngine.register();

    this.pythonEngine = new PythonEngine(this.store);
    this.registerMarkdownCodeBlockProcessor(
      "python",
      (source, el, ctx) => this.pythonEngine.render(source, el, ctx)
    );

    // Register .engsheet file type and view
    this.registerView(
      ENGSHEET_VIEW_TYPE,
      (leaf) => new EngSheetView(leaf, this.store)
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
      const fmTags: string[] = cache.frontmatter?.tags
        ? (Array.isArray(cache.frontmatter.tags) ? cache.frontmatter.tags : [cache.frontmatter.tags])
        : [];
      const inlineTags = (cache.tags ?? []).map((t) => t.tag.replace(/^#/, ""));
      return [...new Set([...fmTags, ...inlineTags])];
    };

    const getPanelConfig = () => ({
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

    addIcon("engineer-sigma",
      `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <text y=".9em" font-size="90" font-family="serif">Σ</text>
       </svg>`
    );
    this.addRibbonIcon("engineer-sigma", "Open Variable Store", () => this.activateVariablePanel());

    // Re-parse and re-cache when any markdown file is saved
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const content = await this.app.vault.read(file);
        // Keep the math engine's source cache fresh for inline substitution
        this.mathEngine.cacheFileSource(file.path, content);
        if (content.includes("---vars")) this.varsParser.parseAndLoad(content, file.path);
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
    for (const file of files) {
      const content = await this.app.vault.read(file);
      this.mathEngine.cacheFileSource(file.path, content);
      if (content.includes("---vars")) {
        this.varsParser.parseAndLoad(content, file.path);
        count++;
      }
    }
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
      .addText(text => text.setPlaceholder("30")
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

    containerEl.createEl("h3", { text: "Variable Panel sections" });
    containerEl.createEl("p", {
      text: "Choose which scope sections appear in the Variable Store sidebar.",
      cls: "setting-item-description",
    });

    const panelToggles: Array<{ name: string; desc: string; key: keyof EngineerPluginSettings }> = [
      { name: "This note (local)", desc: "Variables scoped to the active note only.", key: "panelShowLocalSection" },
      { name: "This folder", desc: "Variables scoped to the active note's folder.", key: "panelShowFolderSection" },
      { name: "Parent folders", desc: "Variables scoped to ancestor folders.", key: "panelShowParentFolderSection" },
      { name: "Tagged", desc: "Variables visible via shared frontmatter tags.", key: "panelShowTagSection" },
      { name: "Global", desc: "Variables visible to all notes in the vault.", key: "panelShowGlobalSection" },
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
