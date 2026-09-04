---
title: Survey
inputs:
  - name: target
    type: string
    default: src
    description: The directory to survey
---

Three readings of the same code, each in a context of its own. They declare no edge between
one another, so they run at the same time, and each is isolated, so no reading is coloured
by what the others found.

An isolated cell hands its work on through the workspace rather than through the shared
context, which is why each reading writes a note and the summary goes and reads them. The
summary is not isolated, so it runs in the notebook's shared context, and it waits for all
three readings because it says it uses them.

Run it with `npm run notebook -- examples/survey.md --target src`.

```bash id=scope
mkdir -p findings
echo "Surveying {{target}}"
```

```prompt id=naming isolated uses=scope
Read {{target}} and write one sentence on whether its names are consistent to
findings/naming.md.
```

```prompt id=tests isolated uses=scope
Read {{target}} and write one sentence on whether its tests look thorough to
findings/tests.md.
```

```prompt id=comments isolated uses=scope
Read {{target}} and write one sentence on whether its comments earn their place to
findings/comments.md.
```

```prompt id=summary uses=naming,tests,comments
Read the notes in findings/ and summarise them as three bullet points.
```
