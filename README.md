# Engineer Plugin for Obsidian

Turn Obsidian into a live engineering notebook. Define variables once, use them in equations, spreadsheets, and Python scripts across your entire vault — with full control over which variables are visible where.

---

## Installation (no Node.js required)

1. Download `main.js`, `manifest.json`, and `styles.css` from the GitHub release
2. Create the folder `.obsidian/plugins/obsidian-engineer/` inside your vault
3. Copy the three files into that folder
4. In Obsidian: **Settings → Community Plugins** → enable **Engineer**
5. Click the **{x}** icon in the left ribbon to open the Variable Store

**After first install:** Click **↺ Refresh** in the Variable Store sidebar once to parse all `---vars` blocks.

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

After each rebuild, reload the plugin: **Ctrl+Shift+P → "Reload app without saving"**

---

## Feature 1 — Variable blocks (`---vars`)

Declare engineering variables in a fenced block anywhere in a note. Variables are evaluated top-to-bottom, can reference earlier variables in the same block, and are immediately available to other notes according to their scope.

### Basic syntax

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

A comment starting with a recognized unit token is stored as the variable's unit and shown in the Variable Store sidebar:

```
F: 50000      # N, applied point load
sigma: 275e6  # Pa, yield strength
```

Recognized units include: `Pa`, `kPa`, `MPa`, `GPa`, `N`, `kN`, `MN`, `m`, `mm`, `cm`, `m⁴`, `kg`, `s`, `J`, `W`, `K`, `°C`, `rad`, `Hz`, `A`, `V`, `Ω`, and others.

---

## Feature 2 — Variable scoping

By default, variables are **global** — visible to all notes. Add a scope keyword in the comment to restrict visibility.

### Scope keywords

```
---vars
# Global (default — no keyword needed)
g: 9.81               # m/s²

# File scope — visible only within this note
rebar_dia: 0.016      # m, file

# Folder scope — visible to all notes in the same folder
fck: 30e6             # Pa, folder

# Explicit folder path — visible to all notes under projects/bridge/
E_concrete: 30e9      # Pa, folder:projects/bridge

# Tag scope — visible to notes sharing the tag "structural"
sigma_yield: 355e6    # Pa, tag:structural

# Explicit global (same as default)
PI: 3.14159           # global
---
```

### Scope reference

| Scope | Keyword | Visibility |
|-------|---------|------------|
| **Global** | *(default)* or `global` | All notes in the vault |
| **File** | `file` | Only the note that defines the variable |
| **Folder** | `folder` | Notes in the same folder as the source file |
| **Folder (explicit path)** | `folder:path/to/dir` | Notes anywhere under the specified path |
| **Tag** | `tag:tagname` | Notes sharing that frontmatter or inline tag |

> **Backward compatibility:** the old `local` keyword is still accepted as an alias for `file`.

### Virtual frontmatter tags

Frontmatter key:value pairs are treated as virtual tags for scope matching. A file with `project: bridge` in its frontmatter automatically has the virtual tag `project:bridge`:

```
E: 200e9    # Pa, tag:project:bridge
```

---

## Feature 3 — Inline math (`$...$` and `$$...$$`)

Standard Obsidian LaTeX gains live variable substitution using `<<...>>` delimiters. Switch to **Reading View** (Ctrl+E) to see rendered output.

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

### Format specifiers

| Spec | Meaning | Example output |
|------|---------|----------------|
| `:.2e` | Scientific, 2 decimal places | `2.00 \times 10^{11}` |
| `:.5f` | Fixed decimal, 5 places | `0.00017` |
| `:.3g` | General (auto), 3 sig figs | `0.3` |
| `:.0d` | Integer (rounded) | `50000` |

### Primary method — `emath` code fence

````markdown
```emath
\delta_{max} = \frac{F L^3}{48 E I} = <<delta = F * L^3 / (48 * E * I):.5f>>\ \text{m}
```
````

### Calculation color

Computed values render in teal by default. Change the color in **Settings → Engineer → Math rendering**.

---

## Feature 4 — Variable Store sidebar

Open with the **{x}** ribbon icon, or **Ctrl+Shift+P → "Engineer: Open Variable Store"**.

### Sections

