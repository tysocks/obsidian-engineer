# Engineer Plugin for Obsidian

Turn Obsidian into a live engineering notebook. Define variables once, use them in equations, spreadsheets, and Python scripts across your entire vault — with full control over which variables are visible where.

---

## Installation (no Node.js required)

1. Download `main.js`, `manifest.json`, and `styles.css` from the GitHub release
2. Create the folder `.obsidian/plugins/obsidian-engineer/` inside your vault
3. Copy the three files into that folder
4. In Obsidian: **Settings → Community Plugins** → enable **Engineer**
5. Click the **Σ** icon in the left ribbon to open the Variable Store

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

Place a scope keyword anywhere in the `#` comment after the value:

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

Frontmatter key:value pairs are treated as virtual tags for scope matching. A file with `project: bridge` in its frontmatter automatically has the virtual tag `project:bridge`, so:

```
E: 200e9    # Pa, tag:project:bridge
```

is visible to every file that has `project: bridge` in its frontmatter — no `#` inline tag required.

### Multi-project example

```
projects/
  project1/
    beams.md       ← defines E: 200e9 # Pa, folder
    columns.md     ← can use <<E>> (same folder)
  project2/
    slabs.md       ← cannot use E (different folder)
shared/
  constants.md     ← defines g: 9.81 # m/s² (global)
```

`beams.md` and `columns.md` share `E` within `project1/`. `slabs.md` is isolated. Both can use `g`.

---

## Feature 3 — Inline math (`$...$` and `$$...$$`)

Standard Obsidian LaTeX gains live variable substitution using `<<...>>` delimiters. Switch to **Reading View** (Ctrl+E) to see rendered output.

### Why `<<...>>` delimiters?

- `[[...]]` is Obsidian's wikilink syntax — converted before plugins run
- `{...}` conflicts with LaTeX grouping (`\frac{a}{b}`)
- `<<...>>` has no special meaning in Obsidian or LaTeX

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

### Primary method — `emath` code fence (most reliable)

````markdown
```emath
\delta_{max} = \frac{F L^3}{48 E I} = <<delta = F * L^3 / (48 * E * I):.5f>>\ \text{m}
```
````

**mathjs expression syntax inside `<<...>>`:**
- Use `*` for multiplication: `F * L^3`
- Use `^` for powers: `L^3`
- Use `()` for grouping: `(48 * E * I)`

### Secondary method — inline `$<<...>>$`

Works inside regular `$...$` and `$$...$$`. Requires ↺ Refresh after first install.

### Scope inheritance for computed assignments

A `<<result = expression>>` in a math block inherits its scope from the `---vars` pre-declaration in the same file. Pre-declare the variable in a `---vars` block with the desired scope, then compute it in a math block:

```
---vars
delta: 0      # m, folder
---

$$\delta = \frac{F L^3}{48 E I} = <<delta = F * L**3 / (48 * E * I):.5f>>\ \text{m}$$
```

`delta` stays folder-scoped on every re-render rather than resetting to global.

### Error display

Undefined variables render as `? expr` in red. Fix by defining the variable in a `---vars` block.

---

## Feature 4 — Variable Store sidebar

Open with the **Σ** ribbon icon, or **Ctrl+Shift+P → "Engineer: Open Variable Store"**.

### Context banner

The banner at the top shows the active file and its folder. The panel automatically updates when you switch files (including `.engsheet` files) and only shows variables **visible from the currently active file**.

### Sections

Variables are organized by scope, reflecting exactly what is accessible from the active file:

| Section | Icon | Contents |
|---------|------|----------|
| **File** | 📄 | Variables scoped to this file only (`file`) |
| **Folder** | 📁 | Variables scoped to the same folder (`folder`) |
| **Path** | 📂 | Variables scoped to ancestor folders |
| **Tag** | 🏷 | Variables visible via shared tags (`tag:name`) |
| **Global** | 🌐 | All vault-wide variables, grouped by source file |
| **User overrides** | ✏ | Values you have manually changed in the panel |
| **Orphaned** | ⚠ | Variables whose source file has been deleted |

All sections are collapsible. Use **Settings → Engineer → Variable Panel sections** to hide sections you don't need.

### Clicking a variable name

Opens the source file.

### Clicking a variable value

Opens an inline editor. Press **Enter** to override the value temporarily — all math blocks update. Press **Escape** to cancel. Overrides are shown in the ✏ section and can be removed with ✕.

### ↺ Refresh button

Re-parses all `---vars` blocks across the vault. Run once after first install.

### + Add button

Opens a dialog to define a temporary variable without editing any file. Useful for "what if" calculations. Set name, value, unit, and scope.

### Search

Filters by variable name or value across all visible sections.

---

