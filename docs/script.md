# Making a video with an agent: script first

Recording is the expensive step. A note on a finished cut means a re-record, so put a cheap,
reviewable step in front of every expensive one. The script lives in the project from the first
outline to the prompter, and the person and the agent work on the same document: the person in the
app's **Script** view, the agent through `neon-cli script` and `neon-cli notes`.

## The loop

Each step ends with the person's sign-off, shown as a section's status: **draft** while it is being
written, **your turn** (`review`) when it waits on the person, **approved** when it is signed off.

1. **Brief.** The person says what the video is: the project, what it should prove, who it is for.
   The agent writes an outline with `neon-cli script set`: sections with an intent and a line or two
   each, marked `review`.
2. **Script.** Every line has two halves: what you **say** and what the picture **shows**. The
   person rewrites words in place and pins notes to lines they don't like. The agent reads
   `neon-cli notes`, changes the script, replies on each note and leaves it for the person to
   resolve.
3. **Storyboard.** The agent grabs one real still per line from the app being demoed, imports it and
   attaches it with `neon-cli script edit 4.2 --still <asset>`. The person sees every shot before
   anything is recorded, and notes the ones to change.
4. **Record.** The recorder works from the approved script. Recorded lines are placed on the
   timeline (`at`), which makes them the prompter's cues for a voice-over take.
5. **Cut review.** The person watches the cut, pauses where something is wrong and presses **note**
   on the preview. The note is pinned to that moment: a diamond on the ruler and a thread in the
   Script view. The agent fixes what the notes touch and re-records only those sections.

## Notes

A note is pinned to a line, a section or a moment of the cut. It has an author (`person` or `agent`),
replies, and stays open until someone resolves it. Notes are numbered by when they were written, so
`#3` keeps its number. A note on a line that is later deleted stays, pinned to "a deleted line",
until someone resolves it.

In the app, hover a line and press **note**, or press **note** by a section title. Reply in the
thread with Enter. The **Script** button in the title bar counts open notes.

## Keys in the Script view

| Key | In a line's words |
| --- | --- |
| Enter | Save and start a new line below |
| Shift+Enter | New paragraph in the line |
| Alt+↑ / Alt+↓ | Move the line, across sections at the edges |
| Esc | Drop the edit |

Deleting a line or a section is undoable.
