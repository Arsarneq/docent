# Docent — Reading Guidance

## What this is

A Docent payload is a structured recording of real sessions performed in a web browser or a desktop application, captured as structured data rather than as a script. It describes what a person did — in order, with context — so those sessions can be understood and reproduced elsewhere.

Two principles shape everything in it:

- Only real user actions are recorded. Every action is a physical thing the user did — a click, some typing, a scroll, a key press, and so on — or one of two kinds of entry that enter in a defined role: a proxy standing in for an interaction the platform's own interface delivered (a browser's back button, for example), and the entries establishing a context — a browser tab or an application window that a user action's causal chain opens or switches into, as its first change of context (a close counts as one) or later in the chain into a context first appearing there, together with the navigation that loads a context opened at a destination the action names — whether the user, the platform or the application's code opened it. Establishment entries record the context's existence for the actions that follow, never a second record of the action; a context that appears with no user action behind it is not recorded until a user action is taken in it. Every other consequence of an action — changes the application made on its own — is deliberately kept out of the action stream.
- Context is kept separate from the actions. Alongside the actions, the recording carries observed context that describes them, plus, for each step, the person's own narration or classification of intent. Context is never mixed into the actions and never invented.

The guarantee the data is built for: assuming the same application and the same backend data behind it, a consumer holding only this payload can reproduce a recorded session from a different machine — including on interfaces that load or update asynchronously.

## The payload is self-describing

The payload carries its own schema — the formal JSON Schema that defines every field precisely — and a format stamp identifying which Docent platform produced it and which version of the format it follows.

## How it is organised

A payload holds a project and its recordings. Each recording is an ordered series of steps. Each step pairs the person's context for that step — a free-text narration, or a short classification of the step's intent — with the exact actions captured while performing it. That classification is not just a label: it separates steps that record interactions the person performed from steps that record an expectation the person was checking rather than an interaction.

## Reading the steps

A recording keeps the full history of every step: when a step is edited, re-recorded, or deleted, its earlier versions are retained rather than discarded. The current state of the recording — the latest version of each step, in order — is the active view, derived like this:

1. Group the versions that belong to the same logical step.
2. Within each group, keep only the most recent version.
3. Discard versions marked as deleted.
4. Order what remains by step number.

The versions this leaves out are the earlier and deleted states, retained as history.

## Properties of specific values

- Sensitive values are masked. When the user enters something sensitive, such as a password, the recording records where the value went — the target element, flagged as masked — but not the value itself. A masked field is a parameter to fill when reproducing the session, not missing data.
- Time is descriptive, not prescriptive. Recorded timestamps and observed delays are facts about what happened; literal timing is specific to the machine that produced it. Where an action depended on the interface becoming ready, that readiness is present as an observable condition in the recorded context.
- Some identifiers are meaningful only within the session. Certain ids — for example the handle identifying a browser tab or an application window — are valid only for the session that produced them and are not stable across restarts.
- Actions carry as much identity as was observable. Where the application exposed rich descriptive information, an action identifies the element it targeted in detail; on the desktop, where it did not, the action falls back to a screen position and the surrounding geometry. Each action records its capture mode: a browser action is always captured through the page's document, a desktop action through the accessibility tree or, as the fallback, by position.

## Further reading

The full project — capture principles and format specification — is at <https://github.com/Arsarneq/docent>
