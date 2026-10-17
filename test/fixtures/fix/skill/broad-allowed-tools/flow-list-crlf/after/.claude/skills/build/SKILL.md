---
name: build
description: Builds and tests the project. Use when the user asks to build or test.
allowed-tools: [Read, "Bash(make test)", "Bash(cmake *)", Grep]
---

# Build

```sh
make test
cd build && cmake --build . --parallel
```
