/**
 * PythonEngine — runs `python` code fences using the system Python installation.
 *
 * SYNTAX
 * ──────
 * ```python
 * # runOnParse          ← auto-runs on startup / file save (if enabled in settings)
 * # export: delta, sigma_max
 * import numpy as np
 *
 * delta = F * L**3 / (48 * E * I)
 * print(f"δ = {delta:.4f} m")
 * ```
 *
 * REQUIREMENTS
 * ────────────
 * Python 3 must be installed and available on PATH.
 *
 * STORE INTEGRATION
 * ─────────────────
 * All variables visible to the current file are injected as Python globals.
 * Variables listed in `# export:` are read after execution and written to
 * the store. Values are exchanged via a temporary JSON file.
 */

import { MarkdownPostProcessorContext } from "obsidian";
import { VariableStore, VariableVisibility } from "./VariableStore";

type TagResolver = (filePath: string) => string[];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFile } = require("child_process") as typeof import("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os       = require("os")   as typeof import("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require("path") as typeof import("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs       = require("fs")   as typeof import("fs");

// ─── Python discovery ─────────────────────────────────────────────────────────

let cachedPython: string | null | undefined = undefined;

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) { (err as any).stderr = stderr; reject(err); }
      else resolve(stdout);
    });
  });
}

async function findPython(): Promise<string> {
  if (cachedPython !== undefined) {
    if (cachedPython === null) throw new Error(
      "Python 3 not found on PATH.\n" +
      "Install Python (python.org) and ensure 'python' or 'python3' is on your system PATH."
    );
    return cachedPython;
  }
  const isWin = process.platform === "win32";
  const candidates = isWin ? ["python", "py", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const out = await execAsync(cmd, ["--version"]);
      if (out.includes("Python 3") || !out.includes("Python 2")) {
        cachedPython = cmd; return cmd;
      }
    } catch { /* try next */ }
  }
  cachedPython = null;
  throw new Error(
    "Python 3 not found on PATH.\n" +
    "Install Python (python.org) and ensure 'python' or 'python3' is on your system PATH."
  );
}

function runScript(python: string, scriptPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(python, [scriptPath], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) { const o = err as any; o.stdout = stdout; o.stderr = stderr; reject(o); }
      else resolve(stdout);
    });
  });
}

// ─── Result type ──────────────────────────────────────────────────────────────

interface RunResult {
  success: boolean;
  stdout: string;
  errorMsg: string;
  exportedRows: { name: string; value: unknown }[];
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class PythonEngine {
  private store: VariableStore;
  tagResolver?: TagResolver;

  /** Honour `# runOnParse` directives. Controlled by plugin settings. */
  runOnParseEnabled = true;
  /** Show the "Exported to store" summary table below the output. */
  showExportTable = true;

  constructor(store: VariableStore) {
    this.store = store;
  }

  // ─── Rendering ───────────────────────────────────────────────────────────────

  render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const container = el.createDiv({ cls: "eng-python-container" });

    const toolbar = container.createDiv({ cls: "eng-python-toolbar" });
    const runBtn  = toolbar.createEl("button", { cls: "eng-python-run-btn", text: "▶ Run" });
    toolbar.createSpan({ cls: "eng-python-label", text: "Python" });

    const pre = container.createEl("pre", { cls: "eng-python-pre" });
    pre.createEl("code", { cls: "eng-python-code", text: source });

    const outputWrap  = container.createDiv({ cls: "eng-python-output-wrap" });
    outputWrap.style.display = "none";
    const outputPre   = outputWrap.createEl("pre", { cls: "eng-python-output" });
    const exportTable = outputWrap.createDiv({ cls: "eng-python-export-table" });

    runBtn.onclick = () =>
      this.executeUI(source, ctx.sourcePath, runBtn, outputWrap, outputPre, exportTable);
  }

  // ─── UI execution ────────────────────────────────────────────────────────────

  private async executeUI(
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
    outputPre.textContent = "";
    outputPre.removeClass("eng-python-error");
    exportTable.empty();

    const result = await this.runCore(source, sourcePath);

    if (result.success) {
      outputPre.textContent = result.stdout || "(no output)";
      if (this.showExportTable && result.exportedRows.length > 0) {
        this.renderExportTable(exportTable, result.exportedRows);
      }
    } else {
      outputPre.textContent = result.errorMsg;
      outputPre.addClass("eng-python-error");
    }

    runBtn.disabled = false;
    runBtn.textContent = "▶ Run";
  }

  // ─── Headless execution (# runOnParse) ───────────────────────────────────────

