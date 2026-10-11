# Backlog

`/factory:next` runs the first unchecked item. The orchestrator checks it off and
appends the job id. Add one feature per line, phrased as an outcome. Put the
ticket in front when there is one (`PROJ-123`, `#42`, or a URL). Every commit for
that feature then references it. `/factory:import github <query>` or
`/factory:import jira <jql>` adds open tickets here.

Example: `- [ ] PROJ-1 a hello CLI command that greets a name passed as an argument`

