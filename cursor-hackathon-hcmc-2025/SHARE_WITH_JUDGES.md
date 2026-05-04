# Share With Judges

Use this as the judge-facing scoring brief.

## Scoring Model

Each team is scored on:

- `100 core points`
- `30 judge bonus bucket points`
- `130 total max`

## Core Rubric

- `Concrete Workflow Value`: 0-30
- `Track Fit`: 0-25
- `Reliability And Verification`: 0-20
- `Technical Execution`: 0-15
- `Demo Clarity`: 0-10

## Judge Bonus Bucket

Judges may award up to `30 total bonus points` across these side quests:

- `Best Cursor-Native Workflow`
- `Best Developer Tool`
- `Best Reliability System`
- `Most Technically Ambitious`
- `Best Demo`

Important:

- The full `30` can go to one side quest.
- Or it can be split across several side quests.
- The combined bonus is capped at `30`.

Examples:

- `30`
- `20 + 10`
- `15 + 10 + 5`

## Organizer Flow

1. Share the fields in `data/judge-responses-template.csv` through your judge form.
2. Export responses as CSV to `data/judge-responses-raw.csv`.
3. Run:

```bash
python3 normalize_judge_responses.py
```

4. Open the dashboard:

```bash
python3 ui/server.py --work-dir work --port 8000
```

The dashboard will show average judge totals on the `130-point` scale, plus breakdowns for core and bonus scoring.
