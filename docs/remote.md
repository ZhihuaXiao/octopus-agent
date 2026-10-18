# Reaching octo on another machine

`octo --web` serves the notebooks under the current directory to a browser. Whoever
authenticates to it can run arbitrary code as the user that started it: a Prompt Cell is
an agent with the user's tools, a Bash Cell is a shell command, and there is no sandbox
(ADR-0006). So the server binds loopback — `127.0.0.1` — and nothing else unless told to,
and every request to it authenticates.

## The recommended way: an SSH tunnel

Leave the server on loopback and bring the port to your laptop with SSH. On the remote
machine:

```sh
cd ~/work/reports
octo --web
```

It prints the URL to open, with a token generated for this start:

```
Serving the notebooks under /home/ada/work/reports
Open http://127.0.0.1:8008/?token=3f9c…
```

On your laptop, forward a local port to the remote machine's loopback port:

```sh
ssh -N -L 8008:127.0.0.1:8008 ada@remote.example
```

and open the printed URL in your browser as it stands: `127.0.0.1:8008` on your laptop is
now the server's loopback port. Following the URL opens a Connection, the token leaves the
address bar, and the browser carries a cookie from then on. Nothing is listening on the
remote machine's network address, SSH is doing the authenticating and encrypting it
already does, and the token adds a second lock.

Close the browser and the work carries on; come back, and the page picks up where it left
(ticket 18). Restart the server and it prints a new URL; the old token is worthless.

## A password instead of the token

A token changes with every start, which is right for a server started by hand and
awkward for one that a supervisor starts. Set a password once:

```sh
octo password
```

It is asked for twice, not echoed, and stored as a memory-hard hash (scrypt) under
`~/.octo/password`, readable only by you. Then start the server with the flag alone:

```sh
octo --web --password
```

`--password` does not take the password as its next word. This is rejected:

```sh
octo --web --host 0.0.0.0 --port 8080 --password secret
```

`secret` is a stray argument. The password was never read from that command, and it
would otherwise sit in the shell history. Set it with `octo password`, then:

```sh
octo --web --host 0.0.0.0 --port 8080 --password
```

From a checkout the same two steps are `node dist/cli/octo.js password` and
`node dist/cli/octo.js --web --host 0.0.0.0 --port 8080 --password`.

The URL printed has no token; the browser asks for the password. A wrong guess makes the
next attempt wait — a second, then two, four, eight, up to a minute — so a password cannot
be tried at the rate the network allows.

## Binding beyond loopback

If a tunnel is not possible, `--host` binds another address:

```sh
octo --web --host 0.0.0.0 --password
```

From a checkout, `npm run octo --web --host 0.0.0.0 --port 9000 --password` does the same, with
or without a `--` after `octo`. `--host` other than `127.0.0.1`, `::1`, or `localhost` without
`--password` is refused: a startup token in a cleartext URL would stay valid until the process
exits. Loopback still starts with a token when `--password` is left out.

Bound to `0.0.0.0` or `::`, it prints a URL for each of the machine's network addresses as well
as the loopback one. Open whichever the other machine can reach. A public address in front of
the machine is accepted even when it is not assigned to a local interface, so
`http://122.34.56.78:8080` opens the page. A hostname that is not an IP address does not: the
page says "This server does not answer for that host." Restart the server after changing
`--host` or `--password`. A process that is already running keeps the rules it started with.

Read the warning it prints. Anyone who can reach that port and knows the password can run
arbitrary code as you, and the connection is plain HTTP: the password travels in the clear, as
does everything the agent says and does. Put a TLS terminator in front of it, or use a private
network you trust.

By default a notebook's workspace has to stay under the directory the server was started in.
`--cell-access user` allows any directory that account can already reach, which is what a
headless `octo run` does unless told otherwise. `--cell-access /path` (repeat the flag for
another directory) names the range.

There is one account. Two people who both know the password are the same user to the
server, and to the machine.