| Section | Icon | Contents |
|---------|------|----------|
| **File** | 📄 | Variables scoped to this file only (`file`) |
| **Folder** | 📁 | Variables scoped to the same folder (`folder`) |
| **Path** | 📂 | Variables scoped to ancestor folders |
| **Tag** | 🏷 | Variables visible via shared tags (`tag:name`) |
| **Global** | 🌐 | All vault-wide variables, grouped by source file |
| **User overrides** | ✏ | Values you have manually changed in the panel |
| **Orphaned** | ⚠ | Variables whose source file has been deleted |

### Interacting with variables

- **Click a name** — opens the source file
- **Click a value** — opens an inline editor; Enter to override, Escape to cancel
- **✕ button** — removes an override or orphaned entry
- **↺ Refresh** — re-parses all `---vars` blocks across the vault
- **+ Add** — defines a temporary variable without editing any file

---

## Feature 5 — Engineering spreadsheet files (`.engsheet`)

Full Excel-like spreadsheet files with a dedicated editor. Create one with **Ctrl+Shift+P → "Engineer: New engineering spreadsheet"** or the table icon in the ribbon.

### Interface

| Area | Description |
|------|-------------|
| **Name box** | Active cell address. Type an address and press Enter to jump. |
| **Formula bar** | Raw formula or value of the active cell. |
| **Home ribbon** | Undo/Redo, Clipboard, Font, Alignment, Borders, Number format, Cells, Clear |
| **Data ribbon** | Sort A→Z / Z→A, CSV Import, CSV Export |
| **View ribbon** | Freeze top row / first column / unfreeze |
| **Sheet tabs** | Switch, add, rename, delete. Right-click for options. |
| **Status bar** | Autosave status · selection address · Sum / Count / Avg for numeric ranges |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Arrow keys | Move selection |
| Enter / Shift+Enter | Move down / up |
| Tab / Shift+Tab | Move right / left |
| F2 or double-click | Start editing |
| Escape | Cancel edit |
| Delete / Backspace | Clear cell contents |
| Ctrl+C / X / V | Copy / Cut / Paste |
| Ctrl+B / I / U | Bold / Italic / Underline |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+S | Save immediately |

### Formula entry — point mode

While typing a formula that starts with `=`, you can select cell references interactively without leaving the keyboard:

- **Arrow keys** — when the cursor is after `(`, `,`, `=`, or an operator, arrow keys enter point mode: they navigate the grid and insert the cell address at the cursor position. The referenced cell is highlighted in blue.
- **Shift+Arrow** — extends the reference to a range (e.g. `A1:C4`).
- **Click a cell** — inserts that cell's address at the cursor. Click and drag to insert a range.
- **Any letter/digit key** — exits point mode and resumes normal formula typing.
- **Enter / Tab** — commits the formula as usual.

### Formula syntax

| Syntax | Description |
|--------|-------------|
| `=A1 + B2` | Cell references |
| `=SUM(A1:A10)` | HyperFormula built-in functions |
| `=STORE("varname")` | Read a variable from the Variable Store |
| `=EXPORT(expr, "varname")` | Evaluate and write to the store (global) |
| `=EXPORT(expr, "varname", "scope")` | Write with explicit scope |

### Autofill

Drag the small square handle at the bottom-right of a selection to fill down or right. Formulas have their cell references adjusted automatically. Number series (e.g. 1, 2, 3 → 4, 5, 6) are detected and continued.

### Undo / Redo

Up to 50 levels of undo per sheet. Covers cell edits, paste, autofill, sort, clear, and formatting changes. Undo stack resets when switching sheets.

### CSV import

Click **Import** in the Data ribbon to load a `.csv` file into the sheet starting at the active cell. The sheet expands automatically if the CSV has more rows or columns than the current grid. Quoted fields and escaped quotes (RFC 4180) are handled correctly.

### CSV export

Click **Export** in the Data ribbon to download the current sheet (or selected range, if more than one cell is selected) as a `.csv` file. Resolved cell values are exported — formulas are not written to the file.

### Google Sheets / Excel clipboard interop

- **Paste from Google Sheets or Excel** — copy cells in Google Sheets or Excel, then press Ctrl+V in EngSheet. The tab-separated clipboard content is parsed and populated into the sheet starting at the active cell.
- **Copy to Google Sheets or Excel** — select a range in EngSheet and press Ctrl+C. The selection is written to the system clipboard as TSV, so it can be pasted directly into Google Sheets or Excel with column alignment intact.

