# Output format

Put findings first, ordered by severity. Every confirmed finding must include exact file/line references and a concise explanation of impact. Distinguish confirmed findings, open questions/assumptions, optional suggestions, and residual risks.

For audit-flow synthesis, a finding is not confirmed until at least two separately recorded reviewer runs report the target evidence. Reviewer reports should make provenance clear: identify which findings you corroborated from the target, which are new and therefore need another reviewer, and which you dispute or could not verify.

The peer workflow is intended to limit the raw-target run to its fixed generated prompt and repository evidence. Any later primary-report critique is a separate run and artifact. The final-diff report is a separate adversarial review of the whole frozen target; it does not automatically confirm earlier findings, and any new finding it introduces still needs the normal two-reviewer verification gate.
