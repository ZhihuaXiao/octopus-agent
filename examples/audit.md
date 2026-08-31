---
title: Audit
inputs:
  - name: target
    type: string
    default: src
    description: The directory to audit
---

Written conclusion first, the way a report is read rather than the way it is produced. The
`uses` edges say what has to happen before what, so the cells run bottom-up while the
document stays in the order a person wants to read it.

Run it with `npm run notebook -- examples/audit.md --target src`.

```prompt id=report uses=review
Write the review up as three bullet points.
```

```prompt id=review uses=scope
Review {{target}} and say whether anything looks alarming.
```

```bash id=scope
echo "Auditing {{target}}"
```
