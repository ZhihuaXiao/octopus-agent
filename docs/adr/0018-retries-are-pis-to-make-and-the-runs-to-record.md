# Retries are pi's to make and the Run's to record

A transient provider or transport error — an overloaded provider, a rate limit, a dropped
connection — is retried by pi, inside the turn, with pi's own budget and backoff. The Run
does not retry anything itself. What it does is record, against the Cell, each attempt pi
gave up on and what that attempt failed with, so a Cell that took three tries to answer does
not read like one that took one. A turn that fails after pi's retries are spent is an errored
Cell, and halts the Run like any other.

## Considered Options

**Retrying in the runner** puts the policy where the rest of failure handling lives and is
easy to test with a scripted agent. It would also be a second retry loop around pi's first:
pi retries a transient error three times with exponential backoff by default, and a runner
that retried the whole turn on top would multiply the wait without adding a class of error
the retry could get past. The only errors that reach the runner are the ones pi has already
given up on, or the ones pi never retries — a missing key, a model that does not exist — and
neither improves with a fourth attempt.

**Disabling pi's retry and owning it outright** removes the double loop but re-implements
what pi already does, and does it worse: pi's classification of what is transient is a list
of provider- and transport-specific messages maintained upstream against every provider pi
supports, and the same list is what pi's own users are getting. A copy here would drift.

**Retrying a Bash Cell** was never on the table. A command that failed did exactly what it was
told and reported it; running it again is a decision for whoever reads the record.

**Recording nothing** — retries as pi's private business — would leave a Cell that took
fourteen seconds longer than usual with no account of why, and a Notebook that failed on a
bad afternoon indistinguishable in its record from one that failed on a bad prompt.

## Consequences

The spec's three failure classes each land where the spec says they should. A provider or
transport error is retried, by pi, and appears in the record. A tool error is the agent's to
recover inside its turn, and the Run never sees it. A turn that ran and did the wrong thing
is undetectable here and is a human's to notice.

The agent boundary reports a turn's retries alongside its text and usage, and a turn that
failed carries them on the failure, since the retries happened inside the agent and only the
agent can say. The scripted agent stands in for pi here as everywhere: a transient failure in
its script is retried by taking the next scripted turn, and the script says how many times.

Pi does not throw when a provider fails: the turn resolves, and its last assistant message
says so. The agent boundary reads that message, because left unread a Cell whose provider was
down would be recorded as having succeeded with nothing to say. It was, until this ticket.

How many times pi retries, and how long it waits, is pi's `retry` setting and is not written
in the Notebook. A Notebook cannot ask for more patience than the machine running it is
configured with, which is the same position ADR-0010 takes on the Declared Environment: the
Notebook says what it needs, and the machine either provides it or the Run says so.
