# Software Factory 1.0 – Design-Entwurf

Status: Entwurf, nicht committet. Stand 2026-11-17.

Die 1.0 ersetzt das lokale Board (`board.json`, `backlog.md`, `serve.py`,
`dashboard.html`) durch ein echtes Ticketsystem. Die Wahrheit liegt im Ticket.
Lokal liegt nur eine Arbeitskopie (Review-Details, Logs, Worktrees), die am Ende
gelöscht wird.
Wir starten schlank und holen Teile aus 0.5 Stück für Stück zurück.

## Ziele

1. GitHub Issues als Backlog und Statusträger, später GitLab und andere.
2. Ein Mod-Pane rechts zeigt Backlog, laufende Jobs mit Phase, und Fertiges.
   Braucht ein Job einen Menschen, tauscht das Pane seinen Inhalt aus.
3. Intake mit Routing: Fastlane, regulärer Prozess, Rückfrage oder Ablehnung.
4. Der PR ist der Freigabeweg. Freigabe geht auf GitHub oder per Command.
5. Nicht-Techniker kommen mit einer geführten Setup-Routine zum Laufen.
6. Die Logik in TypeScript, als Mod-Tools in der Engine: kein Node, kein Build.
7. Doku der Implementierung am Ende, ins Wiki oder nach `docs/`.
8. Konsequent subagent-driven: Die Hauptsitzung (Orchestrator) bleibt immer
   ansprechbar. Jede Job-Arbeit läuft als Hintergrund-Subagent mit eigenem
   Worktree: Intake, Spec, Build, Reviews, Approver und Documenter. Der
   Orchestrator verteilt die Arbeit, reagiert auf Benachrichtigungen und ruft
   die Tools auf. Er wartet nie blockierend und macht keine Job-Arbeit selbst.
   Mehrere Jobs laufen parallel.

## Nicht-Ziele (vorerst)

- Product/Planner, Audit, PR-Review fremder PRs, Inbox-Dateien, Dashboard.
- Andere Ticketsysteme als GitHub (aber die Schnittstelle ist vorbereitet).
- Läufe in GitHub Actions. Die Factory läuft lokal, auf dem Plan des Benutzers.

## Pipeline

```
Issue mit Label `factory`
  │
intake (Fable) ──► REJECT      → Kommentar, Label factory:rejected, Ende
  │            ──► NEEDS-INFO  → Fragen als Kommentar, Label factory:needs-info, wartet
  │            ──► FASTLANE    → fastlane-Agent führt aus → Gate → Ticket schließen
  │            ──► ACCEPT      → regulär, mit Risiko und Bereichen
  │
route (Tool) → welche Reviewer, welche Modelle, ob Design- und Probe-Schritt nötig
  │
spec-writer (Opus) → spec.md
  │
[design] nur bei Bereich `ui-new`:
  designer erstellt 2–3 Entwürfe → Bilder + Links im Issue
  → Label factory:needs-design, wartet auf Wahl des Menschen
  → spec-writer arbeitet die Wahl in spec.md ein
  │
builder (Opus) → Commits, Push, Draft-PR "Closes #n"
  │
gate (Tool) → Checks der erkannten Stacks; FAIL → zurück an builder
  │
[probe] nur bei Bereich `api`: Stress- und Missbrauchstests gegen localhost
  │
reviewer (geroutet, parallel, WAIT FOR ALL) → CHANGES → builder → gate → …
  │
approver (Opus) → APPROVE: PR ready, Label factory:approved
                → ESCALATE: PR ready, Frage als PR-Kommentar, factory:needs-human
  │
Freigabe durch Menschen (immer), einer der Wege:
  a) PR auf GitHub approven und selbst mergen (Web-UI oder gh pr merge)
  b) der Factory sagen: /factory:merge <n>
     → Tool `merge`: Branch mit Base syncen, Gate erneut, gh pr merge
  Die Factory erkennt einen von außen gemergten PR und macht mit der Doku weiter.
  │
documenter (Sonnet) → Wiki-Seite oder docs/…, je nach Config
  │
Label factory:done, Issue schließt über den PR
  │
cleanup (Tool) → Worktree, lokaler Branch und jobs/<id>/ gelöscht
```

Jeder Schritt schreibt sein Ergebnis als Kommentar ins Issue (siehe „Wo was lebt“).

Entschieden: **Der Mensch gibt frei, immer.** Der approver der Factory ist
eine Empfehlung, kein Merge. Kein `merge.auto`.

- Ein Approval-Review auf GitHub allein merged nicht; es zeigt im Pane nur
  „approved, wartet auf Merge“ mit dem passenden Command.
- `/factory:merge <n>` heißt: „Ich gebe frei, merge bitte.“ Die Factory prüft
  dabei, dass das Gate auf dem aktuellen Stand grün ist, und bricht sonst mit
  Begründung ab.
- `<n>` darf Issue- oder PR-Nummer sein; die Factory findet das Paar.
- `/factory:approve <n>` hält die Freigabe fest, ohne zu mergen (jemand
  anderes merged, Merge-Fenster, Vier-Augen-Prinzip). Wo GitHub es erlaubt, als
  echtes Review-Approval; sonst als Kommentar.
- `/factory:merge <n>` approved, falls das noch fehlt, und merged.
- Im Pane steht bei „Bereit zum Merge“ `/factory:merge 42` groß,
  `/factory:approve 42` klein darunter.

**Identität in 1.0: der eigene `gh`-Login.** Folge: GitHub lässt niemanden den
eigenen PR approven. Factory-PRs stammen vom Benutzer selbst, darum wird
`/factory:approve` bei ihnen zum Kommentar, und ein Branch-Schutz mit
Pflicht-Approval passt in 1.0 nicht (Setup schlägt ihn deshalb nicht vor). Bei
fremden PRs (Dependabot) ist `approve` ein echtes Approval. Die Lösung kommt mit
der eigenen Bot-Identität, siehe Ausblick.

### Fastlane

Für Aufgaben ohne Implementierung (Dependabot-PRs mergen, Labels anlegen) und
für kleine Code-Änderungen (Tippfehler, Text ändern, Version bumpen, eine
Konstante, ein klar umrissener Einzeiler-Fix). Weniger Kontrolle, aber nicht keine:

- Kein spec-writer, keine Reviewer-Runde. Bei Code-Änderungen: Branch
  `factory/<id>`, Commit, Gate, PR. Freigabe wie immer über den PR.
- Das Gate prüft für Fastlane zusätzlich eine Diff-Grenze
  (`fastlane.maxFiles`, `fastlane.maxLines`, Standard 3 Dateien / 30 Zeilen) und
  keine Änderungen an `protectedPaths`, Migrationen oder Abhängigkeiten.
  Überschritten → regulärer Prozess, der Fastlane-Commit bleibt als Startpunkt.

- Intake schreibt in `intake.md` einen konkreten Plan (`## Fastlane plan`) mit
  den Schritten und den Bedingungen, unter denen abgebrochen wird.
- Der `fastlane`-Agent (Sonnet) führt nur diesen Plan aus.
- Ein Fastlane-Gate prüft das Ergebnis (z. B. CI der gemergten PRs grün, Checks
  auf dem Base-Branch grün).
- Schlägt etwas fehl, wird der Job nicht repariert, sondern geht in den
  regulären Prozess oder an `factory:needs-human`.
- Fastlane gibt es nur bei Risiko `low` und ohne Bereiche `ui-new`,
  `security`, `api`.

### Design-Iteration (UI neu)

Intake unterscheidet zwei UI-Bereiche: `ui` (bestehende Oberfläche ändern, z. B.
Button färben) und `ui-new` (neue Seite, neuer Dialog, neuer Flow). Nur
`ui-new` löst den Design-Schritt aus.

1. `designer` erstellt 2–3 Entwürfe als statisches HTML im Job-Ordner und
   macht Screenshots (Playwright, wie der ui-reviewer heute).
2. Das Tool lädt die Bilder hoch und postet einen Kommentar mit Bild, kurzer
   Beschreibung und Link pro Entwurf. Label `factory:needs-design`.
3. Der Mensch wählt per Kommentar (`/choose B` oder freier Text) oder per
   `/factory:choose <n> B`. Feedback statt Wahl löst eine weitere
   Design-Runde aus (max. `design.max_rounds`).
4. spec-writer übernimmt die Wahl in `spec.md`, erst dann wird gebaut.

Bilder im Issue: GitHub hat keine API für Datei-Uploads in Kommentare.
Entschieden: **Orphan-Branch `factory-assets`**.

- Setup legt den Branch an (ohne gemeinsame Historie mit `main`).
- Das Tool committet die Bilder nach `<issue>/<runde>/<name>.png` und pusht.
- Der Kommentar bettet sie per Blob-URL mit fester Commit-SHA ein:
  `![A](https://github.com/<owner>/<repo>/blob/<sha>/<issue>/1/a.png?raw=true)`,
  dazu ein Link auf den Ordner im Branch. Die SHA hält das Bild stabil, auch
  wenn der Branch später aufgeräumt wird.