  /** Scan `content` for python fences with `# runOnParse` and execute them. */
  async runOnParseBlocks(content: string, filePath: string): Promise<void> {
    if (!this.runOnParseEnabled) return;
    const fenceRegex = /```python\r?\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(content)) !== null) {
      const source = m[1];
      if (/^#\s*runOnParse\b/m.test(source)) {
        await this.runCore(source, filePath).catch(e =>
          console.warn(`[Engineer] #runOnParse error in ${filePath}:`, e)
        );
      }
    }
  }

  // ─── Core execution logic ────────────────────────────────────────────────────

  async runCore(source: string, sourcePath: string): Promise<RunResult> {
    let python: string;
    try {
      python = await findPython();
    } catch (err) {
      return { success: false, stdout: "", errorMsg: String(err), exportedRows: [] };
    }

    // Parse # export: or # export(scope): directive
    const exportMatch = source.match(/^#\s*export(?:\(([^)]*)\))?\s*:\s*(.+)$/m);
    const exportNames = exportMatch
      ? exportMatch[2].split(",").map(s => s.trim()).filter(Boolean)
      : [];
    const rawExportScope = exportMatch?.[1]?.trim().toLowerCase() ?? "global";
    let exportVis: VariableVisibility = "global";
    let exportScopeTag: string | undefined;
    if (rawExportScope === "folder") {
      exportVis = "folder";
    } else if (rawExportScope.startsWith("tag:")) {
      exportVis = "tag";
      exportScopeTag = rawExportScope.slice(4);
    }

    // Temp file paths
    const id         = `obsidian_eng_${Date.now()}`;
    const tmpScript  = nodePath.join(os.tmpdir(), `${id}.py`);
    const tmpExports = nodePath.join(os.tmpdir(), `${id}_out.json`);

    // Variable injection preamble
    const storeVars = this.store.getAll(sourcePath, this.tagResolver);
    const preamble = Object.entries(storeVars)
      .filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k))
      .map(([k, v]) => {
        if (typeof v === "string")  return `${k} = ${JSON.stringify(v)}`;
        if (typeof v === "boolean") return `${k} = ${v ? "True" : "False"}`;
        if (typeof v === "number")  return `${k} = ${isFinite(v) ? v : (v > 0 ? "float('inf')" : "float('-inf')")}`;
        if (Array.isArray(v))       return `${k} = ${JSON.stringify(v)}`;
        return null;
      })
      .filter((l): l is string => l !== null)
      .join("\n");

    // Export postamble
    const exportedJsonPath = tmpExports.replace(/\\/g, "\\\\");
    const postamble = exportNames.length > 0
      ? [
          "",
          "# --- engineer: export ---",
          "import json as __eng_json__",
          `__eng_names__ = [${exportNames.map(n => JSON.stringify(n)).join(", ")}]`,
          "__eng_out__ = {}",
          "for __eng_k__ in __eng_names__:",
          "    __eng_v__ = locals().get(__eng_k__, globals().get(__eng_k__))",
          "    if __eng_v__ is not None:",
          "        try: __eng_out__[__eng_k__] = float(__eng_v__)",
          "        except: __eng_out__[__eng_k__] = str(__eng_v__)",
          `with open('${exportedJsonPath}', 'w') as __eng_f__:`,
          "    __eng_json__.dump(__eng_out__, __eng_f__)",
        ].join("\n")
      : "";

    try {
      fs.writeFileSync(tmpScript, [preamble, "", source, postamble].join("\n"), "utf8");
    } catch (err) {
      return { success: false, stdout: "", errorMsg: `Failed to write temp file: ${String(err)}`, exportedRows: [] };
    }

    let stdout = "";
    let success = false;
    let errorMsg = "";

    try {
      stdout = await runScript(python, tmpScript);
      success = true;
    } catch (err: any) {
      const out    = (err.stdout ?? "").trim();
      const errTxt = (err.stderr ?? String(err.message ?? err)).trim();
      errorMsg = [out, errTxt].filter(Boolean).join("\n");
    }

    // Clean up stale exports on success
    if (success) {
      const prevExported = this.store.getAllEntries()
        .filter(e => e.entry.source === sourcePath && e.entry.block === "python")
        .map(e => e.key);
      const nowExported = new Set(exportNames);
      for (const name of prevExported) {
        if (!nowExported.has(name)) this.store.delete(name, sourcePath);
      }
    }

    // Read and write exports
    const exportedRows: { name: string; value: unknown }[] = [];
    if (success && exportNames.length > 0) {
      try {
        const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(tmpExports, "utf8"));
        for (const name of exportNames) {
          const val = raw[name];
          if (val !== undefined && val !== null) {
            const num = Number(val);
            const primitive = isNaN(num) ? String(val) : num;
            this.store.set(name, primitive, undefined, sourcePath, "python", "global", exportVis, exportScopeTag);
            exportedRows.push({ name, value: primitive });
          }
        }
      } catch { /* no exports or parse error */ }
    }

    // Cleanup temp files
    for (const f of [tmpScript, tmpExports]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }

    return { success, stdout: stdout.trim(), errorMsg, exportedRows };
  }

  // ─── Export table ─────────────────────────────────────────────────────────────

  private renderExportTable(el: HTMLElement, rows: { name: string; value: unknown }[]): void {
    el.empty();
    el.createDiv({ cls: "eng-python-export-label", text: "Exported to store" });
    const table = el.createEl("table", { cls: "eng-python-vars-table" });
    for (const { name, value } of rows) {
      const tr = table.createEl("tr");
      tr.createEl("td", { cls: "eng-python-var-name",  text: name });
      tr.createEl("td", { cls: "eng-python-var-value", text: formatVal(value) });
    }
  }
}

function formatVal(v: unknown): string {
  if (typeof v === "number") {
    if (!isFinite(v)) return v > 0 ? "∞" : "-∞";
    const abs = Math.abs(v);
    if (abs >= 1e6 || (abs < 1e-3 && v !== 0)) return v.toExponential(4);
    return parseFloat(v.toPrecision(6)).toString();
  }
  return String(v);
}
