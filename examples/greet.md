---
title: Greet
inputs:
  - name: name
    type: string
    default: world
    description: Who to greet
---

One notebook, many cases: the declared input is referenced in both kinds of cell, and the
command line supplies it.

Run it with `npm run octo -- run examples/greet.md --name Ada`.

```bash id=announce
echo "Greeting {{name}}"
```

```prompt id=greet
Say hello to {{name}} in one short sentence.
```
