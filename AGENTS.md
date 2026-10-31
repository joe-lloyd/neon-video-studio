# Agent instructions

## Pull requests

Every change reaches `main` through a pull request. CodeRabbit reviews every pull request that is not a draft.

Open pull requests ready for review. If you opened a draft, run `gh pr ready` once the work is done, because CodeRabbit skips drafts. Then invoke the `babysit-pr` skill and stay on the PR until it merges. Its CodeRabbit section is the process:

- Fix or decline every CodeRabbit finding, then wait for CodeRabbit to review the new head.
- Once CodeRabbit passes the head clean, and any CI the repo runs is green, merge without asking.
- If CodeRabbit still has open findings after three rounds of fixes, stop. Do not merge. Tell the owner directly.
