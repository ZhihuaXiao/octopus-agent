# Notebooks are Markdown, not JSON

A Notebook is a Markdown file — YAML frontmatter for metadata, fenced blocks with
attributes for Cells, ordinary Markdown for Prose — rather than the JSON document `.ipynb`
uses.

## Considered Options

JSON parses trivially and round-trips without effort, which is a real advantage we are
giving up. We chose Markdown because the product's premise is that a Notebook is reviewed
in a pull request like code, and a JSON document is not reviewable by a human. A secondary
benefit is that the agent can read and edit its own Notebooks natively, since they are text
it already understands.

## Consequences

Round-trip fidelity becomes our problem rather than the parser's: editing one Cell in the
browser must not reformat the file, or the reviewability the format exists for is
destroyed. This is the problem Jupytext spent years on. A property test asserting that
parse-then-serialise is byte-identical is required from the first phase.
