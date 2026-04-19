# Engineer Plugin for Obsidian

Turn Obsidian into a live engineering notebook. Define variables once, use them in equations, spreadsheets, and Python scripts across your entire vault. Think MathCAD — but inside Obsidian, alongside your notes, links, and project structure.

---

## Installation (no Node.js required)

1. Download `main.js`, `manifest.json`, and `styles.css` from the GitHub release
2. Create the folder `.obsidian/plugins/obsidian-engineer/` inside your vault
3. Copy the three files into that folder
4. In Obsidian: **Settings → Community Plugins** → enable **Engineer**
5. Click the **Σ** icon in the left ribbon to open the Variable Store

**After first install:** Click **↺ Refresh** in the Variable Store sidebar once. This parses all `---vars` blocks in your vault and populates the source cache needed for inline math rendering.

---

## Building from source

Requires Node.js 18+.

```bash
git clone https://github.com/yourname/obsidian-engineer
cd obsidian-engineer
npm install
npm run build      # produces main.js
npm run dev        # watch mode — rebuilds on every save
```

Symlink the folder into your vault for development:
```bash
# macOS / Linux
ln -s "$(pwd)" "$HOME/Documents/MyVault/.obsidian/plugins/obsidian-engineer"

# Windows (run as Administrator)
mklink /D "C:\path\to\vault\.obsidian\plugins\obsidian-engineer" "C:\path\to\obsidian-engineer"
```

After each rebuild, reload the plugin: **Ctrl+Shift+P → "Reload app without saving"**

---

## Feature 1 — Variable blocks (`---vars`)

Declare engineering variables in a fenced block anywhere in a note. Variables are evaluated top-to-bottom, can reference earlier variables in the same block, and are immediately available to every other note in the vault.

### Syntax

```
---vars
# Material properties
E: 200e9          # Pa
nu: 0.3

# Derived — can reference earlier vars
G: E / (2 * (1 + nu))   # Pa

# Section (W200×100 I-beam)
I: 113e-6         # m⁴
A: 0.0127         # m²

# Loading
F: 50000          # N
L: 6.0            # m
---
```

### Value types

| Type | Example |
|------|---------|
| Integer | `7850` |
| Decimal | `0.3` |
| Scientific notation | `200e9`, `8.33e-6` |
| Expression (earlier vars in scope) | `E / (2 * (1 + nu))` |
| String | `"Steel S275"` |
| Array | `[10000, 15000, 8000]` |

### Unit annotations

A comment starting with a recognized unit token is stored as the variable's unit and shown in the Variable Store sidebar and in substituted math:

```
F: 50000    # N, applied point load
sigma: 275e6  # Pa, yield strength
```

Recognized units include: `Pa`, `kPa`, `MPa`, `GPa`, `N`, `kN`, `MN`, `m`, `mm`, `cm`, `m⁴`, `kg`, `s`, `J`, `W`, `K`, `°C`, `rad`, `Hz`, `A`, `V`, `Ω` and others.

### What happens on save

1. The `---vars` block is parsed and evaluated
2. Variables are written to the Variable Store
3. All open notes re-render their math blocks with the new values

---

## Feature 2 — Inline math (`$...$` and `$$...$$`)

Standard Obsidian LaTeX math gains live variable substitution using `<<...>>` double angle-bracket syntax. Switch to **Reading View** (Ctrl+E) to see rendered output.

### Why `<<...>>` delimiters?

- `[[...]]` is Obsidian's wikilink syntax — gets converted before plugins see it
- `{...}` conflicts with LaTeX grouping (`\frac{a}{b}`)
- `<<...>>` has no special meaning in either Obsidian or LaTeX

### Syntax

**Read a variable:**
```latex
The span is $L = <<L>>$ m and the load is $F = <<F>>$ N.
```

**Read with format specifier:**
```latex
Young's modulus: $E = <<E:.2e>>$ Pa
```

**Compute and assign** (evaluates, displays, and writes back to the store):
```latex
$$\delta_{max} = \frac{F L^3}{48 E I} = <<delta = F * L^3 / (48 * E * I):.5f>>\ \text{m}$$
```