- Bewährt: So kamen schon die Mockups in rokde/coffeechain#3 ins Issue, dort
  aus `docs/mockups/` auf dem Haupt-Branch. Der eigene Branch hält `main` frei.
- Artifacts auf claude.ai bleiben ein optionaler Zusatzlink (privat für den
  Benutzer, darum nie die einzige Quelle).

### Probe (Security-Stresstest)

Bei Bereich `api` startet ein `prober` den gebauten Dienst im Worktree auf dem
Job-Port und testet **nur gegen 127.0.0.1**:

- Last (Antwortzeiten, Fehlerquote unter N parallelen Requests),
- Eingaben an der Grenze (große Bodies, falsche Typen, Injection-Muster),
- fehlende Auth, IDOR auf neuen Endpunkten, Rate-Limits.

Ergebnis `round-N/probe.md` mit `VERDICT: PASS|CHANGES`, zählt wie ein Review.
Als eigener Schritt ist er im Pane und im Issue sichtbar. Werkzeug: ein kleiner
eigener Load-Runner in TypeScript (`fetch` + Promise-Pool), damit nichts
installiert werden muss; `k6`/`autocannon` nur, wenn vorhanden.

## Status über Labels

| Label | Bedeutung | Läuft? |
|---|---|---|
| `factory` | im Backlog der Factory (Vertrauensgrenze: nur Triage/Write setzen Labels) | – |
| `factory:intake` | Intake läuft | ja |
| `factory:needs-info` | wartet auf Antwort des Autors | nein |
| `factory:fastlane` | Fastlane läuft | ja |
| `factory:spec` | Spec läuft | ja |
| `factory:needs-design` | wartet auf Design-Wahl | nein |
| `factory:build` | Build/Gate läuft | ja |
| `factory:review` | Reviews/Probe laufen | ja |
| `factory:needs-human` | eskaliert, wartet | nein |
| `factory:approved` | Approver sagt ja, wartet auf Freigabe | nein |
| `factory:docs` | Doku läuft | ja |
| `factory:done` | fertig | – |
| `factory:rejected` | abgelehnt | – |

- Genau ein Status-Label pro Issue. Nur die Factory-Tools setzen sie, über eine
  Übergangstabelle, die illegale Wechsel ablehnt.
- Parallelität: Issues mit einem Label aus „Läuft? ja“ belegen einen Slot.
  Wartende Jobs belegen keinen.
- Ein Issue mit `factory`, aber ohne Status-Label, ist bereit im Backlog.
- Reihenfolge im Backlog: zuerst nach Priorität, dann älteste zuerst.
  Prioritäts-Labels `priority:critical`, `priority:high`, `priority:medium`,
  `priority:low` (Namen in der Config, falls das Repo schon eigene hat).
  Ohne Prioritäts-Label zählt ein Ticket wie `medium`. `Depends on #n` geht
  vor: ein Ticket startet erst, wenn seine Abhängigkeiten fertig sind.
- `init` legt alle Labels mit Farbe und Beschreibung an (`gh label create --force`).

### Labels an PRs

GitHub führt PRs als Issues (gleicher Nummernkreis, gleiche Labels, die
Issues-API liefert beide). Darum:

- **Der Status lebt nur am Ticket, nie doppelt.** PRs, die die Factory für ein
  Issue öffnet, bekommen keine Status-Labels, sonst müssten zwei Stellen
  synchron gehalten werden.
- **PRs der Factory bekommen ein Marker-Label `factory:pr`.** Damit filtert man
  auf GitHub (`is:pr label:factory:pr`), und das Pane findet den PR. Die
  Verbindung zum Issue steht im PR-Body (`Closes #n`) und im Intake-Kommentar des Issues.
- **`factory` an einem fremden PR macht den PR selbst zum Ticket.** Beispiel:
  ein Dependabot-PR bekommt `factory` und läuft durch den Intake, meist in die
  Fastlane. Ein solcher PR trägt dann auch die Status-Labels, denn es gibt kein
  Issue daneben. Regel: **Status lebt am Ticket**; Ticket ist ein Issue oder ein
  fremder PR. PRs, die die Factory selbst öffnet, tragen nur `factory:pr`.
- `Ticket` bekommt dafür `kind: 'issue' | 'pr'`. Der Intake liest bei PRs
  zusätzlich Diff, Autor, CI-Status und (bei Dependabot) die Art des Updates.

Intake-Wege für einen fremden PR:

| Lage | Weg |
|---|---|
| Patch/Minor-Update, CI grün | Fastlane: approve, mergen über die normale Freigabe |
| Major-Update oder CI rot, Fix nötig | regulär: Branch `factory/<id>` auf dem PR-Branch, builder passt an, eigener PR `factory:pr`, der fremde PR wird danach geschlossen |
| unklar, riskant, Fremd-Fork | `needs-human` oder REJECT |

Sicherheit bei fremden PRs:

- Lokale Checks führen fremden Code auf dem Rechner aus. Darum laufen sie nur
  für PRs aus Branches im selben Repo oder von bekannten Bots
  (`dependabot[bot]`, `renovate[bot]`, Liste in der Config). Fork-PRs: keine
  lokale Ausführung, nur Lesen + GitHub-CI-Status, sonst `needs-human`.
- Dependency-Updates können Install-Skripte mitbringen. Fastlane für
  Dependabot stützt sich zuerst auf den CI-Status auf GitHub; lokal nur mit
  abgeschalteten Install-Skripten (z. B. `npm ci --ignore-scripts`), wo der
  Stack das kann.

### Kanban in GitHub Projects (optional)

**Standard: aus** (`project.enabled: false`). Setup fragt nicht danach,
sondern erwähnt es nur. Einschalten mit `/factory:setup project` (oder
`project.enabled: true` in der Config und danach `/factory:setup`). Setup legt
dann ein GitHub Project (v2) an oder nutzt ein bestehendes (`project.number`)
und fügt die offenen Factory-Tickets mit ihrem aktuellen Status hinzu.
Ausschalten lässt das Project stehen, die Factory pflegt es nur nicht mehr.

- Spalten im Board-Layout kommen bei Projects v2 aus einem Single-Select-Feld,
  **nicht aus Labels**. Die Factory legt darum ein Feld `Factory` mit einer
  Option pro Status an (Backlog, Intake, Spec, Design?, Build, Review,
  Wartet, Bereit zum Merge, Doku, Fertig, Abgelehnt) und ein Board mit
  „Column by: Factory“.
- Das Tool setzt das Feld bei jedem Übergang mit (`gh project item-edit`),
  und fügt neue Tickets hinzu (`gh project item-add`). Das Feld ist ein
  **Spiegel**: die Labels bleiben die Wahrheit, gelesen wird nie aus dem Feld.
  Weicht es ab (jemand zieht eine Karte), überschreibt das Tool es und meldet
  es. Karten ziehen ist also keine Steuerung (vorerst).
- Braucht den Token-Scope `project`; Setup prüft und erklärt das.
- Zu prüfen: wie weit sich Board-Ansicht und Spalten per API/`gh` anlegen
  lassen; sonst führt Setup den Benutzer per Anleitung durch zwei Klicks.

## Ticketsystem-Schnittstelle

```ts
interface Tracker {
  backlog(): Promise<Ticket[]>              // Label factory, offen
  get(id: string): Promise<Ticket>          // Body, Kommentare (gefiltert), Labels
  setState(id: string, s: State): Promise<void>
  comment(id: string, body: string): Promise<void>
  close(id: string, reason: 'done' | 'rejected'): Promise<void>
  openPr(branch: string, title: string, body: string): Promise<Pr>
  prState(pr: number): Promise<PrState>
  merge(pr: number, method: MergeMethod): Promise<void>
  uploadImage(job: string, file: string): Promise<string> // URL
  applyStandard(std: RepoStandard, apply: boolean): Promise<StandardCheck[]> // Ist, Soll, Abhilfe
}
```

Erste Umsetzung `github` über die `gh` CLI (`gh issue`, `gh pr`, `gh api`).
MCP nur als Fallback, wenn `gh` nicht geht. Issue-Text geht nur als zitierte
Daten in `issue.md` an Agenten, nie in einen Prompt; Kommentare nur vom Autor
und vom Operator.

## `.factory/` im Ziel-Repo

```
.factory/
  config.json          versioniert: Tracker, Parallelität, Routing, Doku, Stacks
  checks.local.ts      optional, versioniert: eigene Zusatz-Checks
  .gitignore           ignoriert alles unten
  jobs/<id>/           Arbeitskopie eines laufenden Jobs (wird am Ende gelöscht)
  worktrees/<id>/      Worktree auf factory/<id> (wird am Ende gelöscht)
  status.json          Snapshot für das Pane (schreibt nur der Mod)
  backup/              Configs vor Migrationen, die letzten 3
```

