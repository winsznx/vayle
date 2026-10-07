# Repo guard

`@vayle/repo-guard` keeps private names and private paths out of this public repository. It scans text for terms on two private name lists, for references into the private docs folder at the repo root, which git ignores, and for values in `.env.example`, which may only list keys. The commit hooks in `.githooks` run it on every commit and push, `pnpm guard` runs it over the tree, and CI runs it on every push and pull request. [SETUP.md](../../SETUP.md#commit-hooks) covers the hooks from a contributor's side.

## Modes

| Mode             | Run by              | Scans                                                                                       |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `staged`         | the pre-commit hook | Staged files, as staged                                                                     |
| `message <file>` | the commit-msg hook | The commit message, without git's comment lines                                             |
| `push`           | the pre-push hook   | Branch names, and the messages of every commit the push would publish                       |
| `tree`           | `pnpm guard`        | Every tracked file in the working tree                                                      |
| `history`        | by hand             | Every version of every file any commit on any ref has held, every commit message and branch |
| `ci`             | CI                  | Tracked files, every commit message, the branch name and the pull request's title and body  |

Run `history` with `node packages/repo-guard/src/cli.ts history` before a repository goes public, since anything ever committed stays readable from its history. It reports a finding at the blob that holds it, under the first path that blob appeared at.

A fail-list match blocks. It's case-insensitive, can't touch a letter or digit on either side, and lets the words of a multi-word term be joined by spaces, hyphens, underscores or nothing. A warn-list match uses the same boundaries in exact casing and only prints a warning. File names are scanned too. Name checks skip `pnpm-lock.yaml` and generated output, like `node_modules`, `dist` and the contracts' build folders, and the path check never skips anything. Binary files are listed instead of scanned.

The lists aren't in the repository. Locally the guard reads them from the files `VAYLE_DENYLIST` and `VAYLE_DENYLIST_COMMON` name when those are set, and from the private docs folder otherwise. A missing list only skips its own name checks, with a note saying so. In `ci` mode both lists are required, and a missing or empty one fails with `MissingNameListSecret`. CI logs are public, so that mode masks every term before any output and reports a hit by its position in the list.

It exits 0 when nothing blocks, 1 on a blocking finding, and 2 on a usage error or a failure like `NotAGitRepo` or `MalformedNameList`. It has no dependencies and runs its TypeScript directly on Node 24 or newer, which `.githooks/run-guard` checks before it starts. `pnpm install` points git at `.githooks`.

## Tests

```sh
pnpm --filter @vayle/repo-guard test
```

The hook tests run the real hooks in throwaway git repositories with made-up names. The rest cover term matching, list loading, scanning and push parsing on their own.