### Format specifiers (printf-style, after the colon)

| Spec | Meaning | Example |
|------|---------|---------|
| `:.2e` | Scientific, 2 decimal places | `2.00 \times 10^{11}` |
| `:.5f` | Fixed decimal, 5 places | `0.00017` |
| `:.3g` | General (auto), 3 sig figs | `0.3` |
| `:.0d` | Integer (rounded) | `50000` |

### Primary method — `emath` code fence (most reliable)

For display equations, use the `emath` code fence. Obsidian passes the raw content directly to the plugin — no parsing interference.

````markdown
```emath
\delta_{max} = \frac{F L^3}{48 E I} = <<delta = F * L^3 / (48 * E * I):.5f>>\ \text{m}
```
````

````markdown
```emath
\sigma_{max} = \frac{M \cdot y}{I} = <<sigma = (F*L/4) * y / I:.3e>>\ \text{Pa}
```
````

**Important — mathjs expression syntax inside `<<...>>`:**
- Use `*` for multiplication: `F * L^3`  not `F L^3`
- Use `^` for powers: `L^3` not `L**3`
- Use `()` for grouping: `(48 * E * I)`

### Secondary method — inline `$<<...>>$`

Works inside regular `$...$` and `$$...$$` blocks. Requires the source cache to be populated (click **↺ Refresh** after first install or after adding new notes with `---vars`).

```markdown
Young's modulus is $E = <<E:.2e>>$ Pa.

The applied load is $F = <<F>>$ N over a span of $L = <<L>>$ m.
```

### Error display

Undefined variables or evaluation errors render as `? expr` in red, so the rest of the equation still displays. Fix by defining the variable in a `---vars` block.

### Worked example

```markdown
---vars
E: 200e9    # Pa
I: 113e-6   # m⁴
F: 50000    # N
L: 6.0      # m
y: 0.1      # m
---

# Simply Supported Beam

The span is $L = <<L>>$ m carrying $F = <<F>>$ N.

## Deflection at mid-span

 ```emath
\delta_{max} = \frac{F L^3}{48 E I} = <<delta = F * L^3 / (48 * E * I):.5f>>\ \text{m}
 ```

## Bending moment

 ```emath
M_{max} = \frac{F L}{4} = <<M = F * L / 4>>\ \text{N·m}
 ```

## Bending stress

 ```emath
\sigma_{max} = \frac{M y}{I} = <<sigma = M * y / I:.3e>>\ \text{Pa}
 ```
```

---

## Feature 3 — Cross-file variable imports (`---import`)

Pull variables from another note into the current note's scope. Avoids duplicating values across analysis files.

### Syntax

```
---import
from: "materials/steel-s275.md"
vars: [E_steel, sigma_yield, rho]
---
```

### With aliasing

```
---import
from: "materials/concrete-c30.md"
vars:
  fck: fck_concrete
  Ecm: Ecm_concrete
---
```

### Import all

```
---import
from: "project-globals.md"
vars: "*"
---
```

### Path resolution

`from:` accepts a vault-relative path (`"materials/steel.md"`), a bare filename (`"steel"` — plugin searches for it), or a full path with extension.

---

## Feature 4 — Variable Store sidebar

Open with the **Σ** ribbon icon, or **Ctrl+Shift+P → "Engineer: Open Variable Store"**.

### What you see

Variables are grouped into three sections:

**⚠ Orphaned** — variables whose source file has been deleted. Show a ✕ delete button.

**✏ User overrides** — values you have manually changed in the panel. Show a ✕ delete button. Clicking ✕ restores the file-defined value.

**Per-file groups** — all variables from each source file, showing name, value, unit badge, scope dropdown, and a ⚡ badge for variables computed by math blocks.

### Scope dropdown

Every variable row has a small dropdown controlling who can see it:

| Scope | Meaning |
|-------|---------|
| 🌐 Global | Visible to all notes in the vault (default) |
| 📁 Folder | Visible only to notes in the same folder tree as the source |
| 🏷 Tag | Visible only to notes sharing a specified frontmatter tag |
| 📄 Local | Visible only within the source file itself |

Selecting **Tag** reveals an inline text input for the tag name. Changes take effect immediately.

### Clicking a variable name

Opens the source file.

### Clicking a variable value

Opens an inline editor. Press **Enter** to override the value temporarily — the variable is flagged as a user override and all math blocks update. Press **Escape** to cancel.

### ↺ Refresh button

Re-parses all `---vars` blocks across the vault and repopulates the source cache for inline math. **Run this once after first install.**

### + Add button

Opens a dialog to define a temporary variable without editing any file. Useful for "what if" calculations. Set name, value, unit, and scope.

### Search

Filters by variable name or value. Results update as you type.

### Footer

Shows total variable count, number of user overrides, and number of orphaned entries.

---

## Feature 5 — Spreadsheet code fence (`spreadsheet`)

An interactive grid rendered from a `spreadsheet` code fence. Cells can read Variable Store values and export computed results back to the store. Edits persist to the markdown source file.

### Basic syntax

````markdown
```spreadsheet
name: beam_sections
cols: [Label, Symbol, Value, Unit]
rows:
  - ["Young's modulus",   E,   =store.E,    Pa]
  - ["Moment of inertia", I,   =store.I,    m⁴]
  - ["Span length",       L,   =store.L,    m]
  - ["Applied load",      F,   =store.F,    N]
  - ["Deflection",        δ,   =F*L^3/(48*E*I), m]
export: [E, I, L, F]
```
````

### Directives

| Directive | Required | Description |
|-----------|----------|-------------|
| `name:` | No | Identifier for cross-sheet references |
| `cols:` | No | Column header labels |
| `rows:` | Yes | Data rows (YAML list of lists) |
| `export:` | No | Symbol names to write back to Variable Store |
| `highlight:` | No | Conditional formatting rule |

### Cell values

| Syntax | Description |
|--------|-------------|
| `200e9` | Plain number (scientific notation supported) |
| `"Steel S275"` | String value |
| `true` / `false` | Boolean |
| `=store.E` | Read variable `E` from Variable Store |
| `=STORE("E")` | Alternative syntax for reading from store |
| `=F * L^3 / (48*E*I)` | mathjs expression (all store vars in scope) |
| `=A2 * B3` | Cell reference (column letter + row number) |
| `=SUM(C2:C6)` | Aggregate functions |
| `=IF(sigma > 275e6, "FAIL", "OK")` | Conditional |

### Conditional formatting

```
highlight: [delta > 0.02, red]
```

Colors: `red`, `amber`, `green`, `blue`

### Cross-sheet references

In any formula, reference a named cell from another spreadsheet in the same note:

```
=beam_sections.delta
```

### Store integration

- **Reading:** use `=store.varname` or `=STORE("varname")` in any formula cell
- **Writing:** list symbol names in `export:` — after each evaluation, those rows' computed values are written to the store with global visibility
- **Live updates:** when the store changes (e.g. a `---vars` block is re-parsed), all spreadsheets re-evaluate automatically

### Editing

Click any cell to edit it. Press **Enter** to commit. Changes are written back to the markdown source immediately, so they persist across sessions.

---

## Feature 6 — Engineering spreadsheet files (`.engsheet`)

Full Excel-like spreadsheet files with a dedicated editor. Create one with **Ctrl+Shift+P → "Engineer: New engineering spreadsheet"**.

### File format

`.engsheet` files are JSON. You can inspect or version-control them like any other file.

### Interface

