# Audit findings schema v1

Findings should have stable IDs and structured status fields from the beginning. The v1 workflow treats this as a documented convention that can later become a strict validator.

```json
{
  "id": "F-001",
  "title": "Run status is not updated when one benchmark job fails",
  "severity": "high",
  "confidence": "confirmed",
  "source": ["primary-reviewer", "peer-reviewer"],
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
- `source`: One or more provenance labels such as `primary-reviewer`, `peer-reviewer`, `human-drilldown`. Specific model/tool names may be recorded separately in audit metadata.
- `status`: `candidate | accepted | rejected | deferred | needs_more_info | fixed | partially_fixed | still_open | verified | commented`.
- `impact`: User/product/runtime impact.
- `evidence`: Concrete evidence, preferably with file/line references or command results.
- `recommended_action`: `fix | comment | defer | ignore | investigate`.

## Optional fields

- `target.repo`: Named repo for multi-repo audits.
- `target.file`: File path relative to the repo root.
- `target.line`: 1-indexed line number when there is a stable anchor.
- `target.end_line`: Optional end line.
- `github_comment`: Proposed GitHub review comment information after human acceptance.
- `decision_reason`: Human reason for accepting, rejecting, or deferring.
- `validation`: Commands/results relevant to this finding.

## Status lifecycle

```txt
candidate → accepted → fixed → verified
candidate → accepted → partially_fixed → fixed/still_open
candidate → accepted → still_open
candidate → accepted → commented
candidate → rejected
candidate → deferred
candidate → needs_more_info → accepted/rejected/deferred
```

Reviewer sessions should generally create `candidate` findings. The parent audit cockpit updates status after human drill-down.
