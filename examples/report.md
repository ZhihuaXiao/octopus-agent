---
title: Report
inputs:
  - name: target
    type: string
    default: src
    description: The directory to report on
---

A report, and the files behind it. Every cell has a directory of its own for what it
produces, written `{{artifacts}}` in its body, and whatever a cell leaves there is recorded
by path beside the run record rather than pasted into this document (ADR-0005). The count is
deterministic, so it is a bash cell and costs nothing; the summary is the cell worth the
notebook's model; and the headline names a smaller model of its own, since a one-line title
does not need what the summary did. Swap that model for one your machine has a key for.

The directory's path is wherever this notebook lives, so a bash cell quotes it as it would
any path it did not choose.

Run it with `npm run octo -- run examples/report.md --target src`.

```bash id=count
find {{target}} -type f | wc -l > "{{artifacts}}/count.txt"
cat "{{artifacts}}/count.txt"
```

```prompt id=summary uses=count
Read {{target}} and write a short summary of what it does to {{artifacts}}/summary.md, then
reply with one sentence saying what you wrote.
```

```prompt id=headline uses=summary model=anthropic/claude-haiku-4-5
Give the summary you just wrote a one-line headline, and reply with just the headline.
```