| Area | Description |
|------|-------------|
| **Name box** (top-left) | Shows active cell address (e.g. `B3`). Type an address and press Enter to jump. |
| **Formula bar** (top-center) | Shows the raw formula or value of the active cell. Edit here or directly in the cell. |
| **Format dropdown** | Apply number formatting to the selected cells. |
| **Toolbar buttons** | Bold, Italic, Underline, alignment, text color, background color. |
| **Sheet tabs** (bottom) | Switch sheets, add/rename/delete sheets. Right-click a tab for options. |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Arrow keys | Move selection |
| Shift + Arrow | Extend selection |
| Enter | Move selection down |
| Shift + Enter | Move selection up |
| Tab | Move selection right |
| Shift + Tab | Move selection left |
| F2 or double-click | Start editing active cell |
| Escape | Cancel edit |
| Delete / Backspace | Clear cell contents |
| Ctrl + C | Copy selection |
| Ctrl + X | Cut selection |
| Ctrl + V | Paste |
| Ctrl + A | Select all |

### Formula syntax

| Syntax | Description |
|--------|-------------|
| `=A1 + B2` | Standard cell references |
| `=SUM(A1:A10)` | HyperFormula built-in functions (full Excel-compatible library) |
| `=STORE("varname")` | Read from Variable Store |
| `=EXPORT(expr, "varname")` | Evaluate `expr` and write result to Variable Store |
| `=EXPORT(B3*1.5, "sigma_allow", "global")` | Export with explicit scope |

### STORE() and EXPORT()

`STORE("varname")` is resolved before HyperFormula evaluates the formula. The variable's current value is substituted as a literal number or string.

`EXPORT(expr, "varname")` — the `expr` part is evaluated by HyperFormula normally; as a side effect, the computed value is written to the Variable Store under the given name. The third argument (scope) is optional and defaults to `"global"`.

### Circular update prevention

When `EXPORT()` writes to the store, the store-change listener is temporarily suppressed to prevent infinite update loops.

---

## Feature 7 — Python code fence (`python`)