## Feature 5 — Engineering spreadsheet files (`.engsheet`)

Full Excel-like spreadsheet files with a dedicated editor. Create one with **Ctrl+Shift+P → "Engineer: New engineering spreadsheet"**.

### File format

`.engsheet` files are JSON — inspect or version-control them like any file.

### Interface

| Area | Description |
|------|-------------|
| **Name box** | Shows active cell address (e.g. `B3`). Type an address and press Enter to jump. |
| **Formula bar** | Shows the raw formula or value of the active cell. |
| **Toolbar** | Bold, Italic, Underline, alignment, text/background color, number format. |
| **Sheet tabs** | Switch sheets, add/rename/delete. Right-click a tab for options. |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Arrow keys | Move selection |
| Enter / Shift+Enter | Move down / up |
| Tab / Shift+Tab | Move right / left |
| F2 or double-click | Start editing |
| Escape | Cancel edit |
| Delete / Backspace | Clear cell |
| Ctrl+C / X / V | Copy / Cut / Paste |
| Ctrl+B / I / U | Bold / Italic / Underline |
| Ctrl+S | Save immediately |

### Formula syntax

| Syntax | Description |
|--------|-------------|
| `=A1 + B2` | Cell references |
| `=SUM(A1:A10)` | HyperFormula built-in functions |
| `=STORE("varname")` | Read a variable from the Variable Store |
| `=EXPORT(expr, "varname")` | Evaluate and write to the Variable Store (global) |
| `=EXPORT(expr, "varname", "scope")` | Write with explicit scope |

### STORE — reading variables

`=STORE("varname")` resolves the variable according to the `.engsheet` file's own location and tags — the same scope rules that apply to markdown notes. A folder-scoped variable from another file in the same folder is visible; one from a different folder is not.

### EXPORT — writing variables

`=EXPORT(expression, "varname", "scope")` evaluates the expression and writes the result to the Variable Store after each recalculation. The `scope` argument is optional and defaults to `global`.

| Syntax | Scope |
|--------|-------|
| `=EXPORT(A1*E, "force")` | Global — visible to all notes |
| `=EXPORT(A1, "E", "folder")` | Folder — visible to notes in the same folder as the `.engsheet` |
| `=EXPORT(A1, "E", "folder:projects/bridge")` | Folder — visible to notes anywhere under `projects/bridge/` |
| `=EXPORT(A1, "E", "tag")` | Tag — scoped to the `.engsheet`'s own frontmatter tags |

> **Note:** File scope is not available for EXPORT — use cell references for data that should stay inside the spreadsheet.

When an EXPORT formula is deleted or the cell is cleared, the variable is automatically removed from the store on the next recalculation.

---

## Feature 6 — Python code fence (`python`)

Run Python directly in Obsidian using your system Python installation. Click **▶ Run** to execute.

> **Requirement:** Python 3 must be installed and available on your system PATH.  
> All packages installed via `pip` are available — numpy, scipy, sympy, etc.

### Basic example

````markdown
```python
import numpy as np

# Store variables (E, I, F, L) are auto-injected as Python globals
delta = F * L**3 / (48 * E * I)
sigma_max = M * c / I

print(f"δ = {delta:.4f} m")
print(f"σ_max = {sigma_max:.2e} Pa")
```
````

`print()` output appears below the code block. Variables computed inside the block stay local to Python unless explicitly exported.

### Exporting variables to the store

Only variables listed in an `# export` directive are written to the Variable Store. If there is no `# export` directive, nothing is stored.

```python
# export: delta, sigma_max
delta = F * L**3 / (48 * E * I)
sigma_max = M * c / I
```

### Export with scope

| Directive | Scope |
|-----------|-------|
| `# export: var1, var2` | Global — visible to all notes |
| `# export(folder): var1, var2` | Folder — visible to notes in the same folder as this note |
| `# export(tag:tagname): var1, var2` | Tag — visible to notes sharing the specified tag |

Example:

````markdown
```python
# export(folder): delta, sigma_max
import numpy as np

delta = F * L**3 / (48 * E * I)
sigma_max = M * c / I

print(f"δ = {delta:.4f} m")
```
````

### Cleanup

When you remove a variable from the `# export` list and press **▶ Run** again, that variable is automatically removed from the store. Stale exports do not persist across runs.

### Store injection

All variables visible to the current note (respecting scope — folder, tag, global) are injected as Python globals before execution. You can use them directly without importing:

```python
# E, I, F, L from ---vars blocks are available immediately
moment = F * L / 4
```

### Output

`print()` output appears below the code block. Exported variables are shown in a summary table after the output.

### How it works

The plugin writes a temporary `.py` script containing:
1. Variable Store values injected as Python assignments
2. Your code
3. An export postamble that serializes exported variables to JSON

