# Audit findings schema v1

Findings should have stable IDs and structured status fields from the beginning. The finalizer strictly validates the fields and provenance bindings described below.

```json
{
  "id": "F-001",
  "title": "Run status is not updated when one benchmark job fails",
  "severity": "high",
  "confidence": "confirmed",
  "source": ["primary", "peer"],
  "verification": {
    "required": 2,
    "artifacts": ["primary-initial.md", "peer-review.md"]
  },
  "status": "accepted",
  "target": {
    "repo": "backend",
    "file": "app/services/eval_service.py",
    "line": 214
  },
  "impact": "Multi-job benchmark runs can report success even when a child job fails.",
  "evidence": "The aggregation path only checks completed jobs and ignores failed child statuses.",
  "recommended_action": "fix",
  "github_comment": {
    "mode": "inline",
    "body": "..."
  }
}
```

## Required fields

- `id`: Stable per-audit ID such as `F-001`.
- `title`: Short human-readable finding title.
- `severity`: `critical | high | medium | low`.
- `confidence`: `confirmed | likely | speculative | question`.
- `source`: At least two distinct concrete keys from `audit.yml.reviewers`, such as `primary`, `peer`, or a supplemental key such as `verifier_peer_only`. Generic role names are not accepted. The orchestrator must cite only reviewer runs whose reports contain the finding's target-evidence review.
- `status`: `candidate | unverified | accepted | rejected | deferred | needs_more_info | fixed | partially_fixed | still_open | verified | commented`.
- `impact`: User/product/runtime impact.
- `evidence`: Concrete evidence, preferably with file/line references or command results.
- `recommended_action`: `fix | comment | defer | ignore | investigate`.
- `verification.required`: Integer `>= 2`; the number of cited reviewer runs required for this finding.
- `verification.artifacts`: Nonempty report paths. The exact recorded artifact for every key in `source` must appear here.

## Optional fields

- `target.repo`: Named repo for multi-repo audits.
- `target.file`: File path relative to the repo root.
- `target.line`: 1-indexed line number when there is a stable anchor.
- `target.end_line`: Optional end line.
- `github_comment`: Proposed GitHub review comment information after human acceptance.
- `decision_reason`: Human reason for accepting, rejecting, or deferring.
- `validation`: Commands/results relevant to this finding.

The blind peer's raw-target report can corroborate a primary finding only when both reports identify the same issue from target evidence. Do not show the primary report or its path to the peer before recording that raw report. Repository-controlled profile fragments are omitted from the peer prompt. Any later peer critique is separate provenance and must not replace the raw-target artifact.

`final-diff-review.md` is an adversarial whole-target gate, separate from finding verification. It does not count as a second source for existing findings merely because it agrees with them. Any new final-diff finding starts as a single-reviewer candidate and needs a fresh verifier (or independent matching evidence already present in another raw-target report) before confirmed synthesis.

## Status lifecycle

```txt
candidate → accepted → fixed → verified
candidate → unverified → rejected/deferred/needs_more_info
candidate → accepted → partially_fixed → fixed/still_open
candidate → accepted → still_open
candidate → accepted → commented
candidate → rejected
candidate → deferred
candidate → needs_more_info → accepted/rejected/deferred
```

Reviewer sessions should generally create `candidate` findings. Before human drill-down or synthesis, the parent audit cockpit compares provenance and evidence for every candidate. Primary-plus-peer corroboration satisfies the workflow gate when both reports contain the target evidence. A primary-only, peer-only, missed, or disputed finding requires a fresh focused reviewer and a `verification-<name>.md` artifact. Findings with only one reviewer stay outside terminal `findings.json` and may be carried in a separate open-questions section. In particular, `unverified` cannot transition directly to `accepted`.

Strict finalization accepts either a top-level findings array or an object with a `findings` array. It rejects a missing or unknown status. Every finding retained in this terminal artifact, including `deferred` and `rejected`, must satisfy its `verification.required` count with at least two concrete completed reviewer keys, nonempty tool/model/session identities, matching structural attestations, exact report paths in `verification.artifacts`, and pairwise-distinct cited report hashes. Any unresolved status (`candidate`, `unverified`, `accepted`, `needs_more_info`, `partially_fixed`, or `still_open`) requires final status `blocked`. A deferred finding requires `passed_with_deferred` or `blocked`, never `passed`; `passed_with_deferred` requires at least one deferred finding.

These checks validate local structure and orchestrator-recorded bindings. They do not cryptographically prove report authorship, reviewer independence or blindness, direct inspection, or any model's internal reasoning. Distinct report hashes are only copied-artifact defense in depth.
