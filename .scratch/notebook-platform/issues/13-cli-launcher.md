# 13 — CLI launcher

**What to build:** One command with three behaviours. Invoked bare it hands the terminal to
the real pi, so the terminal experience stays pi's own rather than a reimplementation of
it. A run subcommand executes a notebook headlessly. Web flags dispatch to the server
entry point.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A bare invocation execs pi and the terminal experience is pi's own
- [ ] A run subcommand executes a notebook headlessly as established in ticket 02
- [ ] Web flags, including a port, are parsed and dispatch to the server
- [ ] Unknown flags produce a helpful usage message