The script is executed with your system Python via `execFile`, output is captured, and the temp files are deleted.

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
| `---vars` block | `E: 200e9 # Pa, folder` or `E: 200e9 # Pa, folder:projects/bridge` |
| `.engsheet` EXPORT | `=EXPORT(A1, "E", "folder")` or `=EXPORT(A1, "E", "folder:projects/bridge")` |
| Python block | `# export(folder): delta` |

---

## Persistence

The variable store is saved to:
```
<your vault>/.obsidian/engineer-vars.json
```

Only user-override variables (set via the sidebar) are persisted — all file-sourced variables are re-parsed from `---vars` blocks on startup. Ghost entries whose source files no longer exist are pruned automatically.

---

## Settings

**Settings → Community Plugins → Engineer (⚙)**

### Variable Store

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-save interval | 30 s | How often the store is flushed to disk. 0 = on unload only. |
| Parse on startup | On | Parse all `---vars` blocks when Obsidian opens. |

### Variable Panel sections

Toggle individual sections in the sidebar on or off:

| Toggle | Description |
|--------|-------------|
| File | Variables scoped to the active note (`file`) |
| Folder | Variables scoped to the same folder |
| Path | Variables scoped to ancestor folders |
| Tag | Variables scoped by shared tag |
| Global | Vault-wide variables |

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
→ The variable is not visible from this file. Check the scope — a `file`-scoped variable from another note is not accessible here. Check spelling (case-sensitive). Use the sidebar to verify the variable is in the correct section.

**Inline `$<<F>>$` not rendering — shows literal text**
→ Click ↺ Refresh to populate the source cache, then switch to Reading View (Ctrl+E).

**Variable Store sidebar is empty on startup**
→ Click ↺ Refresh. If Parse on startup is on, variables load ~1–2 s after Obsidian opens.

**Variable Panel shows no variables but I defined some**
→ Check the context banner — it shows which file is active. Variables scoped to `file` only show when that file is active. `folder`-scoped variables only show when you are in the same folder. `.engsheet` files are now fully supported as the active context in the panel.

**Folder-scoped EXPORT not visible in panel**
→ The panel uses the active file's location to filter scope. If the active file is in a different folder, folder-scoped variables from the `.engsheet` won't appear. Switch to a file in the same folder to see them.

**Python fence shows "Python 3 not found on PATH"**
→ Install Python 3 from python.org. On Windows, check "Add Python to PATH" during installation. Then reload the plugin.

**Python fence output is empty**
→ Add `print()` statements to your code. Expressions alone (like `delta = ...`) produce no output.

**Python variable still in store after removing `# export:`**
→ Press **▶ Run** again. The cleanup runs on each successful execution, removing variables that are no longer in the export list.

**`.engsheet` formula shows `#NAME?` or `#REF!`**
→ The formula uses an unrecognized function or invalid cell reference. For store access use `=STORE("varname")`.

**EXPORT variable disappears after editing other cells**
→ If the referenced cell is empty, the EXPORT value is not updated but the variable name is preserved in the store. Populate the referenced cell to restore the value.

---

## Development status

### ✅ Phase 1 — Variable Store + Math

- `---vars` blocks with mathjs expression evaluation
- `emath` code fence with `<<...>>` substitution
- Inline `$<<...>>$` math with format specifiers
- Multi-scope variable system: File, Folder (with explicit path), Tag, Global
- Multi-entry store: same variable name can exist at different scopes in different files
- Variable Store sidebar: scope sections, delete, search, value override editor
- Scope-aware panel: updates when switching between markdown notes and `.engsheet` files
- Persistence with ghost-entry cleanup on startup

### ✅ Phase 2 — Spreadsheets

- `.engsheet` file type: full Excel-like editor with HyperFormula
- Formula bar, multi-sheet tabs, column/row operations, clipboard, formatting
- `=STORE("varname")` — scope-aware store reads
- `=EXPORT(expr, "varname", "scope")` — store writes with global, folder, `folder:path`, or tag scope
- Stale export cleanup when EXPORT formulas are removed

### ✅ Phase 3 — Python execution

- `python` code fence with execution via system Python
- Scope-aware variable injection: only variables visible to the current note are injected
- No automatic export — variables stay local unless explicitly listed
- `# export: var1, var2` — global export
- `# export(folder): var1` — folder-scoped export
- `# export(tag:name): var1` — tag-scoped export
- Stale export cleanup on each run
- `print()` output rendered inline; exported variables shown in summary table

### 📋 Phase 4 — Advanced features (planned)

- Undo/redo for `.engsheet`
- Dependency graph: visual map of which files use which variables
- Unit tracking and dimensional analysis
- PDF export with computed values baked in
