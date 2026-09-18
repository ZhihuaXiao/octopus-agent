# 19 — Remote attach: binding policy and authentication

**What to build:** The server can be reached from another machine, but only deliberately.
Binding beyond loopback requires an explicit flag whose help text states the consequence,
and a connection authenticates with either a token generated at startup or a stored
password. There is one account and no sandbox; see ADR-0006.

**Blocked by:** 15

**Status:** done

- [x] Without the explicit flag the server refuses to bind beyond loopback
- [x] The flag's help text states plainly that exposing the port grants arbitrary code execution as the server's user
- [x] A token is generated at startup and printed as a complete URL
- [x] A password can be set instead, stored with a memory-hard hash, with attempts rate limited
- [x] Unauthenticated requests and WebSocket upgrades are rejected
- [x] Documentation describes SSH tunnelling as the recommended way to reach a remote machine

## Comments

**The flag is `--host`, and the server binds what it is given and nothing else.** `octo --web`
binds `127.0.0.1` as before; `octo --web --host 0.0.0.0` (or an interface's address, or `::`)
binds that, and `ServerOptions` grew `host` to carry it — the option itself is the deliberate
act, so the server does not second-guess it, and the launcher sets it only when the flag was
written. The usage says, under `--host`, that anyone who reaches that port and authenticates
can run arbitrary code as the user running octo, that there is one account and no sandbox,
and that an SSH tunnel to the loopback port is the way to prefer; `octo.ts` says it again at
startup, with the user's name filled in, on the one occasion it is true. An IPv6 host is
written in brackets in the URL, since a browser reads no other spelling. The test finds one of
the machine's other addresses, as ticket 14's did to prove a refusal, and now also binds it
and is answered there.

**Authenticating is presenting the one credential, and being given a Connection.** There is
one account (ADR-0006) and it is proved one of two ways. Without `--password`, the server
generates a 256-bit token for this start and `RunningServer.url` — the URL `octo --web`
prints — carries it as `?token=…`, so following the URL is all the authenticating there is:
`GET /?token=…` checks it, opens a Connection, and answers `303 /` with the Connection's id
as a cookie — `octo_connection`, `HttpOnly`, `SameSite=Strict`, `Path=/` — so the token is
out of the address bar and the history before the shell has loaded, and the cookie goes on
every request and every WebSocket upgrade from then on with no help from the client. A
script presents the token as `Authorization: Bearer` on each request instead, and opens
nothing. With `--password`, the URL has no token and the shell asks for the password, which
`POST /api/connect` `{ "password": "…" }` takes and answers `204` with the same cookie; the
route also takes `{ "token": "…" }`, for a token pasted into the shell. The Connection is
an id the server holds in memory until it stops: after a restart the browser is asked again,
which in token mode means the new URL and in password mode the password — the glossary's
Connection now says as much. The alternative was to make the token itself the cookie, which
would have had the credential in every request and no way to have it travel once; or a
bearer on every request from the client, which would have put the token in every WebSocket
URL and the client's storage. `SameSite=Strict` is what keeps a page on another site from
sending the cookie with a request or a socket of its own; the server sets no CORS headers, so
a cross-site `fetch` cannot read an answer either. All of `/api/` and the upgrade take only
an authenticated request — `401` with `{ "authenticate": "token" | "password" }`, since the
shell has to know what to ask for, and `401` on the upgrade — checked before a route is
matched, so an unauthenticated request learns nothing, not even that a session id exists.
The shell itself, `/` and `/client/*`, is served to anyone: it is where a browser
authenticates, and it holds nothing but our own three files. `src/server/auth.ts` is all of
this behind `createAuth({ storedPassword? })`: `attempt(credential)`, `connect()`, `connected(id)`.

**The password is scrypt's, and a wrong guess waits.** `octo password` asks for it twice at
the terminal without echoing — raw mode, with Ctrl-C giving up — or reads one line from a
pipe, and `src/server/password.ts` stores it as `scrypt$N$r$p$salt$hash` in
`~/.octo/password`, mode 0600, N = 2^17, r = 8, p = 1 as OWASP puts it: about 128 MiB and a
third of a second a hash, which presenting the password can spend and a guess must. scrypt rather than
argon2id, both of which the spec allows, because scrypt is in Node's `crypto` on every Node
the package runs on and argon2 would be a native dependency or a Node newer than the engine
pinned; the stored line names the function and its parameters, so either can change without
every stored password going stale at once. The file is the user's, not a project's — one
account, one password, wherever `octo --web` is started from — and `readStoredPassword` and
`storePassword` take a path so the tests use a temporary one. `octo --web --password` with
no password stored is a sentence saying to run `octo password` first. Password attempts are rate
limited by making each failure in a row double the wait before the next attempt is looked at
— one second, then two, four, up to a minute — answered `429` with `Retry-After` and a plain
sentence, and forgotten on a success. One counter for the server rather than one per address,
since one account is being guessed at and every connection through a tunnel arrives from one
address anyway; the cost is that a stranger hammering the port can hold the wait open, for
at most a minute at a time. A cookie the server does not know is not a guess and costs
nothing, so a browser from before a restart is simply asked again; a wrong password is a
guess, and a wrong token is simply refused — it cannot be guessed at, and treating one as
a guess would make a stale bookmark hold up the URL this start printed.

**The client connects when told to, and carries on.** Every request the page makes goes
through one `request()`, and a `401` shows a panel — "This server takes the token it printed
when it started…" or "…the password set with `octo password`" as the answer says — and
waits; the refused request is made again once `/api/connect` has answered with the cookie, and
every request refused meanwhile waits on the same panel. This is what makes a restart in
password mode a password prompt and then the catch-up ticket 18 built: the socket closes,
`reconnect` reopens the Notebook by path, is told `401`, waits on the panel, and then
connects with `since` as before. A socket refused for want of a cookie needs nothing of its
own, since the cookie is the browser's to send with the upgrade. Still plain files, still
checked rather than compiled. Walked in a browser against a server over a temporary
directory: the bare URL shows the panel in token mode, with the right words and label; the
printed URL opens a Connection, leaves the token, and lists the notebooks, and opening one
shows the Author View; password mode shows its panel, with the right words and label. The
form's submit was not typed into — the automated browser refused a field that takes a
credential — and rests on the server tests of the route it calls.

**Tested at the server seam, and the launcher's.** `server.test.ts` now authenticates every
request as the client would — the token read off `server.url`, sent as a bearer, and on the
socket's upgrade — and gained "authenticating with the token": the token's shape and that
two servers differ, `401` and its body for a read and a write without it and nothing looked
at, the bearer taken, another server's refused, the URL followed opening a Connection whose
cookie is then taken on the API and the socket and sending the browser on to `/`, an old
URL sending it on with nothing, a made-up cookie refused, an upgrade refused without and
with a wrong bearer and taken with the cookie, a pasted token, a stale token not holding up
the printed URL, and the shell served to anyone.
"Authenticating with the password" hashes the password once and starts servers with it: a URL
with no token, `401` saying `password`, the password opening a Connection that then opens a
Notebook Session and its socket, a wrong password, a token and a bearer refused in its place, the wait
after a wrong guess and its doubling, the next attempt looked at once the wait is over and the
waits forgotten on success, and only a body presenting one credential taken. `password.test.ts`
is the small seam beneath: the stored line's shape, verification and its refusals, a fresh
salt each time, an unreadable line, and the file written 0600 and read back. `launcher.test.ts`
reads `--host` and `--password`, the usage's wording, and the `password` word. The suite takes
about three seconds longer: a hash is made to take a moment, and the waits are real.

**Left where it was.** The Connection lives in memory, so a restart asks every browser to
authenticate again; a token changes with the start in any case, and a password is one prompt.
A Connection is held until the server stops; nothing ends one earlier. The rate limit is one counter, as said above. The
`401` carries no `WWW-Authenticate`, since there is no scheme for a connect form; a script gets
the JSON body. Plain HTTP is what the server speaks, on loopback or off it — the tunnel
encrypts, and `docs/remote.md` says what `--host` without one means. Two servers over one
directory still each recover the same sessions, as ticket 18 noted; nothing here makes the
second deliberate. The token is in the process's stdout, and so in whatever a supervisor
keeps of it — the reason the docs prefer `--password` for a supervised server. The Connection
id and the token are 32 bytes of `randomBytes` in hex; nothing rotates either.