### Wo was lebt

Regel: **Alles, was man zum Weitermachen braucht, steht im Ticket. Lokal liegt
nur eine Arbeitskopie.** Test: `.factory/jobs/` löschen oder den Rechner
wechseln, und die Factory macht aus dem Issue weiter. Verloren gehen dürfen nur
Details wie Logs.

| Ort | Inhalt |
|---|---|
| Issue | Kommentare, die die Factory an Ort und Stelle aktualisiert und an einem unsichtbaren Marker erkennt (`<!-- factory:intake -->`, `factory:spec`, `factory:design`, `factory:round-N`, `factory:decision`, `factory:docs`): Intake und Route, Spec, Design-Wahl, Fragen und Antworten, je Runde eine Kurzfassung der Reviews (Verdikt, wichtigste Punkte), Entscheidung des Approvers, Link zur Doku. Dazu das Status-Label. |
| PR | was gebaut wurde (Body), Verdikte der Runde, Rückfrage bei ESCALATE. |
| `factory-assets` | Bilder (Design-Entwürfe, Screenshots, Probe-Grafiken), im Issue verlinkt. |
| lokal `jobs/<id>/` | vollständige Review-Dateien, Testausgaben, Logs, Zwischenstände. Die Agenten lesen und schreiben nur hier. |

- **Spec im Issue ist die Quelle.** Ändert ein Mensch den Spec-Kommentar auf
  GitHub, übernimmt die Factory das vor dem nächsten Schritt (Zeitstempel
  des Kommentars gegen die lokale Kopie).
- **Ablauf je Schritt:** Das Tool lädt Issue und Kommentare nach `jobs/<id>/`
  (`issue.md`, `spec.md`, …), der Agent arbeitet auf den Dateien, das Tool
  schreibt das Ergebnis als Kommentar zurück und setzt das Label. Die Agenten
  brauchen dafür keinen GitHub-Zugang.
- Fehlt die lokale Kopie (anderer Rechner, gelöscht), baut das Tool sie aus dem
  Issue neu; der Branch `factory/<id>` kommt von `origin`.

### Aufräumen

Am Ende ist alles weg, was der Job lokal angelegt hat. Das Tool `cleanup` läuft
nach jedem Ende eines Jobs:

| Ende | Was passiert |
|---|---|
| `done` (gemergt, auch von außen) | Kurzfassung steht im Issue; `git worktree remove`, `git branch -d factory/<id>` (gemergt, also sicher), Remote-Branch löscht GitHub (`delete_branch_on_merge`), `jobs/<id>/` löschen. |
| `rejected` | PR schließen, Remote-Branch löschen, lokalen Branch nur löschen, wenn sein Commit auf GitHub liegt (`refs/pull/<n>/head` zeigt auf denselben SHA); sonst bleibt er und das Pane meldet es. Worktree und `jobs/<id>/` löschen. |
| Fastlane | wie `done`. |

- Ein Worktree mit ungesicherten Änderungen an versionierten Dateien wird nie
  gelöscht, sondern gemeldet. `--force` nur, wenn nur unversionierte Dateien
  übrig sind.
- **Beim Start** (`/factory:run`, Setup) räumt das Tool Reste auf: Worktrees und
  `jobs/<id>/`, deren Issue geschlossen ist (z. B. nach einem Absturz), dann
  `git worktree prune` und `git fetch --prune`.
- Bleibt etwas liegen, zeigt das Pane es mit dem Grund und dem Command dafür.
- `factory-assets` wird nicht aufgeräumt: die Bilder sind im Issue verlinkt.

### config.json (Entwurf)

```json
{
  "version": 1,
  "tracker": { "type": "github", "url": "https://github.com/acme/shop" },
  "concurrency": 4,
  "maxRounds": 3,
  "baseBranch": "main",
  "merge": { "method": "merge" },
  "project": { "enabled": false, "number": null },
  "docs": { "target": "wiki" },
  "repo": { "standard": 1 },
  "stacks": [{ "id": "node", "path": "." }, { "id": "php", "path": "." }],
  "routing": {
    "low":    { "code": "haiku" },
    "medium": { "code": "sonnet" },
    "high":   { "code": "sonnet", "security": "opus" }
  },
  "surfaces": {
    "ui":       { "ux": "sonnet", "ui": "haiku" },
    "ui-new":   { "ux": "sonnet", "ui": "sonnet", "design": true },
    "security": { "security": "opus" },
    "api":      { "security": "opus", "probe": true }
  },
  "protectedPaths": [".factory/config.json", ".factory/checks.local.ts"]
}
```

`docs.target`: `wiki` oder `docs` (dann `docs.path`, Standard `docs/`).
Hinweis: Das Wiki-Git-Repo existiert erst, wenn im Browser die erste Seite
angelegt wurde. `init` prüft das und sagt dem Benutzer, was zu tun ist.

### Migration

- `version` in der Config. Jede Änderung am Schema bringt eine Migration
  `lib/migrations/NNN-<name>.ts` mit `up(old) → new` und einem Test.
- Jedes Tool lädt die Config über `loadConfig()`. Ist sie älter, bricht es
  mit dem Hinweis auf `/factory:setup` ab; Setup ruft das Tool `migrate`.
- `migrate` sichert vorher nach `.factory/backup/config.<version>.json`,
  läuft alle Schritte nacheinander, validiert das Ergebnis und zeigt den Diff.
- Auch für den Umstieg von 0.5: `migrate --from-0.5` legt aus `backlog.md`-Zeilen
  Issues an (nach Rückfrage) und übernimmt `project.md`-Angaben.

### Einstellungen geführt (`/factory:config`)

- Ohne Parameter führt Claude durch die Einstellungen der `config.json`, Gruppe für Gruppe (Ticketsystem, Parallelität und Runden, Merge, Doku, Projects-Board, Stacks, Routing/Modelle, geschützte Pfade, Repo-Standard).
- Je Einstellung: ein, zwei Sätze, was sie bewirkt, der aktuelle Wert, die Empfehlung. Dann eine Frage mit `AskUserQuestion`: die Empfehlung als erste Option mit „(empfohlen)“, „Unverändert lassen“ immer dabei, eigene Eingabe über „Other“. Bis zu 4 Fragen pro Runde, damit es nicht ermüdet.
- Erklärtexte, Optionen und Empfehlungen kommen aus einem Schema im Plugin (`lib/config-schema.ts`: Schlüssel, Typ, Standard, Beschreibung, Optionen, ob ein Umzug daran hängt). Daraus kommen auch die Validierung und die Defaults, also eine Quelle für Doku, Fragen und Prüfung.
- Ein Tool `config_describe` liefert dem Skill das Schema samt aktueller Werte; `config_set` schreibt (mit Validierung).
- Am Ende: Zusammenfassung der Änderungen als Diff, eine Bestätigung, dann schreiben. Hängt an einer Änderung ein Umzug, folgt dessen Plan (siehe Umzug).
- Mit Gruppe als Parameter nur diese Gruppe: `/factory:config docs`.
- Setup nutzt denselben Dialog für Schritt 3 (Projekt), damit es nur einen Weg gibt.

### Umzug (Transformation)

Eine Migration ändert das Format der Config. Ein **Umzug** ändert einen Wert,
an dem Daten hängen, und zieht diese Daten mit. Beispiel: `docs.target` von
`docs` auf `wiki` heißt, die Doku kommt ins Wiki und verschwindet aus `docs/`.

Auslöser:

- `/factory:config <schlüssel> <wert>`, z. B. `/factory:config docs.target wiki`.
- Setup findet eine Abweichung zwischen Config und Ist (jemand hat
  `config.json` von Hand geändert, `docs/` hat aber noch Inhalt) und bietet den
  Umzug an.

Ablauf, immer gleich:

1. **Plan:** was wohin geht, als Liste mit Zählern („12 Seiten nach Wiki,
   3 Bilder, 27 Links umschreiben, danach `docs/` löschen“). Einzelne Dateien
   lassen sich ausnehmen.
2. **Zustimmung** des Menschen.
3. **Ausführen** in einem eigenen Job mit Branch und PR, wie jeder andere Job.
4. **Prüfen:** jede Datei ist am Ziel, Inhalt gleich, Links aufgelöst.
5. **Erst dann löschen**, und zwar über den PR: der Mensch mergt, wie immer.

Ziele ohne PR (das Wiki): der Umzug merkt sich den Commit des Wikis vor dem
Push. Wird der PR geschlossen statt gemergt, setzt die Factory das Wiki mit
einem Revert-Commit auf diesen Stand zurück und meldet es im Issue. So liegt
die Doku nie doppelt vor.

Jeder Umzug lässt sich zurückdrehen: Wiki und Repo sind beide Git, der PR ist
revertierbar, und der Umzug in die Gegenrichtung ist derselbe Mechanismus.

