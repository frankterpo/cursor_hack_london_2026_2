# Share With Competitors

Use this as the organizer-facing handoff for project submissions.

## What Competitors Must Submit

- `Team Name`
- `Project Name`
- `Github URL`
- `Chosen Track`
- `Demo URL`
- `Team Members`
- `Notes` (optional)

## Recommended Instructions

Submit one entry per team.

- Your GitHub repository must be publicly accessible.
- Choose exactly one main track.
- Include a demo link if you have one.
- Make sure the submitted repo is the final repo judges should review.

## Organizer Flow

1. Collect submissions using the fields in `data/submissions-template.csv`.
2. Export the responses as CSV.
3. Run:

```bash
python3 prepare_submissions.py --input data/submissions-raw.csv
```

4. This writes the files used by the analyzer:

- `data/repos.csv`
- `data/project-repo-map.csv`
- `data/submissions-normalized.json`
