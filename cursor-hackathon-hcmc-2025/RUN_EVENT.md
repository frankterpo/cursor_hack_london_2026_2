# Run Event

This is the simplest way to use `cursor-hackathon-hcmc-2025` as a live organizer board without losing the commit analysis.

## What To Send Competitors

Send this:

> Submit your project using this form.
>
> Required:
> - Team name
> - Project name
> - Public GitHub repo URL
> - Chosen main track
> - Demo URL
>
> Optional:
> - Team members
> - Notes
>
> Important:
> - Submit one repo per team
> - Keep the repo public
> - Submit the final repo judges should review

Use the fields in `data/submissions-template.csv` for your form.

## What To Send Judges

Send this:

> Score each project on:
> - Concrete Workflow Value: 0-30
> - Track Fit: 0-25
> - Reliability And Verification: 0-20
> - Technical Execution: 0-15
> - Demo Clarity: 0-10
>
> Bonus:
> - You may allocate up to 30 total bonus points across the side quests.
> - The full 30 can go to one side quest or be split across several.
> - Total score max is 130.

Use the fields in `data/judge-responses-template.csv` for your form.

## Organizer Setup

Before submissions open:

1. Create a submissions form using `data/submissions-template.csv`.
2. Create a judging form using `data/judge-responses-template.csv`.
3. Set `config.json` with event `t0` and `t1`.
4. Start the dashboard:

```bash
python3 ui/server.py --work-dir work --port 8001
```

## Live Tracking Workflow

As submissions come in:

1. Export the competitor form CSV to `data/submissions-raw.csv`.
2. Run:

```bash
python3 prepare_submissions.py --input data/submissions-raw.csv
```

3. Refresh the dashboard.

At this point the board already works as a live tracker:

- submitted teams appear immediately
- track selection appears immediately
- demo links appear immediately
- repos show as `Submitted` until analysis has been run

## Analysis Workflow

Whenever you want to refresh repo analysis:

```bash
python3 scan.py --repos data/repos.csv --config config.json --work-dir work
```

Then refresh the dashboard. The same rows will now show:

- commit counts
- LOC added/deleted
- pre-T0 flags
- bulk commit flags
- merge flags
- AI assessment

## Judge Workflow

As judge responses come in:

1. Export the judge form CSV to `data/judge-responses-raw.csv`.
2. Run:

```bash
python3 normalize_judge_responses.py
```

3. Refresh the dashboard.

Judge totals will display on the `130-point` scale while commit analysis remains intact.

## Best Operating Model

Do this:

- one GitHub repo per team
- one submission form
- one judge form
- this repo as the organizer control plane

Do not do this:

- one shared code repo for all teams
- one monorepo with folders per team

That would weaken the existing per-team commit analysis.
