# Engineer — Obsidian Plugin

Engineering notebook plugin for Obsidian. Variables defined in one note
are available across the vault. Math blocks, spreadsheets, and Python
(planned) all share a single Variable Store.

## Architecture

### VariableStore.ts
Central key-value store. Persists to `.obsidian/engineer-vars.json`.
Visibility scopes: global / folder / tag / local / block.
Bug fixes applied: delete() calls save() immediately; load() prunes ghost
entries from deleted files.

### VarsBlockParser.ts
Parses ---vars blocks in markdown notes. Evaluates expressions top-to-bottom
using mathjs. Unit extracted from # comment tokens (Pa, N, m, kN, etc).

### ImportBlockParser.ts
Cross-file variable imports with aliasing. Tracks dependency graph.

### MathEngine.ts
Two rendering paths:
1. PRIMARY: `emath` code fence — registerMarkdownCodeBlockProcessor, receives
   raw LaTeX directly. Reliable.
2. SECONDARY: inline $<<...>>$ — post-processor reads raw source from
   fileSourceCache (populated by parseAllFiles and vault modify handler).
   Uses ctx.getSectionInfo() with fileSourceCache fallback.
Substitution syntax: <<varname>>, <<varname:.2e>>, <<result = expr:.4f>>
Delimiter: <<...>> — not [[...]] (wikilinks) or {...} (LaTeX grouping).
After each edit, calls store.set() for computed assignments.
Rerender: previewMode.rerender(false) rebuilds from source.

### EngSheetView.ts
FileView for .engsheet files (JSON). Registered via:
  registerView(ENGSHEET_VIEW_TYPE, leaf => new EngSheetView(leaf, store))
  registerExtensions([ENGSHEET_EXTENSION], ENGSHEET_VIEW_TYPE)

Performance: grid DOM built once in buildGrid(), updated in-place via
cellEls[r][c] references. No full re-render on cell edits.

HyperFormula loaded from CDN at runtime (window.HyperFormula).
Custom formula functions resolved before HF sees them:
  STORE("varname")  → current store value (substituted as literal)
  EXPORT(expr, "varname", "scope")  → expr only (EXPORT stripped, side-
    effect handled by processExports after rebuildHF)

Circular update prevention:
  _suppressStoreListener = true during processExports
  _storeUpdatePending + requestAnimationFrame debounces store → sheet updates

.engsheet file format: JSON with sheets[], meta{}. cells keyed "A1", "B3".
Each cell: { v: value, f: formula|null, style?: CellStyle }

### VariablePanel.ts
Sidebar ItemView. Groups: Orphaned (⚠), User overrides (✏), per-file.
Scope dropdown per row. Delete buttons on overrides and orphans.
fileExists() check for orphan detection.

### SpreadsheetModule.ts
Inline `spreadsheet` code fence renderer. Less interactive than .engsheet.
Reads from store via =store.varname, writes via export: directive.

### main.ts
Plugin entry point. parseAllFiles() calls mathEngine.cacheFileSource()
for every file so inline math post-processor has source available synchronously.
Vault modify handler also calls cacheFileSource() to keep cache fresh.

## Key bugs and their fixes

- delete() must call save() immediately or deletions reappear on restart
- load() must check adapter.exists() before loading each entry
- MathJax 3 does NOT store LaTeX source in DOM — cannot post-process after it
- storeListener must be suppressed during processExports to prevent infinite loop
- startEdit uses `committed` flag to prevent double-commit from onblur
- refreshAllFormulaCells iterates Object.keys(sheet.cells), not full grid
- deleteRow/deleteCol passes count to shiftCells for multi-row selection

## Build

npm run dev      # watch mode, rebuilds main.js on save
npm run build    # production build (minified)

## Phase roadmap

Phase 1 ✅  Variable Store + Math (---vars, emath, inline <<...>>)
Phase 2 🔄  .engsheet spreadsheet (in progress)
Phase 3 📋  Python execution (Pyodide WASM)
Phase 4 📋  Dependency graph, unit tracking, PDF export