# Third-party notices

This repository vendors selected skills from [`mattpocock/skills`](https://github.com/mattpocock/skills):

- `skills/grill-with-docs`
- `skills/diagnose`
- `skills/improve-codebase-architecture`
- `skills/tdd`
- `skills/to-prd`

These were adapted for Claude Code (for example, removing Pi-specific slash-command references). Those files are licensed under the MIT License:

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Superpowers

This repository vendors selected skills from [`obra/superpowers`](https://github.com/obra/superpowers), pinned to release `v6.4.1` (commit `5bf4e78011075bcfc0dc295f0724994cd123ee71`):

- `skills/brainstorming` (without the browser-based visual companion)
- `skills/writing-plans`
- `skills/verification-before-completion`
- `skills/dispatching-parallel-agents`
- `skills/receiving-code-review`

Some files were adapted for this plugin (model-pinned agent dispatch, routing to `dev-setup` skills and agents, and approval before GitHub replies). [`vendor/superpowers.lock.json`](vendor/superpowers.lock.json) records every vendored file with its upstream source and hashes, marks each adapted file, and lists the adaptations; each adapted file carries `dev-setup adaptation` comments. The upstream license is kept at [`vendor/superpowers-LICENSE`](vendor/superpowers-LICENSE). Those files are licensed under the MIT License:

```text
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
