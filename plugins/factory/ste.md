# Text for people: ASD-STE100 rules

The factory writes all text for people to these rules.

## Scope
These rules cover:
- the messages of the main session and the skills in the command line,
- the tool results,
- the error texts and their `Fix:` lines,
- the issue comments and the text in marker comments,
- the PR text,
- the issues that `/factory:add` creates.

## English
Use Simplified Technical English (ASD-STE100):
- Use short sentences. A sentence has at most 20 words.
- Write one instruction in each sentence.
- Use the active voice.
- Use approved, common words. Each word has one meaning.
- Use one term for one thing. Do not change the term in the same text.

## Other languages
When the text is in another language, use the same principles in that language:
- Use short sentences.
- Use clear words.
- Give one step at a time.

## Parts that stay in English
These parts stay in English and keep their format:
- the machine-read first lines (`DECISION:`, `STATUS:`, `VERDICT:`, `RISK:`, `SURFACES:`, `LANE:`, `Title:`),
- the section headings,
- the fixed keywords (for example `Fix:`, `AC-<n>`, `Test:`, `(regression)`, `[blocker]`),
- the marker comments (for example `<!-- factory:spec -->`),
- the commit messages and the PR titles,
- the code.
