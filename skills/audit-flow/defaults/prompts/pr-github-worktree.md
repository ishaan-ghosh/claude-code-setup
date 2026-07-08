# PR and GitHub worktree policy

For PR audits, inspect PR metadata, base/head refs, full diff against the PR base, claimed behavior, changed files, and relevant nearby code. Prefer isolated git worktrees for review to avoid disturbing the user's current checkout. For stacked PRs, treat the PR base branch as the review unit by default, separate inherited parent findings from child-specific findings, and document merge-order/base-update risks.
