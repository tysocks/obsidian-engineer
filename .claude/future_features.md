# Future Features

## Auto-detect undefined variable references

When a `---vars` block or `emath` fence references a variable that does not exist in the store,
automatically surface a suggestion to define it — either via a Notice, an inline decoration, or
a right-click quick-fix. This removes the need for the user to manually hunt for the missing
definition and can link directly to "Insert variable definition" pre-filled with the variable name.

**Discussed:** 2026-04-19  
**Status:** Deferred — implement after core variable-store UX is stable.
