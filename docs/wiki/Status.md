# Status

`/factory:status` shows the free slots and the ready, running, and waiting jobs.
Go back to [Home](Home).

## Running jobs

A job in `intake`, `spec`, `build`, `review`, or `docs` is running. It takes a slot.
The merge closes the issue while the documenter runs.
The factory also reads closed issues with the label `factory:docs`.
Thus a docs job shows under Running, and the queue counts its slot.

## Waiting jobs

A job in `needs-info`, `needs-human`, or `approved` waits.
With `merge.auto: true`, the `approved` row says that the factory merges the job.

A failed wiki push sets a closed job to `needs-human`.
The factory also reads closed issues in this state.
The row of such a job tells you to run `/factory:run` without an issue number.

## Changes
- #136: show jobs in the `docs` state as running, and count their slot.
- #137: show a closed job after a failed wiki push, with the retry step.
