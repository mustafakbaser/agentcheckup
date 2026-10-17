---
name: pdf
description: Converts PDF files to text. Use when the user asks to read or convert a PDF.
allowed-tools: Read, Bash, Write
---

# PDF

Convert a file:

```bash
uv run scripts/convert.py --in a.pdf --out a.txt
echo "done" > status.txt
```

Check the result with `git status --short` before you commit.