| Schlüssel | Umzug |
|---|---|
| `docs.target` `docs` → `wiki` | Seiten aus `docs.path` ins Wiki-Repo pushen (Pfad → Seitenname, `docs/api/auth.md` → `Api-Auth`), Bilder mit, relative Links auf Wiki-Links umschreiben, `_Sidebar.md` aus der Ordnerstruktur. Danach PR: `docs.path` löschen, README-Link auf das Wiki. Das Wiki muss vorher existieren (erste Seite im Browser), Setup sagt es. |
| `docs.target` `wiki` → `docs` | Wiki-Repo klonen, Seiten nach `docs.path` (Seitenname → Pfad, Sidebar bestimmt die Ordner), Links zurückschreiben. PR mit den Dateien und README-Link. Nach dem Merge: Wiki-Seiten entfernen bis auf `Home` mit Verweis auf `docs/`; Wiki abschalten nur auf Nachfrage. |
| `docs.path` ändern | Dateien verschieben (`git mv`), Links anpassen, PR. |
| `project.enabled` `false` → `true` | Board anlegen oder verbinden, alle offenen `factory`-Tickets mit ihrem Status eintragen. |
| `project.enabled` `true` → `false` | nichts löschen; Board bleibt, die Factory pflegt es nicht mehr (Hinweis im Pane). |
| `stacks` ändern | Workflows und `.gitignore` neu erzeugen, Diff zeigen, PR. |
| `tracker` wechseln | später (GitLab): Tickets umziehen ist ein eigenes Vorhaben, nicht Teil von 1.0. |

Code: `lib/transforms/<schlüssel>.ts` mit `plan(alt, neu)`, `apply(plan)` und
`verify(plan)`, je mit Test. Ein Schlüssel ohne Transform wird einfach gesetzt.
Was nach `docs/` gehört, entscheidet `docs.path`; Dateien darin, die die
Factory nicht geschrieben hat, zeigt der Plan getrennt und fragt einzeln.

## Stacks: erkennen und einheitlich prüfen

Ziel-Sprachen für 1.0: Node/TypeScript/JavaScript (Client und Server), PHP, Go,
Rust, Python, Swift (macOS) und .NET.

### Erkennen

Das Tool `detect` durchsucht das Repo nach Markern, auch in Unterordnern
(Monorepo: `web/` mit Node, `api/` mit Go). Ergebnis je Fund: Stack, Pfad,
Variante, Versionen, Werkzeuge. Setup zeigt es zur Bestätigung, z. B.:

> node in `web/`: TypeScript, Vite + React (Client), pnpm 9, Node 22 aus `.nvmrc`
> go in `api/`: Go 1.23, golangci-lint konfiguriert, HTTP-Server (chi)

Die Config hält die Funde als Liste mit Pfad, jeder Schritt lässt sich
überschreiben:

```json
"stacks": [
  { "id": "node", "path": "web" },
  { "id": "go", "path": "api", "steps": { "test": "make test" } }
]
```

Die Variante speist das Routing: Client-Frameworks setzen standardmäßig den
Bereich `ui`, Server-Frameworks `api` (dann auch Probe und `start`).

### Woher die Befehle kommen

Mehrere Stacks am selben Pfad sind normal: Ein Laravel-Projekt ist `php` und
`node` in `.`, beide laufen. Die Reihenfolge unten gilt **je Stack und je
Schritt**, der erste Treffer gewinnt:

1. `steps` in der Config (Überschreibung durch den Menschen).
2. Task-Runner des Projekts mit passendem Ziel: `Makefile`, `justfile`,
   `Taskfile.yml`, `mise.toml` (Ziele `test`, `lint`, `fmt`, `build`, …).
3. Eigene Scripts des Stacks (`package.json`-Scripts, `composer.json`-Scripts).
4. Standardbefehl des Werkzeugs. Das ist ein Werkzeug, das das Projekt schon
   nutzt, sonst das Pflichtwerkzeug aus der Tabelle unten.

Ein Task-Runner-Ziel gehört allen Stacks an seinem Pfad. Das Gate führt es pro
Schritt nur einmal aus. Gibt es z. B. `make test`, ersetzt es den `test`-Schritt
von `php` und `node` zusammen. `make lint` fehlt dagegen, also bleibt `lint`
pro Stack (Pint und ESLint). Gleiche Befehle über mehrere Stacks laufen
ebenfalls nur einmal.

Das Gate läuft schrittweise über alle Stacks, nicht Stack für Stack: erst jedes
`install`, dann `format`, `lint`, `typecheck`, dann `build`, zuletzt `test`.
So ist z. B. das Vite-Manifest gebaut, bevor Laravel-Tests Views rendern. Wo
ein Stack einen anderen braucht, schreibt `detect` das als `after` in den
Fund (Laravel: `php.test` nach `node.build`).

### Pflicht: Formatter, Linter, statische Analyse, Tests

Jeder Stack hat **zwingend** einen Formatter, einen Linter, eine statische
Analyse (Typen) und Tests, jeweils auf der strengsten Stufe. Fehlt etwas,
bringt die Factory es mit. Vorhandene Werkzeuge bleiben, wenn sie die Rolle
erfüllen. Die Factory stellt dann nur ihre Stufe auf das Maximum.

| Stack | Formatter | Linter / Refactoring | Statische Analyse | Tests |
|---|---|---|---|---|
| `php` | Pint | Rector: `withPhpSets()` für die PHP-Version aus `composer.json`, alle `withPreparedSets` (deadCode, codeQuality, codingStyle, typeDeclarations, privatization, earlyReturn, strictBooleans), Laravel: `rector-laravel`; im Gate `--dry-run` | PHPStan `level: max` mit `phpstan-strict-rules` und `phpstan-deprecation-rules`, Laravel: Larastan | Pest |
| `node` (TS/JS) | Vite+ `vp fmt` (Oxfmt) | `vp lint` (Oxlint) mit `typeAware` | `vp check` mit `typeCheck`; dazu `tsc --noEmit` mit `strict` und `noUncheckedIndexedAccess`; neue JS-Projekte starten als TypeScript | `vp test` (Vitest) |
| `go` | gofumpt | golangci-lint v2, breites Set (u. a. staticcheck, gosec, errorlint, revive) | `go vet`, `govulncheck` | `go test -race` |
| `rust` | rustfmt | clippy mit `-D warnings`, `clippy::pedantic` | Compiler; `cargo deny` | `cargo test` |
| `python` | Ruff format | Ruff mit breitem Regelset | mypy `--strict` (oder basedpyright strict) | pytest |
| `swift` | swift-format | SwiftLint (strikt) | Swift 6 Sprachmodus, strikte Concurrency, Warnungen als Fehler | Swift Testing / XCTest |
| `dotnet` | `dotnet format` | `AnalysisLevel` `latest-all` | `Nullable` `enable`, `TreatWarningsAsErrors` | xUnit |

Die Tabelle ist der Repo-Standard für Werkzeuge. Sie ist versioniert wie der
restliche Repo-Standard (`repo.standard`) und steht in `lib/stacks/<id>.ts`.
Vite+ ist für Node gesetzt: ein Werkzeug für alles und das schnellste
Tooling. Bei Vite+ kann eine Option fehlen (z. B. `baseUrl` im type-aware
Pfad). Dann bleibt `tsc --noEmit` die volle Prüfung.

**Neues Projekt:** Setup legt alles auf der höchsten Stufe an. Das Gate ist ab
dem ersten Commit streng.

**Bestehendes Projekt:** Setup legt ein Einführungs-Ticket an
(`chore: introduce static analysis`), das wie jedes Ticket durch die Pipeline
geht. Es führt die Werkzeuge gleich auf der höchsten Stufe ein. Altlasten
bremsen nicht:

- Was automatisch zu beheben ist, behebt das Ticket direkt (Rector, Pint,
  Formatter, `--fix` der Linter), als eigener Commit.
- Den Rest friert eine Baseline ein, wo das Werkzeug das kann (PHPStan
  `phpstan-baseline.neon`, SwiftLint `--baseline`, golangci-lint
  `new-from-rev`). Neue Fehler blocken sofort. Die Baseline darf nur schrumpfen:
  wächst sie, ist das Gate FAIL.
- Ohne Baseline-Funktion behebt das Ticket alle Funde. Wird es zu groß,
  teilt der spec-writer es auf, Ordner für Ordner.

Bis das Einführungs-Ticket gemergt ist, prüft das Gate mit dem, was schon da
ist. Danach ist der Pflichtsatz Teil jedes Gates.

### TDD

Der builder arbeitet testgetrieben: Für jedes Akzeptanzkriterium schreibt er
erst einen Test, sieht ihn rot, dann den Code, der ihn grün macht, dann
räumt er auf. Belege landen in `round-N/build.md`: je Kriterium der Test und
die rote Ausgabe vor der Umsetzung. Der code-reviewer prüft, dass jedes
Kriterium einen Test hat, der ohne die Änderung fehlschlägt. Fehlt das, ist
das CHANGES. Ausnahmen (reine Doku, Konfiguration, Fastlane ohne Logik) nennt
die Spec ausdrücklich.

