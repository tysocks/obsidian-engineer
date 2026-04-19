/**
 * PythonEngine — runs `python` code fences via Pyodide (WASM).
 *
 * SYNTAX
 * ──────
 * ```python
 * # export: delta, sigma_max
 * import numpy as np
 *
 * # Store variables are automatically injected as Python globals.
 * delta = F * L**3 / (48 * E * I)
 * sigma_max = M * c / I
 *
 * print(f"δ = {delta:.4f} m")
 * print(f"σ_max = {sigma_max:.2e} Pa")
 * ```
 *
 * DIRECTIVES
 * ──────────
 * # export: var1, var2   — write named variables back to Variable Store after run
 *
 * STORE INTEGRATION
 * ─────────────────
 * All variables visible to the current file are injected before execution.
 * After execution, variables listed in `# export:` are read from Python
 * globals and written to the store with global visibility.
 *
 * PYODIDE
 * ───────
 * Loaded once from CDN on first use. Shared across all code fences.
 * Scientific packages (numpy, scipy) are available via micropip.
 */

import { MarkdownPostProcessorContext } from "obsidian";
import { VariableStore } from "./VariableStore";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PyodideInterface {
  runPythonAsync(code: string): Promise<unknown>;
  globals: {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  };
  setStdout(opts: { batched: (msg: string) => void }): void;
  setStderr(opts: { batched: (msg: string) => void }): void;
  version: string;
}

declare global {
  interface Window {
    loadPyodide?: (opts: Record<string, unknown>) => Promise<PyodideInterface>;
    __engineerPyodide?: Promise<PyodideInterface>;
  }
}

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js";
const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/";

// ─── Pyodide loader ───────────────────────────────────────────────────────────

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Don't add the script twice
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script from CDN. Check internet connection.`));
    document.head.appendChild(script);
  });
}

function getPyodide(): Promise<PyodideInterface> {
  if (window.__engineerPyodide) return window.__engineerPyodide;

  // Hide the Node.js `process` global before loading Pyodide. Pyodide ≥ 0.26
  // checks for `process` to detect Node.js/Electron and then tries to import
  // `node:url` as an ES module, which fails in Obsidian's renderer process.
  const savedProcess = (globalThis as any).process;

  window.__engineerPyodide = (async () => {
    try {
      (globalThis as any).process = undefined;
      await loadScript(PYODIDE_CDN);
      if (!window.loadPyodide) throw new Error("loadPyodide not found after script load");
      return await window.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    } finally {
      (globalThis as any).process = savedProcess;
    }
  })().catch(err => {
    delete window.__engineerPyodide; // clear so next Run attempt retries cleanly
    throw err;
  });

  return window.__engineerPyodide;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class PythonEngine {
  private store: VariableStore;

  constructor(store: VariableStore) {
    this.store = store;
  }

  render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const container = el.createDiv({ cls: "eng-python-container" });

    // ── Toolbar ──
    const toolbar = container.createDiv({ cls: "eng-python-toolbar" });
    const runBtn  = toolbar.createEl("button", { cls: "eng-python-run-btn", text: "▶ Run" });
    toolbar.createSpan({ cls: "eng-python-label", text: "Python · Pyodide" });

    // ── Code display ──
    const pre  = container.createEl("pre",  { cls: "eng-python-pre" });
    const code = pre.createEl("code", { cls: "eng-python-code", text: source });

    // ── Output area (hidden until run) ──
    const outputWrap = container.createDiv({ cls: "eng-python-output-wrap" });
    outputWrap.style.display = "none";

    const outputLabel  = outputWrap.createDiv({ cls: "eng-python-output-label", text: "Output" });
    const outputPre    = outputWrap.createEl("pre", { cls: "eng-python-output" });
    const exportTable  = outputWrap.createDiv({ cls: "eng-python-export-table" });

    runBtn.onclick = () => this.run(source, ctx.sourcePath, runBtn, outputWrap, outputPre, exportTable);
  }

  private async run(
    source: string,
    sourcePath: string,
    runBtn: HTMLButtonElement,
    outputWrap: HTMLElement,
    outputPre: HTMLElement,
    exportTable: HTMLElement
  ): Promise<void> {
    runBtn.disabled = true;
    runBtn.textContent = "⏳ Running…";
    outputWrap.style.display = "";
    outputPre.textContent = "Loading Python runtime…";
    exportTable.empty();

    let pyodide: PyodideInterface;
    try {
      pyodide = await getPyodide();
    } catch (err) {
      outputPre.textContent = `Error: ${String(err)}`;
      outputPre.addClass("eng-python-error");
      runBtn.disabled = false;
      runBtn.textContent = "▶ Run";
      return;
    }

    // Inject visible store variables as Python globals
    const allVars = this.store.getAll(sourcePath);
    for (const [key, val] of Object.entries(allVars)) {
      try {
        if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
          pyodide.globals.set(key, val);
        }
      } catch { /* skip non-serializable */ }
    }

    // Capture stdout / stderr
    const lines: string[] = [];
    pyodide.setStdout({ batched: (msg) => lines.push(msg) });
    pyodide.setStderr({ batched: (msg) => lines.push(`[stderr] ${msg}`) });

    try {
      await pyodide.runPythonAsync(source);
    } catch (err) {
      outputPre.textContent = lines.join("\n") + (lines.length ? "\n" : "") + String(err);
      outputPre.addClass("eng-python-error");
      runBtn.disabled = false;
      runBtn.textContent = "▶ Run";
      return;
    }

    outputPre.textContent = lines.join("\n") || "(no output)";
    outputPre.removeClass("eng-python-error");

    // Handle # export: directive
    const exportMatch = source.match(/^#\s*export:\s*(.+)$/m);
    if (exportMatch) {
      const names = exportMatch[1].split(",").map(s => s.trim()).filter(Boolean);
      const exported: { name: string; value: unknown }[] = [];

      for (const name of names) {
        try {
          const val = pyodide.globals.get(name);
          if (val !== undefined) {
            const primitive = typeof val === "number" || typeof val === "string" || typeof val === "boolean"
              ? val
              : Number(val);
            this.store.set(name, primitive, undefined, sourcePath, "python", "global");
            exported.push({ name, value: primitive });
          }
        } catch { /* skip */ }
      }

      if (exported.length > 0) {
        this.renderExportTable(exportTable, exported);
      }
    }

    runBtn.disabled = false;
    runBtn.textContent = "▶ Run";
  }

  private renderExportTable(el: HTMLElement, exports: { name: string; value: unknown }[]): void {
    el.empty();
    const label = el.createDiv({ cls: "eng-python-export-label", text: "Exported to store" });
    const table = el.createEl("table", { cls: "eng-python-vars-table" });
    for (const { name, value } of exports) {
      const tr = table.createEl("tr");
      tr.createEl("td", { cls: "eng-python-var-name", text: name });
      tr.createEl("td", { cls: "eng-python-var-value", text: formatPyValue(value) });
    }
  }
}

function formatPyValue(v: unknown): string {
  if (typeof v === "number") {
    if (!isFinite(v)) return v > 0 ? "∞" : "-∞";
    const abs = Math.abs(v);
    if (abs >= 1e6 || (abs < 1e-3 && v !== 0)) return v.toExponential(4);
    return parseFloat(v.toPrecision(6)).toString();
  }
  return String(v);
}