Run Python directly in Obsidian using [Pyodide](https://pyodide.org) (WebAssembly). No local Python installation required. Click **▶ Run** to execute.

> **First run:** Pyodide loads from CDN (~10 MB). Subsequent runs are instant.

### Syntax

````markdown
```python
# export: delta, sigma_max
import numpy as np

# All Variable Store variables are auto-injected as Python globals
delta = F * L**3 / (48 * E * I)
sigma_max = M * c / I

print(f"δ = {delta:.4f} m")
print(f"σ_max = {sigma_max:.2e} Pa")
```
````

### Directives

| Directive | Syntax | Description |
|-----------|--------|-------------|
| Export | `# export: var1, var2` | Write named Python variables back to Variable Store after execution |

### Store integration

- **Reading:** all variables visible to the current file are automatically injected as Python globals before execution. Use them directly: `delta = F * L**3 / (48*E*I)`.
- **Writing:** add `# export: varname1, varname2` as a comment. After successful execution, those variables are read from the Python environment and written to the store.

### Output

`print()` output appears in an **Output** section below the code. If variables were exported, a small table shows their names and values.

### Available packages

Standard library is always available. Scientific packages (numpy, scipy, sympy, matplotlib) can be installed at runtime:

```python
import micropip
await micropip.install("scipy")
from scipy import optimize
```

---

## Variable Store sidebar

Open with the **Σ** ribbon icon, or **Ctrl+Shift+P → "Engineer: Open Variable Store"**.

Variables are grouped into three sections:

**⚠ Orphaned** — variables whose source file has been deleted. Show a ✕ delete button.

**✏ User overrides** — values you have manually changed in the panel.

**Per-file groups** — all variables from each source file.

Each row shows: name · value · unit badge · source badge (computed / import / override) · scope dropdown.

---

## Variable scoping reference

| Scope | Meaning | Persists |
|-------|---------|----------|
| Global | Visible to all notes in the vault (default) | Yes |
| Folder | Visible to notes in the same folder tree as the source | Yes |
| Tag | Visible to notes sharing a specified frontmatter tag | Yes |
| Local | Visible only within the source file | Session only |
| Block | Ephemeral — only during expression evaluation | No |

---

## Persistence

The variable store is saved to:
```
<your vault>/.obsidian/engineer-vars.json
```

This file is human-readable JSON. It is written on every delete, on `clearFromSource`, and on the autosave interval (default 30s). On startup, entries whose source files no longer exist are automatically pruned before loading.

---

## Settings

**Settings → Community Plugins → Engineer (⚙)**

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-save interval | 30 s | How often the store is flushed to disk. 0 = on unload only. |
| Parse on startup | On | Parse all `---vars` blocks when Obsidian opens |

---

## Commands

Available via **Ctrl+Shift+P**:

| Command | Description |
|---------|-------------|
| Engineer: Open Variable Store | Open the sidebar panel |
| Engineer: Parse all variable blocks | Re-parse all `---vars` blocks across the vault |
| Engineer: Recalculate current note | Force re-render of the active note |
| Engineer: New engineering spreadsheet | Create a new `.engsheet` file |

---

## Troubleshooting

**Variables not updating after saving a `---vars` block**
→ Save the file (Ctrl+S) and wait ~1 second. If no update, click ↺ Refresh in the sidebar.

**Math block shows `? varname` in red**
→ The variable is not in the store. Check spelling (case-sensitive). Confirm the source file has been saved. Use the sidebar search to verify the variable exists.

**Inline `$<<F>>$` not rendering — shows literal text**
→ Click ↺ Refresh to populate the source cache, then switch to Reading View (Ctrl+E). The source cache must be populated before inline math can render.

**Variable Store sidebar is empty on startup**
→ Click ↺ Refresh. If Parse on startup is enabled, variables load after layout is ready (~1-2s after Obsidian opens).

**`emath` fence shows "Engineer math error"**
→ Check the LaTeX syntax and ensure all variables referenced exist in the store. Use `*` for multiplication and `^` for powers inside `<<...>>`.

**`.engsheet` formula shows an error code (`#NAME?`, `#REF!`, etc.)**
→ The formula uses an unrecognized function or an invalid cell reference. For store access, use `=STORE("varname")`. For cell references, use standard A1 notation (`=A1 + B2`).

**Python fence shows "Failed to load Pyodide"**
→ Pyodide requires an internet connection on first use. Check your connection and try again.

**`spreadsheet` fence cell edit doesn't persist**
→ Edits write back to the markdown source file. If the file is read-only or the vault is a remote sync that is currently offline, the write may fail silently.

---

## Development status

### ✅ Phase 1 — Variable Store + Math

- `---vars` blocks for variable declaration with mathjs evaluation
- `emath` code fence for display math with `<<...>>` substitution
- Inline `$<<...>>$` math substitution with format specifiers
- Cross-file variable sharing via `---import` with aliasing
- Variable Store sidebar: scope dropdowns, delete, search, override editor
- Variable persistence with ghost-entry cleanup on startup
- Folder and tag visibility scoping

### ✅ Phase 2 — Spreadsheets

- `spreadsheet` code fence: interactive grid with mathjs formula engine
- `=store.varname` and `=STORE("varname")` for reading from the store
- `export:` directive for writing computed values back to the store
- Cell edits persist to markdown source via vault API
- Conditional formatting (`highlight:` directive)
- Cross-sheet references (`sheetName.symbol`)
- `.engsheet` file type: full Excel-like editor with HyperFormula (bundled, works offline)
- Formula bar, column/row insert/delete, clipboard, multi-sheet tabs
- `=STORE("varname")` and `=EXPORT(expr, "varname")` custom functions in `.engsheet`
- Cell formula error display (`#NAME?`, `#REF!`, etc.)

### ✅ Phase 3 — Python execution

- `python` code fence with in-browser execution via Pyodide (WebAssembly)
- Variable Store values auto-injected as Python globals before execution
- `# export: var1, var2` directive writes Python variables back to the store
- `print()` output rendered inline below the code block
- numpy, scipy, and other scientific packages available via micropip
- Shared Pyodide instance across all code fences (loads once per session)

### 📋 Phase 4 — Advanced features (planned)

- Undo/redo for `.engsheet`
- Dependency graph: visual map of which files depend on which variables
- Unit tracking and dimensional analysis
- PDF export with computed values baked in
- Variable history and diff view
- Stale-dependency warnings when upstream values change
