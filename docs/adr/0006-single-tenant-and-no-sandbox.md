# Single-tenant, and no part of this is a security boundary

The server serves exactly one account. There is no user table, no per-user isolation, and
no quota or audit system. Anyone who authenticates gets arbitrary code execution as the
user running the server.

This follows from pi, which ships no sandbox and no permission system by deliberate design.
Since we cannot contain what the agent does, offering multiple identities would imply an
isolation guarantee we are unable to honour — worse than not offering it at all. So the
server binds to loopback unless an explicit flag says otherwise, that flag's help text
states the consequence plainly, and SSH tunnelling is the documented way to reach a remote
machine.

## Consequences

A Mode's tool allowlist is a usability choice and must never be presented as a
restriction — the UI must not imply the browser is a sandbox. Multi-user support is not a
feature we have deferred; it is a different product that would need containment we do not
have.
