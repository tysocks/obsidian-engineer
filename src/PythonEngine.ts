/**
 * PythonEngine — runs `python` code fences using the system Python installation.
 *
 * SYNTAX
 * ──────
 * ```python
 * # export: delta, sigma_max
 * import numpy as np
 *
 * delta = F * L**3 / (48 * E * I)
 * sigma_max = M * c / I
 *
 * print(f"δ = {delta:.4f} m")
 * print(f"σ_max = {sigma_max:.2e} Pa")
 * ```
 *
 * REQUIREMENTS
 * ────────────
 * Python 3 must be installed and available on PATH.
 * Packages (numpy, scipy, etc.) must be installed via pip.
 *
 * STORE INTEGRATION
 * ─────────────────
 * All variables visible to the current file are injected as Python globals.
 * Variables listed in `# export:` are read after execution and written to
 * the store. Values are exchanged via a temporary JSON file — no special
 * Python dependencies required.
 */

import { MarkdownPostProcessorContext } from "obsidian";
import { VariableStore, VariableVisibility } from "./VariableStore";

type TagResolver = (filePath: string) => string[];

// Node.js built-ins — available in Electron's renderer with node integration.
// esbuild marks builtins as external so these are resolved at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFile } = require("child_process") as typeof import("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os  = require("os")   as typeof import("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require("path") as typeof import("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs  = require("fs")   as typeof import("fs");

// ─── Python discovery ─────────────────────────────────────────────────────────

// Cache result across calls. undefined = not yet searched, null = not found.
let cachedPython: string | null | undefined = undefined;

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        (err as any).stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
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
  // On Windows, try "python" first (the Store app redirects if absent),
  // then the universal "py" launcher, then "python3".
  const isWin = process.platform === "win32";
  const candidates = isWin ? ["python", "py", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const out = await execAsync(cmd, ["--version"]);
      if (out.includes("Python 3") || out.includes("Python 2") === false) {
        cachedPython = cmd;
        return cmd;
      }
    } catch { /* try next */ }
  }
  cachedPython = null;
  throw new Error(
    "Python 3 not found on PATH.\n" +
    "Install Python (python.org) and ensure 'python' or 'python3' is on your system PATH."
  );
}

// ─── Runner ───────────────────────────────────────────────────────────────────

function runScript(python: string, scriptPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(python, [scriptPath], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const out = (err as any);
        out.stdout = stdout;
        out.stderr = stderr;
        reject(out);
      } else {
        resolve(stdout);
      }
    });
  });
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class PythonEngine {
  private store: VariableStore;
  tagResolver?: TagResolver;

  constructor(store: VariableStore) {
    this.store = store;
  }

  render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const container = el.createDiv({ cls: "eng-python-container" });

    const toolbar = container.createDiv({ cls: "eng-python-toolbar" });
    const runBtn  = toolbar.createEl("button", { cls: "eng-python-run-btn", text: "▶ Run" });
    toolbar.createSpan({ cls: "eng-python-label", text: "Python" });

    const pre = container.createEl("pre", { cls: "eng-python-pre" });
    pre.createEl("code", { cls: "eng-python-code", text: source });

    const outputWrap = container.createDiv({ cls: "eng-python-output-wrap" });
    outputWrap.style.display = "none";
    const outputPre   = outputWrap.createEl("pre", { cls: "eng-python-output" });
    const exportTable = outputWrap.createDiv({ cls: "eng-python-export-table" });

    runBtn.onclick = () =>
      this.execute(source, ctx.sourcePath, runBtn, outputWrap, outputPre, exportTable);
  }

  private async execute(
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

    // Find Python
    let python: string;
    try {
      python = await findPython();
    } catch (err) {
      outputPre.textContent = String(err);
      outputPre.addClass("eng-python-error");
      runBtn.disabled = false;
      runBtn.textContent = "▶ Run";
      return;
    }

    // Parse # export: or # export(scope): directive
    // Examples:  # export: delta, sigma_max
    //            # export(folder): delta, sigma_max
    //            # export(tag:project:pr1): delta
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

    // Build variable injection preamble — scope-aware so tag/folder vars are correctly resolved
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

    // Build export postamble
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

    const fullScript = [preamble, "", source, postamble].join("\n");

    // Write script
    try {
      fs.writeFileSync(tmpScript, fullScript, "utf8");
    } catch (err) {
      outputPre.textContent = `Failed to write temp file: ${String(err)}`;
      outputPre.addClass("eng-python-error");
      runBtn.disabled = false;
      runBtn.textContent = "▶ Run";
      return;
    }

    // Run
    let stdout = "";
    let success = false;
    try {
      stdout = await runScript(python, tmpScript);
      success = true;
    } catch (err: any) {
      const out    = (err.stdout ?? "").trim();
      const errMsg = (err.stderr ?? String(err.message ?? err)).trim();
      outputPre.textContent = [out, errMsg].filter(Boolean).join("\n");
      outputPre.addClass("eng-python-error");
    }

    if (success) {
      outputPre.textContent = stdout.trim() || "(no output)";
    }

    // On a successful run, clean up any variables previously exported by this block
    // that are no longer in the export list (covers removed or renamed exports).
    if (success) {
      const prevExported = this.store.getAllEntries()
        .filter(e => e.entry.source === sourcePath && e.entry.block === "python")
        .map(e => e.key);
      const nowExported = new Set(exportNames);
      for (const name of prevExported) {
        if (!nowExported.has(name)) this.store.delete(name, sourcePath);
      }
    }

    // Read and store exports
    if (success && exportNames.length > 0) {
      try {
        const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(tmpExports, "utf8"));
        const rows: { name: string; value: unknown }[] = [];
        for (const name of exportNames) {
          const val = raw[name];
          if (val !== undefined && val !== null) {
            const num = Number(val);
            const primitive = isNaN(num) ? String(val) : num;
            this.store.set(name, primitive, undefined, sourcePath, "python", "global", exportVis, exportScopeTag);
            rows.push({ name, value: primitive });
          }
        }
        if (rows.length > 0) this.renderExportTable(exportTable, rows);
      } catch { /* no exports or parse error */ }
    }

    // Cleanup
    for (const f of [tmpScript, tmpExports]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }

    runBtn.disabled = false;
    runBtn.textContent = "▶ Run";
  }

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
