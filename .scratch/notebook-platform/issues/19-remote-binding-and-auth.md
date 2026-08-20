# 19 — Remote attach: binding policy and authentication

**What to build:** The server can be reached from another machine, but only deliberately.
Binding beyond loopback requires an explicit flag whose help text states the consequence,
and a connection authenticates with either a token generated at startup or a stored
password. There is one account and no sandbox; see ADR-0006.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] Without the explicit flag the server refuses to bind beyond loopback
- [ ] The flag's help text states plainly that exposing the port grants arbitrary code execution as the server's user
- [ ] A token is generated at startup and printed as a complete URL
- [ ] A password can be set instead, stored with a memory-hard hash, with attempts rate limited
- [ ] Unauthenticated requests and WebSocket upgrades are rejected
- [ ] Documentation describes SSH tunnelling as the recommended way to reach a remote machine
