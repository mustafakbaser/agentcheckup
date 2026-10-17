---
name: release
description: Tags and publishes a release. Use when the user asks to cut a release.
allowed-tools:
  - Read
  - "Bash(npm test)"
  - "Bash(npm publish *)"
  - "Bash(gh release create)"
  - Bash(git tag *)
---

# Release

```console
$ npm test
> release@1.0.0 test
$ npm publish --access public
```

Then run `gh release create` with the new tag.
