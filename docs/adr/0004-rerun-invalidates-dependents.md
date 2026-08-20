# Re-running a Cell marks dependents Stale rather than re-running or discarding them

When a Cell runs again, every Cell reachable from it in the Graph is marked Stale. Nothing
downstream runs automatically, and nothing downstream is thrown away.

## Considered Options

**Cascading** — automatically re-running dependents — is unsafe because an agent Cell's
work is frequently a partial success with side effects already applied to disk, and
re-running on top of that corrupts a Workspace. **Truncating** — discarding everything
below the fork point, which is what a pure branch operation would do — destroys work the
author may still want. Marking Stale is the only option that is both safe and lossless, and
it is the fix for the out-of-order-execution confusion that has dogged Jupyter since the
beginning.

## Consequences

Staleness follows Graph edges rather than position in the document, which means an Isolated
Cell with no Dependencies on the changed Cell stays valid. That in turn is what makes
Isolated Cells worth having, and it is why the Graph must exist at all.