---

## Feature 6 — Python code fence (`python`)

Run Python directly in Obsidian using your system Python installation. Click **▶ Run** to execute.

> **Requirement:** Python 3 must be installed and available on your system PATH.

### Basic example

````markdown
```python
import numpy as np

# Store variables (E, I, F, L) are auto-injected as Python globals
delta = F * L**3 / (48 * E * I)

print(f"δ = {delta:.4f} m")
```
````

### Exporting variables to the store

Variables listed in an `# export` directive are written to the Variable Store after a successful run.

```python
# export: delta, sigma_max
delta = F * L**3 / (48 * E * I)
sigma_max = M * c / I
```

### Export with scope

| Directive | Scope |
|-----------|-------|
| `# export: var1, var2` | Global |
| `# export(folder): var1` | Folder — notes in the same folder |
| `# export(tag:tagname): var1` | Tag — notes sharing the specified tag |

### Auto-run on parse (`#runOnParse`)

Add `# runOnParse` as the first comment in a python block to have it execute automatically whenever the vault is parsed (on startup and when the file is saved):

````markdown
```python
# runOnParse
# export: stiffness
import numpy as np

stiffness = E * I / L**3
```
````

The block runs in the background without displaying output. Exported variables are written directly to the store, making them available to `<<...>>` math blocks and other notes automatically.

Enable or disable this feature globally in **Settings → Engineer → Python → Run #runOnParse blocks automatically**.

### Exported to store table

After a successful run, a summary table lists the variables written to the store. Toggle this table on/off in **Settings → Engineer → Python → Show "Exported to store" table**.

---

## Variable scoping — quick reference

| Keyword | Panel section | Who can read it |
|---------|--------------|-----------------|
| *(none)* / `global` | 🌐 Global | Every note in the vault |
| `file` | 📄 File | Only the note that defines the variable |
| `folder` | 📁 Folder | Notes in the same folder as the source |
| `folder:path/to/dir` | 📁 Folder / 📂 Path | Notes anywhere under the specified path |
| `tag:tagname` | 🏷 Tag | Notes sharing that frontmatter/inline tag |

### Where scopes can be set

| Source | Syntax |
|--------|--------|
| `---vars` block | `E: 200e9 # Pa, folder` |
| `.engsheet` EXPORT | `=EXPORT(A1, "E", "folder")` |
| Python block | `# export(folder): delta` |

---

## Persistence

The variable store is saved to:
```
<your vault>/.obsidian/engineer-vars.json
```

File-sourced variables are re-parsed from `---vars` blocks on startup. Ghost entries whose source files no longer exist are pruned automatically.

---

## Settings

**Settings → Community Plugins → Engineer (⚙)**

### Variable Store

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-save interval | 150 s | How often the store is flushed to disk. 0 = on unload only. |
| Parse on startup | On | Parse all `---vars` blocks when Obsidian opens. |

### Math rendering

| Setting | Default | Description |
|---------|---------|-------------|
| Calculation result color | `teal` | Color for computed `<<...>>` values. Accepts CSS color names or `#RRGGBB`. |
| Error placeholder color | `red` | Color for unresolved or errored expressions. |

### Python

| Setting | Default | Description |
|---------|---------|-------------|
| Run #runOnParse blocks automatically | On | Execute python blocks with `# runOnParse` on startup and file save. |
| Show "Exported to store" table | On | Show the variable summary table below Python output after a run. |

### Variable Panel sections

Toggle individual sections in the sidebar on or off: File, Folder, Path, Tag, Global.

---

## Commands

| Command | Description |
|---------|-------------|
| Engineer: Open Variable Store | Open the sidebar panel |
| Engineer: Parse all variable blocks | Re-parse all `---vars` blocks |
| Engineer: Recalculate current note | Force re-render of the active note |
| Engineer: New engineering spreadsheet | Create a new `.engsheet` file |

---

## Troubleshooting

**Variables not updating after saving a `---vars` block**
→ Save the file (Ctrl+S). If no update, click ↺ Refresh in the sidebar.

**Math block shows `? varname` in red**
→ The variable is not visible from this file. Check scope and spelling. Use the sidebar to verify.

**Inline `$<<F>>$` not rendering — shows literal text**
→ Click ↺ Refresh, then switch to Reading View (Ctrl+E).

