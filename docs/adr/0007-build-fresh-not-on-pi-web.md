# Build a new web client rather than extending an existing pi web UI

Several community web UIs for pi already exist, `jmfederico/pi-web` most notably, and we
are not building on any of them.

They are session managers — parallel sessions, terminals, git worktrees, remote
federation — which is a superset of our surface pointing in a different direction. Our
differentiator is a document model, and grafting one onto an architecture organised around
live sessions means fighting its core abstraction exactly where our value lives. Reading
their source is cheap and worthwhile, particularly `pi-web` for surviving browser
disconnects and `pi-web-ui` for SDK wiring; inheriting their architecture is not.

## Consequences

We carry the cost of building session ownership, streaming, and reconnection ourselves,
having chosen not to reuse working implementations. This is also a live competitive risk:
if one of these projects ships a credible document model first, our wedge narrows sharply.