### Einheitliche Schritte

Jeder Stack liefert dieselben Schritte, leere werden übersprungen:
`install`, `format` (nur prüfen), `lint`, `typecheck`, `build`, `test`,
`audit` (bekannte Schwachstellen), `start` (Dienst für Probe und UI-Review,
mit Port).

| Stack | Marker | Varianten | Versionen aus | Schritte (Standard, wenn genutzt) |
|---|---|---|---|---|
| `node` | `package.json` | TypeScript (`tsconfig.json`); Client: React, Vue, Svelte, Vite, Astro; Server: Express, Fastify, Nest, Hono; beides: Next, Nuxt, Remix | `.nvmrc`, `.node-version`, `engines`, `packageManager`, `.tool-versions` | Paketmanager aus Lockfile (pnpm, yarn, bun, npm); `ci`-Install; Prettier/Biome, ESLint/Biome; `tsc --noEmit`; Vitest/Jest/`node --test`; `build`; `<pm> audit`; `dev`/`start` |
| `php` | `composer.json` | Laravel (`artisan`), Symfony (`bin/console`), Bibliothek | `require.php`, `.php-version` | `composer install`; Pint/PHP-CS-Fixer; PHPStan/Larastan/Psalm; Pest/PHPUnit, Laravel `artisan test`; `composer audit`; `artisan serve`/`symfony serve`/`php -S` |
| `go` | `go.mod`, `go.work` | Bibliothek, CLI (`cmd/`), HTTP-Server (net/http, chi, gin, echo) | `go`/`toolchain` in `go.mod` | `go mod download`; `gofmt -l`; `go vet`, golangci-lint; `go test -race ./...`; `go build ./...`; `govulncheck`; `go run ./cmd/<name>` |
| `rust` | `Cargo.toml` (auch Workspace) | Bibliothek, Binary, Server (axum, actix, rocket) | `rust-toolchain.toml`, `rust-version` | `cargo fetch`; `cargo fmt --check`; `cargo clippy --all-targets -- -D warnings`; `cargo test`; `cargo build`; `cargo audit`/`cargo deny`; `cargo run` |
| `python` | `pyproject.toml`, `requirements*.txt`, `setup.py` | Django (`manage.py`), FastAPI, Flask, Bibliothek | `.python-version`, `requires-python` | uv/Poetry/pip aus Lockfile; Ruff (Format, Lint) oder Black/Flake8; mypy/Pyright; pytest, Django `manage.py test`; `pip-audit`; uvicorn/`manage.py runserver` |
| `swift` | `Package.swift`, `*.xcodeproj`, `*.xcworkspace` | Paket, macOS-App (SwiftUI/AppKit) | `.swift-version`, `swift-tools-version`, Xcode | Paket: `swift build`, `swift test`; App: Schema aus `xcodebuild -list -json`, `xcodebuild test -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO`; SwiftLint/swift-format |
| `dotnet` | `*.sln`, `*.csproj`, `global.json` | Bibliothek, Konsole, ASP.NET (Web/API) | `global.json`, `TargetFramework` | `dotnet restore`; `dotnet format --verify-no-changes`; `dotnet build`; `dotnet test`; `dotnet list package --vulnerable`; `dotnet run` |

Hinweise:

- **Swift-Apps brauchen macOS mit vollem Xcode** (die Command Line Tools reichen
  nur für Pakete). `doctor` prüft das; auf anderen Rechnern meldet das Gate
  den Stack als „nicht ausführbar hier“ statt als rot.
- **Werkzeuge und Versionen** prüft `doctor` gegen die gefundenen Versionen.
  Installation nach Zustimmung über Homebrew; nutzt das Projekt `mise` oder
  `.tool-versions`, über `mise install`.
- **CI**: `tests.yml` im Repo-Standard bekommt dieselben Schritte je Stack, mit
  der passenden Setup-Action (Version aus derselben Datei, z. B.
  `node-version-file: .nvmrc`), Swift auf `macos-latest`.
- **Sicherheit**: Fremde PRs (Fork) laufen lokal mit abgeschalteten
  Install-Skripten, wo der Paketmanager das kann (`--ignore-scripts`).

Jeder Stack ist ein Modul `lib/stacks/<id>.ts` mit derselben Form und Tests
gegen kleine Beispiel-Repos (`tests/fixtures/<id>-*`):

```ts
interface Stack {
  id: string
  detect(repo: string): Promise<Detection[]>   // Pfad, Variante, Versionen, Werkzeuge
  requires(d: Detection): Tool[]               // z. B. php >= 8.2, composer
  steps(d: Detection): Promise<Step[]>         // install, format, lint, typecheck, test, build, audit, start
}
```

Das Gate fragt nur noch „welche Stacks, welche Steps“ und führt sie gleich aus:
gleiche Ausgabe, gleiche Logs (`round-N/checks.md` + `.log`), gleiche
Zeitlimits. Das Gate läuft immer aus dem Plugin und der Config der Main-Checkout,
nie aus dem Branch. Der documenter und die Reviewer lesen dieselbe Stack-Liste.

## Laufzeit: Mod-Tools in der Engine, ohne Node (entschieden)

Geprüft am 2026-11-17 mit einem Prototyp (Plugin `fproto`, Build 2.1.326):

| Frage | Ergebnis |
| --- | --- |
| Kann der Mod Tools anbieten? | Ja. `$.tool.register` in `session.start`, bedient von einem `tool.run`-Hook. Name: `mcp__factory__<name>`. |
| Bekommt ein Subagent sie? | Ja. Agent mit `tools: mcp__fproto__ping` im Frontmatter rief das Tool auf, `e.agentId` nennt den Subagenten. |
| Läuft das in `claude -p`? | Ja, mit `--plugin-dir` getestet (Haupt-Loop und Subagent). Installiertes Plugin in `-p`: in Schritt 1 nachprüfen. |
| Prozesse (`gh`, `git`, Tests)? | `$.process.run` (ohne Shell, 30 s Standard, höchstens 10 min, je Stream 4 MB). Länger: `$.process.spawn` streamt. Ein laufender `$`-Aufruf zählt nicht gegen das Hook-Budget. Nur CLI-Sessions (auch Desktop lokal). |
| Dateien, HTTP, Krypto? | `$.fs`, `$.http.fetch` (über den Host), `crypto.subtle` (reicht für das JWT der GitHub-App). |
| Testbar? | `claude plugin test` mit `*.test.ts`; `$.tool.call` ruft die Tools wie eine Session, auch mit `agentId`. |
| Einschränkungen | Kein Node, kein `require`, kein dynamisches `import()`. ES-Module mit `.ts`-Dateien des Plugins. Mod-API ist neu, Änderungen möglich. |

**Entschieden:** Die Logik der Factory (Status-Maschine, Queue, Route, Gate,
Merge, Tracker, Stacks, Migrationen) lebt als TypeScript im Plugin und läuft im
Mod. Das Modell und die Agenten rufen sie als Tools auf, z. B.
`mcp__factory__job_advance`, `mcp__factory__gate`, `mcp__factory__queue`.

- Kein Node beim Benutzer. Voraussetzungen nur noch `git`, `gh` und die Stack-Werkzeuge.
- Pane, Commands und Tools teilen sich Code und Typen direkt, ohne JSON-Umweg.
- Agenten bekommen nur die Tools, die ihr `tools:` nennt (Builder z. B. kein `merge`).
- Gate und Merge sind Code, nicht Prompt: das Modell kann sie nicht „frei“ ausführen.
- Tools landen per Standard hinter ToolSearch; die Factory-Tools setzen
  `isDeferred: false`, damit Skills und Agenten sie sofort sehen.
- Risiko: die Mod-API. Gegenmittel: die Logik in reine Module ohne `$` schneiden
  (`lib/*.ts`), nur eine dünne Schicht `hooks/tools.ts` kennt `$`. Damit bliebe
  ein Wechsel auf `node bin/factory.ts` später billig.

Regeln für den Code wie bisher: `.ts`, keine `enum`s, keine Parameter-Properties,
Importe mit `.ts`-Endung, Typprüfung mit `tsc --noEmit` gegen die Engine-Typen.

**Ein Plugin, alles drin** (entschieden): Skills, Agenten, Logik und Mod kommen
mit einer Installation.

## Setup für Nicht-Techniker

`/factory:setup` führt durch alles, in Alltagssprache, Schritt für Schritt.
Claude selbst ist der Installer: es prüft, erklärt, fragt und führt aus.

