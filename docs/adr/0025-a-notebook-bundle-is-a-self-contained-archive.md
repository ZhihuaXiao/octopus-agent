# A Notebook Bundle is a self-contained archive of its runs and sessions

A Notebook Bundle (`.octo.zip`) packages a Notebook file with its entire run history, cell
artifacts, and associated agent session files into a single, self-contained zip archive. When
imported into another workspace or machine, it unpacks the notebook and its runs under `.octo/runs/`,
and rewrites all internal file paths and session links to resolve to local destinations. The source
archive is read and unpacked; existing workspace sessions are never overwritten without explicit confirmation.

This complements ADR-0023. An HTML or Markdown export provides a static document for someone who
will not run the notebook; a bundle provides the complete reproducible, resumable environment so
another user or machine can inspect past rounds and fork from existing anchors.

## Considered Options

**Exporting only the Notebook Markdown file** would share the code but lose the answers, cell
artifacts, and anchor graph. A recipient would have to re-run every cell from scratch, spending tokens
again and potentially failing on missing preconditions.

**Exporting only the latest run** would discard intermediate branches and past anchors. A notebook's
provenance often spans multiple runs and iterations, and pruning runs would complicate dependency
tracking for continued runs (`record.continues`).

**Unpacking session files into host `~/.pi/agent/sessions/`** would leak notebook agent sessions into
the destination user's interactive CLI chats list, which ticket 21 and ADR-0022 worked to keep separate.
It would also risk collision with existing session IDs in the host's session directory.

**Relative paths inside `record.json`** would require touching every subsystem in the codebase
(the runner, rounds reader, journal, and server) that expects absolute resolved filesystem paths.
Rewriting absolute paths to the new local workspace at the moment of unpack keeps the runtime contract
intact without regressions.

**Relying on system `zip` and `unzip` binaries** would introduce platform dependencies and fail
in minimal environments such as lightweight containers or Windows. Using a zero-dependency, pure-TypeScript
engine (`fflate`) ensures identical, cross-platform archive handling.

## Consequences

A bundle file is named `<stem>.octo.zip`. It is a valid PKZIP archive containing:
- `manifest.json`: Root metadata containing `formatVersion`, `octoVersion`, `createdAt`, `originalNotebook`, `title`, and `runCount`.
- `notebook.md`: The notebook markdown file.
- `runs/<run-id>/`: Run records (`record.json`), artifacts (`artifacts/<cell-id>/...`), shared session (`session.jsonl`), and isolated prompt cell sessions (`sessions/<cell-id>.jsonl`).

Unpacking applies strict sandbox validation against Zip Slip attacks: entries with `..`, absolute paths,
or paths pointing outside `notebook.md` and `runs/` are unconditionally rejected.

All extracted session files live strictly within `.octo/runs/<target_stem>/...`. They are never extracted into
`~/.pi/agent/sessions/`, ensuring they never appear in CLI chats or interfere with host terminal work.

On import, `record.notebook`, `record.agentSession`, and `cell.agentSession` are rewritten to point to the local
destination paths. When the imported notebook is resumed or run, `createPiAgent` automatically passes the
destination workspace as `cwdOverride`, allowing seamless anchoring and forking on the new machine.

Collisions are refused by default: if the destination notebook or its runs directory already exists,
the import rejects the operation unless an alternate target name is provided or overwrite is explicitly forced.
The web interface inspects the manifest first, presenting the user with an import preview and destination input
with real-time collision detection.
