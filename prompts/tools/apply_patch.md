## `apply_patch`

`apply_patch(patch)`

Apply a structured multi-file patch. Use this for:

- Multiple edits in one file
- Coordinated edits across files
- Appending to large files in chunks

Recommended workflow for large file generation:

- Start the file with `write_file`
- Then use `apply_patch` to append additional sections in chunks

Patch syntax:

```text
*** Begin Patch
*** Update File: src/app.ts
@@
-old line
+new line
*** Append File: docs/guide.md
+## Next Section
+More text...
*** Add File: src/new.ts
+export const x = 1;
*** Delete File: src/old.ts
*** End Patch
```