1. **Werkzeuge** (Tool `doctor`, gibt JSON mit Prüfung, Ergebnis, Abhilfe):
   `git`, `gh`, Stack-Werkzeuge (php, composer, Xcode-CLT, …). Node braucht die
   Factory nicht; nur ein Projekt mit Stack `node` braucht es für seine eigenen
   Tests. `doctor` läuft im Mod, also schon bevor irgendetwas installiert ist.
   Installation auf macOS über Homebrew (`brew install gh`),
   fehlt Homebrew, wird es erklärt und nach Zustimmung installiert. Windows: `winget`.
   Jede Installation erst nach Zustimmung.
2. **GitHub-Zugang**: `gh auth status`. Sonst `! gh auth login --web` (der Benutzer
   tippt es selbst, Browser-Login). Alternative Fine-grained Token mit Anleitung
   (Repo auswählen, Rechte: Contents, Issues, Pull requests: Read & write;
   Metadata: Read). Dann Test: Repo lesbar, Label anlegbar, Branch pushbar.
3. **Projekt**: Tracker-URL aus `git remote` vorschlagen, Parallelität (Standard 4),
   Doku-Ziel (Wiki prüfen), Stacks erkennen und bestätigen lassen. Dafür läuft derselbe Dialog wie bei `/factory:config`.
4. **Labels anlegen**, `.factory/` schreiben, `.gitignore` ergänzen.
5. **Probelauf**: Gate einmal auf dem Base-Branch. Rote Checks heißen: erst das
   Projekt grün machen, bevor die Factory baut.
6. Setup ist wiederholbar: es repariert, was fehlt, und migriert die Config.

## GitHub-Repo einheitlich einrichten

Setup bringt jedes Ziel-Repo auf denselben Stand, wiederholbar und idempotent:
prüfen → Abweichung zeigen → nach Zustimmung angleichen. Wir nehmen die
bewährten Standards und diskutieren sie nicht pro Repo neu. Der Stand des
Standards ist versioniert (`"repo": { "standard": 1 }` in der Config); ein
neuer Standard kommt wie jede Config-Änderung mit Migration.

Vorhandene Dateien werden nie überschrieben. Fehlende legt Setup an, bestehende
ergänzt es nur (z. B. Badges in der README), nach gezeigtem Diff. Platzhalter
füllt Setup aus Repo und Config.

Der Standard ist für alle Ticketsysteme gleich, nur die Umsetzung je System
unterscheidet sich. Darum liegen die Vorlagen im Plugin getrennt:

```
assets/repo/
  common/    README.md, CHANGELOG.md, .gitignore, .editorconfig, LICENSE, SECURITY.md
  github/    .github/workflows/*.yml, release.yml, dependabot.yml, pull_request_template.md
  gitlab/    später: .gitlab-ci.yml (tests, conventional, changelog), MR-Template,
             Renovate statt Dependabot, Release über GitLab Releases
```

Die Repo-Einstellungen (Merge, Rulesets, Sicherheit) setzt der Tracker selbst:
`Tracker.applyStandard(standard, apply)` gibt pro Punkt Ist, Soll und Abhilfe zurück.
Der folgende Teil beschreibt die GitHub-Umsetzung; GitLab bekommt dieselben
Punkte (Conventional Commits für MRs und Pushes, Changelog nach Release,
Badges aus Pipelines) mit eigenen Mitteln.

### Repo-Einstellungen

| Bereich | Einstellung |
|---|---|
| Branches | gemergte Branches löschen (`delete_branch_on_merge`); „Update branch“ erlaubt. Lokal räumt das Tool `cleanup` Worktree, Branch und Job-Dateien auf. |
| Merge | nur Merge-Commits (Squash und Rebase aus). Titel des Merge-Commits = PR-Titel, Text = PR-Beschreibung (`merge_commit_title=PR_TITLE`, `merge_commit_message=PR_BODY`). So ist auch der Merge-Commit ein Conventional Commit. |
| Base-Branch (Ruleset) | kein Force-Push, kein Löschen. Pflicht-Checks und Pflicht-Approval erst mit dem Bot (siehe Ausblick): mit dem eigenen Login kann man den eigenen PR nicht approven, und PRs aus Workflows mit `GITHUB_TOKEN` lösen keine Checks aus. |
| Actions | nur mit voller Commit-SHA (`uses: owner/action@<sha> # v4.2.1`), Repo-Richtlinie dafür an, sofern die API sie anbietet. Standardrechte des Tokens: nur lesen. „Allow GitHub Actions to create and approve pull requests“ an (für den Changelog-PR). Das Gate prüft `.github/workflows/*.yml` zusätzlich; der builder pinnt neue Actions so. |
| Sicherheit | Secret Scanning mit Push Protection, Dependabot Alerts und Security Updates, Private Vulnerability Reporting. |
| Features | Issues an; Wiki an, wenn `docs.target = wiki`; Projects nach Config. |
| Factory | Labels (Status, `factory`, Prioritäten, `type:*`, `skip-changelog`), Orphan-Branch `factory-assets`. |

### Commits: Conventional Commits 1.0.0

Überall, ohne Ausnahme: `type(scope)!: beschreibung`, Typen `feat`, `fix`,
`docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`;
Breaking Changes mit `!` und Footer `BREAKING CHANGE: …`.

- **builder**-Commits: Regeln in `agents/builder.md`, geprüft vom code-reviewer.
- **PR-Titel**: die Factory setzt ihn conventional und daraus das Label
  `type:<typ>` (bei `!` zusätzlich `type:breaking`). Für fremde PRs prüft der
  Workflow `conventional.yml` den Titel und setzt dasselbe Label (eigener kleiner
  Bash-Check, keine fremde Action).
- **Merge-Commits**: PR-Titel über die Repo-Einstellung; `merge` übergibt ihn
  zusätzlich (`gh pr merge --merge --subject "<titel> (#<n>)"`).
- **Dependabot**: `commit-message: { prefix: chore, include: scope }` ergibt
  `chore(deps): …`.
- **Gate**: prüft alle Commits des Branches und den PR-Titel. Ein Verstoß ist
  ein FAIL wie ein roter Test.

### Menschen und Factory im selben Repo

Die Regeln gelten für jeden, nicht nur für die Factory. Darum setzt GitHub sie
selbst durch, mit Workflows im Repo; die Factory prüft dasselbe nur früher.

| Wer tut was | Was greift |
|---|---|
| Mensch öffnet einen PR | `conventional.yml` prüft PR-Titel **und** alle Commits des PRs, setzt `type:*`-Label; `tests.yml` läuft. Ein roter Check zeigt, was zu ändern ist. |
| Mensch ändert den PR-Titel | `conventional.yml` läuft erneut (`edited`), Label wird nachgezogen. |
| PR aus einem Fork | Prüfung als `pull_request` ohne Schreibrechte; das Label setzt ein getrennter Job über `pull_request_target`, der nur Titel und Commit-Texte liest und nie Code des PRs auscheckt. |
| Mensch mergt in der Oberfläche | Merge-Commit trägt den PR-Titel (Repo-Einstellung). Die Factory sieht den Merge beim nächsten Lauf und macht mit der Doku weiter. |
| Mensch pusht direkt auf den Base-Branch | `conventional.yml` prüft bei `push` die neuen Commits und meldet Verstöße im Job-Summary. Blockieren kann ein Ruleset mit Commit-Message-Muster, wo der GitHub-Plan es anbietet; sonst bleibt es bei der Meldung. |
| Mensch legt ein Issue an | normales Issue, die Factory fasst es nicht an. Mit Label `factory` übernimmt sie es (Intake). |
| Mensch setzt oder entfernt Status-Labels | die Factory gleicht beim nächsten Lauf ab: ein Status-Label je Ticket, sie meldet Abweichungen im Ticket statt still zu überschreiben. |
| Mensch veröffentlicht ein Release | `update-changelog.yml`, siehe unten. |

`conventional.yml` ist ein Workflow für Titel, Commits und
Label, eigener Bash-Check mit demselben Muster wie das Gate (eine Quelle:
das Muster steht in `.factory/config.json` und wird beim Setup in den Workflow
geschrieben).

### Releases über die GitHub-Oberfläche

Der Mensch veröffentlicht, immer. Ablauf auf GitHub: Releases → Draft a new
release → neuen Tag `vX.Y.Z` wählen → „Generate release notes“ → Publish.

- `.github/release.yml` ordnet die PRs nach Labels: Breaking Changes (`type:breaking`),
  Features (`type:feat`), Bugfixes (`type:fix`), Dokumentation (`type:docs`),
  Abhängigkeiten (`dependencies`), Sonstiges (`*`). `skip-changelog` fällt raus.
  Weil die Factory jedes PR-Label setzt, sind die generierten Notes ohne
  Nacharbeit richtig.
- Nächste Version: Das Pane zeigt im Leerlauf, was seit dem letzten Tag gemergt
  ist, und schlägt die Version nach SemVer vor (`feat` → minor, `fix` → patch,
  Breaking → major; vor 1.0.0 Breaking → minor), mit Link auf die Release-Seite.
- `/factory:release` legt auf Wunsch einen Entwurf an
  (`gh release create v1.3.0 --draft --generate-notes`) und gibt den Link aus.
  Veröffentlichen bleibt ein Klick des Menschen.