**Variable Store sidebar is empty on startup**
→ Click ↺ Refresh. If Parse on startup is on, variables load ~1–2 s after Obsidian opens.

**Python fence shows "Python 3 not found on PATH"**
→ Install Python 3 from python.org. On Windows, check "Add Python to PATH" during installation.

**Python fence output is empty**
→ Add `print()` statements. Expressions alone produce no output.

**`#runOnParse` block not running on startup**
→ Confirm "Run #runOnParse blocks automatically" is enabled in Settings → Engineer → Python.

**Python variable still in store after removing `# export:`**
→ Press **▶ Run** again. The cleanup runs on each successful execution.

**`.engsheet` formula shows `#NAME?` or `#REF!`**
→ The formula uses an unrecognized function or invalid cell reference. For store access use `=STORE("varname")`.

**Pasting from Google Sheets does nothing**
→ Ensure the EngSheet grid is focused (click any cell), then press Ctrl+V. If an internal copy is active (marching ants border visible), press Escape first to clear it, then paste.

---

## Development status

### ✅ Phase 1 — Variable Store + Math

- `---vars` blocks with mathjs expression evaluation
- `emath` code fence and inline `$<<...>>$` with format specifiers
- Multi-scope variable system: File, Folder (with explicit path), Tag, Global
- Variable Store sidebar with scope sections, search, value override editor
- Persistence with ghost-entry cleanup on startup

### ✅ Phase 2 — Spreadsheets

- `.engsheet` full Excel-like editor with HyperFormula
- Tabbed ribbon: Home / Data / View
- Formula bar, multi-sheet tabs, column/row operations, clipboard, formatting
- Autofill with formula reference adjustment and numeric series detection
- Freeze panes, sort, number formats, font/color/border controls
- `=STORE("varname")` / `=EXPORT(expr, "varname", "scope")`
- Undo/redo (50 levels), status bar with Sum/Count/Avg

### ✅ Phase 3 — Python execution

- `python` code fence with system Python execution
- Scope-aware variable injection
- `# export:` / `# export(folder):` / `# export(tag:name):` directives
- `# runOnParse` — auto-execution on startup and file save
- Stale export cleanup on each run

### ✅ Phase 4 — Polish & UX

- EngSheet undo/redo for cell edits, paste, autofill, sort, clear, and formatting
- Math rendering color settings (calculation value and error placeholder)
- Python "Exported to store" table toggle

### ✅ Phase 5 — CSV import/export + Google Sheets interop

- CSV import: file picker → populate EngSheet from a `.csv` file; sheet auto-expands to fit
- CSV export: selected range or used range serialized to a `.csv` download
- TSV paste: copy cells in Google Sheets or Excel → Ctrl+V into EngSheet
- TSV copy: Ctrl+C in EngSheet writes TSV to system clipboard → paste directly into Google Sheets or Excel
- Formula point mode: arrow keys and click-drag insert cell references while typing a formula

### 📋 Phase 6 — Data plotting (planned)

`engplot` code fences render interactive charts inline in notes. Data is sourced from `.engsheet` column ranges, vault CSV files, or inline arrays declared in the fence. Store variables can be referenced for threshold lines. Charts update live when source data changes.

**Planned chart types:** line, scatter, bar, horizontal bar, area (filled line), pie, donut

**Planned data sources:**

| Source | Syntax |
|--------|--------|
| EngSheet column range | `source: data/results.engsheet`, `sheet: Sheet1`, `x: A2:A50` |
| Vault CSV file | `source: data/results.csv`, `x: Load`, `y: Deflection` |
| Inline arrays | `x: [1, 2, 3]`, `y: [10, 20, 15]` |
| Store variable reference line | `reference: { label: "Allowable", value: "<<F_allow>>" }` |

**Planned fence syntax:**

````markdown
```engplot
type: line
title: Load vs Deflection
x-label: Load (N)
y-label: Deflection (mm)
series:
  - name: Test A
    source: data/beam_results.engsheet
    sheet: Sheet1
    x: A2:A20
    y: B2:B20
options:
  legend: true
  grid: true
  smooth: false
```
````

**Other planned capabilities:** theme-aware colors (inherits Obsidian light/dark mode), right-click PNG export, re-render on vault file change.