### Changelog direkt nach dem Release

Workflow `update-changelog.yml` (Idee aus clonio-cli, für die Factory neu gebaut):

1. Läuft bei `release: published` und per `workflow_dispatch` mit einem Tag
   (zum Nachtragen). Ein vom Menschen veröffentlichtes Release löst ihn aus;
   ein nur mit `GITHUB_TOKEN` erzeugtes nicht, darum veröffentlicht nie ein Workflow.
2. Steht der Tag schon in `CHANGELOG.md`, endet er ohne Änderung.
3. Liest die Notes (`gh release view <tag> --json body,publishedAt`) und trägt
   sie als `## [<tag>] - <datum>` unter `## [Unreleased]` ein, im Format
   „Keep a Changelog“, Vergleichslinks inklusive.
4. Committet über die Contents-API auf `changelog/<tag>` (so signiert GitHub den
   Commit: „Verified“), öffnet den PR `docs(changelog): update CHANGELOG for <tag>`
   mit Label `skip-changelog`.
5. Mergt ihn sofort (`gh pr merge --merge --delete-branch`). Das geht, weil der
   Base-Branch in 1.0 keine Pflicht-Checks hat. Mit dem Bot (Stufe 1) committet
   der Workflow stattdessen direkt mit App-Token, die App als Bypass im Ruleset.
6. Scheitert PR oder Merge (Einstellung aus), steht der Link im Job-Summary.

### Projekt-Grundgerüst

| Datei | Inhalt |
|---|---|
| `README.md` | Projektname als Titel, ein Satz, was das Projekt macht (aus der Repo-Beschreibung, sonst gefragt). Badges: Tests (Workflow-Badge), letztes Release, Changelog (Link auf `CHANGELOG.md`), Lizenz. Abschnitte: Was es macht, Installation, Benutzung, Entwicklung (Befehle aus den Stacks), Lizenz. |
| `CHANGELOG.md` | Kopf nach „Keep a Changelog“ und SemVer, `## [Unreleased]`. |
| `.gitignore` | GitHub-Vorlagen der Stacks (`gh api /gitignore/templates/<Name>`), dazu Betriebssystem und Editor (`.DS_Store`, `.idea/`, …), `.env*` außer `.env.example`. |
| `.editorconfig` | UTF-8, LF, abschließende Leerzeile, Einrückung je Stack. |
| `LICENSE` | gefragt (Vorschlag MIT); ohne Antwort keine Datei, README sagt es. |
| `SECURITY.md` | Meldeweg über Private Vulnerability Reporting. |
| `.github/pull_request_template.md` | Zusammenfassung, Test, `Closes #<n>`. |
| `.github/workflows/tests.yml` | bei Push auf den Base-Branch und bei PRs; dieselben Stack-Schritte wie das Gate. `permissions: contents: read`, `concurrency`, `timeout-minutes`. |
| `.github/workflows/conventional.yml` | PR-Titel und Commits prüfen (PR und Push), `type:*`-Label setzen. |
| `.github/workflows/update-changelog.yml` | siehe oben. |
| `.github/release.yml` | Kategorien der Release-Notes. |
| `.github/dependabot.yml` | `github-actions` und die Ökosysteme der Stacks, wöchentlich, gruppiert, `chore(deps)`; hält auch die SHA-Pins aktuell. |

Die SHAs der Actions löst Setup beim Anlegen auf das neueste Release auf
(`gh api repos/<action>/releases/latest`, dann Tag → Commit) und schreibt die
Version als Kommentar dahinter.

## Commands (schlanker Start)

| Command | Zweck |
|---|---|
| `/factory:setup` | prüfen, installieren, verbinden, konfigurieren, migrieren |
| `/factory:add <todos>` | Vorhaben in Issues verwandeln, mit Label `factory` |
| `/factory:run` | Backlog abarbeiten, bis nichts mehr läuft oder bereit ist |
| `/factory:run <n>` | ein Issue jetzt |
| `/factory:approve <n>` | Freigabe festhalten, ohne zu mergen |
| `/factory:merge <n>` | Freigabe durch den Menschen: ggf. approven, sync, Gate, `gh pr merge`, dann Doku |
| `/factory:feedback <n> <text>` | eskalierten Job mit Feedback in die nächste Runde |
| `/factory:choose <n> <option>` | Design-Entwurf wählen |
| `/factory:answer <n> <antwort>` | Rückfrage des Intake beantworten (als Kommentar ins Issue) |
| `/factory:reject <n> <grund>` | Job beenden, Grund ins Issue |
| `/factory:status` | was läuft, was wartet auf wen |
| `/factory:config` | geführt durch alle Einstellungen: erklärt jede, fragt per Auswahl ab |
| `/factory:config <schlüssel> <wert>` | Einstellung ändern; hängen Daten daran, erst Plan, dann Umzug als PR |
| `/factory:release [version]` | Release-Entwurf mit generierten Notes anlegen; veröffentlicht wird auf GitHub |

### Vorhaben erfassen (`/factory:add`)

Der Benutzer sagt in eigenen Worten, was er noch vorhat, als Liste oder als
Fließtext („Dark Mode, CSV-Export für Bestellungen, und die Dependabot-PRs
mergen“). Die Factory:

1. zerlegt den Text in einzelne Vorhaben, je ein Issue,
2. gibt jedem einen kurzen Titel im Imperativ und einen Body mit dem
   Wortlaut des Benutzers (keine erfundenen Anforderungen),
3. sucht nach offenen Issues, die dasselbe meinen, und schlägt statt eines
   Duplikats vor, dem bestehenden das Label `factory` zu geben,
4. zeigt die Liste zur Bestätigung, auch Reihenfolge und Abhängigkeiten
   („#2 erst nach #1“, als `Depends on #n` im Body),
5. legt die Issues mit Label `factory` an und meldet die Nummern.

Die Bewertung (Fastlane, Rückfrage, Ablehnung) bleibt beim Intake; `add`
entscheidet nicht über Scope oder Risiko. Option `--park`: Issue ohne Label
`factory` anlegen, für Vorhaben, die noch nicht laufen sollen.

## Agenten

| Agent | Modell | schreibt |
|---|---|---|
| intake | Fable | `intake.md` (DECISION, RISK, SURFACES, LANE, Scope, ggf. Fastlane-Plan) |
| fastlane | Sonnet | `fastlane.md` |
| spec-writer | Opus | `spec.md` |
| designer | Sonnet/Opus | `design/round-N/*.html`, `*.png`, `design.md` |
| builder | Opus | Commits, `build.md` |
| reviewer-code / -ux / -ui / -security | geroutet | `round-N/review-<r>.md` |
| prober | Sonnet | `round-N/probe.md` |
| approver | Opus | `decision.md` |
| documenter | Sonnet | Wiki-Seite oder `docs/…`, `docs.md` |

Regeln aus 0.5 bleiben: Agenten bekommen Kontext nur aus Dateien, Prompts nur
mit absoluten Pfaden, erste Zeilen (`VERDICT:`, `DECISION:`, `STATUS:`) sind
maschinenlesbar, jede Datei beginnt nach der Kopfzeile mit `## Summary`.
STE, Lean-Regeln und Commit-Regeln aus `builder.md`/`code-reviewer.md` werden
übernommen.

## Mod-Pane

Liest nur `.factory/status.json` (schreibt der Mod bei jedem Übergang und bei
`status`), ruft selbst kein `gh` auf.

Normalansicht:

```
Factory · acme/shop                    3/4 Slots
─────────────────────────────────────────────
Backlog bereit: 7

In Arbeit
 #42 Dark Mode        review R2  code ✓ ux ✓ ui …
 #45 CSV-Export       build  R1
 #47 Login-Endpoint   probe  R1  security …
─────────────────────────────────────────────
Fertig (heute 4)
 #40 Bump deps        fastlane  ✓
 #38 Suchfeld         merged    ✓
```

Braucht ein Job einen Menschen, ersetzt das Pane seinen Inhalt:

```
#42 Dark Mode – wartet auf dich
Design-Wahl: 3 Entwürfe
→ https://github.com/acme/shop/issues/42#issuecomment-…
Wählen: /factory:choose 42 A|B|C
(weitere wartend: #45)
```

**Grundsatz: Das Pane sagt immer, was als Nächstes zu tun ist.** Der Benutzer
muss sich keine Commands merken. Jeder wartende Zustand zeigt: was fehlt, einen
klickbaren Link, und den genauen Command zum Weitermachen, mit echter Nummer.

| Zustand | Pane zeigt | Nächster Schritt |
|---|---|---|
| `approved` | „Bereit zum Merge“, Summary des Approvers, PR-Link | `/factory:merge 42` oder auf GitHub mergen |
| `needs-human` | Frage des Approvers, PR-Link | `/factory:feedback 42 <was ändern>` · `/factory:merge 42` · `/factory:reject 42 <grund>` |
| `needs-design` | Entwürfe mit Links | `/factory:choose 42 A` · `/factory:feedback 42 <änderung>` |
| `needs-info` | Fragen an den Autor, Issue-Link | Autor antwortet im Issue; selbst Autor: `/factory:answer 42 <antwort>` |
| keine Factory läuft, Backlog > 0 | „7 Tickets bereit“ | `/factory:run` |
| Setup unvollständig | was fehlt | `/factory:setup` |
| Leerlauf | „Nichts zu tun“ | `/factory:add <vorhaben>` |

Mehrere wartende Jobs: der älteste füllt das Pane, darunter eine Zeile pro
weiterem mit Nummer und Command. Commands sind kopierbar dargestellt.

Geprüft (Mod-API 2.1.326): `Link` mit `href` gibt es auf allen Oberflächen
(terminal, desktop, vscode, mobile), Links sind also klickbar. Der Mod kann
auch Prozesse starten (`$.process.run`); er frischt `status.json` also selbst
auf, wenn keine Factory läuft. Das Zeichnen des Panes schreibt nie Tickets oder
Labels; das tun nur die Tools, wenn ein Command oder Agent sie aufruft.

## Installation beim Benutzer

Alles ist **ein Plugin**, der Mod ist ein Teil davon (wie heute in 0.5:
`hooks/hooks.json` → `register.tsx`). Skills, Agenten und Mod (samt Factory-Tools) kommen
zusammen.

- Unser GitHub-Repo ist der Marketplace (`.claude-plugin/marketplace.json`
  gibt es schon).
- Terminal: `/plugin install factory --marketplace <owner>/<repo>`
  oder aus der Shell `claude plugin install factory --marketplace <owner>/<repo>`.
- Claude Desktop (Code-Tab): `+` neben dem Eingabefeld → Plugins →
  Add marketplace `<owner>/<repo>` → Add plugin. Der Mod zeichnet dort auf der
  Oberfläche `desktop`.
- Updates kommen über den Marketplace; das Ziel-Repo bleibt frei von
  Factory-Code. Ins Ziel-Repo kommt nur `.factory/` (Config, versioniert;
  Jobs und Worktrees, ignoriert).
- Danach im Ziel-Repo: `/factory:setup`. Für Nicht-Techniker gehört genau das
  (zwei Klicks + ein Command) in die README, mit Screenshots für Desktop.
- Ist unser Repo privat, braucht die Installation einen Git-Zugang zu GitHub
  (`gh auth login`, `gh auth setup-git`); die Installation fragt nicht danach.
  Für Nicht-Techniker spricht das für ein öffentliches Repo.

## Sicherheit und Leitplanken

- Nur Issues mit `factory` laufen; Labels brauchen Triage-/Write-Rechte.
- Agenten pushen nur `factory/<id>`. Gemerged wird nur über das Tool `merge`.
- Gate und Checks kommen aus Main-Checkout und Plugin, `protectedPaths` darf
  ein Branch nicht ändern.
- Probe nur gegen 127.0.0.1 und den Job-Port.
- Max. `maxRounds` Runden, danach `needs-human`.

## Reihenfolge der Umsetzung (Vorschlag)

1. Gerüst: Mod mit Tool-Schicht (`hooks/tools.ts`), reine Logik in `lib/`, Config +
   Typen + Migrationen, Tool `doctor`, `setup`-Skill. Prüfen: installiertes Plugin
   in `claude -p` bekommt die Tools.
2. GitHub-Tracker, Labels, `queue`, `job create|advance` mit Übergangstabelle.
3. Stacks (`node`, `php` zuerst, dann `go`, `rust`, `python`, `swift`, `dotnet`) und Gate (inkl. Conventional-Commit-Prüfung).
3a. Repo-Standard: Einstellungen, Grundgerüst, Workflows (`tests`, `conventional`,
    `update-changelog`), `release.yml`, `dependabot.yml`.
4. Intake + Routing (regulär, NEEDS-INFO, REJECT), Spec, Build, Reviews, Approver,
   `/factory:merge`.
5. Mod-Pane auf `status.json`.
6. Fastlane.
7. Documenter (docs, dann Wiki).
8. Design-Iteration.
9. Probe.
10. 0.5-Teile entfernen (`serve.py`, `dashboard.html`, `board.json`, Inbox),
    README und CLAUDE.md für 1.0 neu schreiben (die Invarianten aus 0.5 gelten
    nicht mehr: Board, Inbox, `branch -D`, lokale Merges ohne Push), Version 1.0.0.

## Ausblick: Security-Review nach OWASP (Konzept folgt)

Im Bootstrap prüft der security-reviewer wie in 0.5, angepasst an Job-Dateien
und Issue-Kommentare. Später folgt ein eigenes Konzept, als Factory-Ticket:

- Prüfung je Diff nach OWASP ASVS 5.0, Level 1 und 2. Die Referenzdatei des
  Plugins enthält die ASVS-ID, das Level, eigene Prüfhinweise und die Angabe,
  wann eine Anforderung greift. Sie enthält keinen ASVS-Text (CC BY-SA) und
  nennt die Quelle. Funde nennen die ASVS-ID. Nicht betroffen heißt `n/a` und
  ergibt keinen Fund.
- Audit über das ganze Repo: Stand der Anforderungen als Checkliste, ein Issue
  je offener Anforderung (Label `security`, Level 1 zuerst), `SECURITY.md`
  zwischen Markern.
- Weitere OWASP-Standards prüfen: Top 10, API Security Top 10, MASVS
  (Swift-Apps), Top 10 for LLM Applications, Cheat Sheets als Prüfhinweise,
  SAMM für den Prozess.

Offen: Welche Kapitel greifen bei welchem Diff? Wie sieht die Referenzdatei aus?
Wo endet die Prüfung je Diff, und wo beginnt das Audit über das ganze Repo?

## Ausblick: die Factory als Bot

Ziel: Die Factory handelt als eigener Bot (`…-factory[bot]`), wie Dependabot.
Sie ist Autorin von PRs, Kommentaren und Labels; der Mensch approved. Das löst
das Problem mit dem eigenen PR, erlaubt Branch-Schutz mit Pflicht-Approval,
und PRs mit App-Token lösen GitHub Actions aus.

**Stufe 1 – eigene GitHub App je Benutzer oder Organisation (nach 1.0).**

- `/factory:setup bot` nutzt den App-Manifest-Flow von GitHub: ein Link, ein
  Klick auf „Create GitHub App“, GitHub legt die App mit den vorgegebenen
  Rechten an. Setup fängt die Rückmeldung auf einem kurzen lokalen Port ab und
  legt den privaten Schlüssel in den Schlüsselbund (macOS Keychain).
- Geht für Organisationen und für persönliche Accounts (z. B. github.com/rokde).
  Eine private App lässt sich nur im Account ihres Besitzers installieren;
  für weitere Accounts oder Organisationen die App öffentlich schalten (wer
  sie installiert, gibt dem Schlüsselbesitzer Zugriff) oder je Organisation
  eine eigene App anlegen.
- Kein Server nötig: der Mod erzeugt mit `crypto.subtle` (RS256) ein JWT
  und daraus kurzlebige Installation-Tokens (1 h), die es `gh` und `git` übergibt.
- Der eigene Login bleibt als Ausweg.
- Zu prüfen: Wiki-Push mit App-Token; GitHub Projects in persönlichen
  Accounts (Apps kommen vermutlich nur an Organisations-Projects); Commits
  des Bots als „Verified“.

**Stufe 2 – eine zentrale App von uns (Produkt, später).**

- Eine öffentliche App (z. B. `donepm-factory[bot]`), die jeder wie
  Dependabot mit einem Klick installiert.
- Braucht einen von uns betriebenen Dienst, der Benutzer anmeldet und
  Installation-Tokens ausgibt, denn der private Schlüssel der App darf nicht an
  Benutzer verteilt werden. Damit kommen Betrieb, Kosten, Sicherheitsverantwortung
  und das Vertrauen der Kunden in unseren Schreibzugriff dazu.
- Der Rest der Factory bleibt gleich: nur die Token-Quelle wechselt. Darum
  holt der Mod Tokens schon in 1.0 über eine Schnittstelle
  (`login` | `app` | `hosted`), nicht direkt.

## Offene Fragen

1. ~~Wer merged?~~ Entschieden: immer der Mensch (GitHub oder `/factory:merge`).
2. ~~Backlog-Reihenfolge~~ Entschieden: Priorität, dann älteste zuerst.
3. ~~Bilder~~ Entschieden: Orphan-Branch `factory-assets`.
4. ~~Merge-Methode~~ Entschieden: `merge`.
5. ~~Mod~~ Entschieden: ein Plugin mit allem.
6. ~~Node oder Mod-Tools?~~ Entschieden: Mod-Tools in der Engine, kein Node (siehe Laufzeit).
