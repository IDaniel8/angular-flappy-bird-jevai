<img src="./public/favicon.ico" alt="IDaniel" width="80">

# Flappy Bird × Jev

A small harness for watching **[TypeSafe Jev](https://openrouter.ai/typesafe/jev-1.14)** play Flappy
Bird, with every decision it makes printed on a parallel screen as it happens.

The bird's only input is Jev's answer. Pick a model, press **Start**, and watch the model's typed
probabilities turn into flaps.

```
┌─────────────────────┬──────────────────────────────────────────────┐
│                     │  #46  tick 450                      98ms     │
│   288 × 512         │  flap  ████████████████████░░  0.88   FLAP   │
│   Phaser canvas     │  glide ███░░░░░░░░░░░░░░░░░░░  0.12          │
│                     │  danger █████████████████████  0.91          │
│   score / pipes     │  ✓ best move                                 │
│   "Jev is thinking" │  conf 0.82 · 402 in / 48 out · $0.00016      │
└─────────────────────┴──────────────────────────────────────────────┘
```

## Setup

```bash
npm install
# put your key in .env (get one at https://openrouter.ai/settings/keys)
#   NG_APP_OPENROUTER_KEY=sk-or-v1-...
npm start
```

Then open http://localhost:4200, optionally choose a model, and press **Start**.

`npm start` and `npm run build` first run `tools/gen-env.mjs`, which reads `.env` and writes
`src/environments/env.generated.ts` (git-ignored). If you change `.env`, restart the dev server.

> **The key ends up in the JavaScript bundle.** That is unavoidable for a pure browser app and fine
> for local use, but anyone who can load a deployed build can read it. Keep this local, or move the
> call behind a proxy before publishing.

## How it works

Jev is a **System One decision model**, not a chat model. You send it a `state` object plus typed
questions, and it returns typed answers **with probabilities instead of prose**.

Each decision is a single `POST https://openrouter.ai/api/alpha/decisions` carrying two questions,
answered in parallel for the price of one call:

| Question | Type     | What it returns                       | Used for |
| -------- | -------- | ------------------------------------- | -------- |
| `action` | `choice` | `flap` vs `glide` + probabilities     | **drives the bird, verbatim** |
| `danger` | `noul`   | probability a crash is imminent (0–1) | second opinion, logged only |

Nothing overrides `action`. There is no human-written safety rule: if Jev says glide, the bird glides,
even straight into a pipe. That is deliberate — the thing being measured is Jev, not a heuristic
wrapped around it.

The `state` also carries the **simulated outcome of both options** for the coming window —
`if_you_glide` and `if_you_flap`, each with the bird's y position after the 10 ticks and whether it
would crash. These are exact, not estimates: `predict()` in `sim.ts` runs the same `tick()` the game
uses, checked against 1,688 replays with zero mismatches.

The `choice` **criteria are written against those fields**, not against the world. That single wording
choice is worth more than every physics and pacing setting in this repo combined — it is the difference
between clearing 0/5 levels and 4/5. See
[Educational: the prompt *is* the whole game](#educational-the-prompt-is-the-whole-game).

The call goes through `@openrouter/sdk` (`alpha.decisions.create`), so the response arrives as a typed
discriminated union — `answers.action` is only readable as a `choice` after narrowing on `type` — and
the SDK maps the wire's `snake_case` to `camelCase` for us. It is imported through its tree-shakeable
entry points (`/core.js` + `/funcs/alphaDecisionsCreate.js`), which keeps it at ~36 kB gzipped; the
plain `import { OpenRouter } from '@openrouter/sdk'` costs ~118 kB because it pulls in every endpoint.

### How accuracy is measured

Every tap is graded locally, with no extra API call. From the exact state Jev saw, `bestAction()` in
`src/app/game/sim.ts` plays the window out twice — once flapping, once gliding — and keeps whichever
option survives and ends up closer to the gap centre. If Jev picked that option, the tap is marked
`✓ best move`; otherwise `✗ best was <action>`, so you can see at a glance which calls it got wrong.

The header keeps a running total, e.g. `94% accuracy · 77 taps`.

Treat it as a strong hint rather than ground truth: it is a one-step lookahead, not an oracle, and it
can be short-sighted. But it is computed identically for every model and every run, so comparisons
between models are fair.

### Why the game pauses

A decision takes a few hundred milliseconds; the game wants input every 16 ms. So the loop is
**lockstep**: one Jev answer buys **10 physics ticks** (~167 ms of flight), then the world holds still
until the next answer arrives. That pause is the latency being measured, and it is what makes the log
readable.

Those 10 ticks are paced by a **fixed 60 Hz clock**. `nextTickSlot()` waits on *elapsed time*, not on
"the next animation frame" — on a 120/240 Hz display rAF fires far faster than the simulation should
run, and a 10-tick window would blast past in a ~40 ms jerk followed by a pause, which reads as stutter.

When the tab is hidden the browser suspends rAF entirely, so the pacing is skipped rather than awaited;
otherwise switching tabs mid-run would deadlock the game forever at the first tap.

### Level and cost

Each **Start** builds a new level: 6 pipes with randomly placed gaps, so nothing can be memorised.

|                              |                                                |
| ---------------------------- | ---------------------------------------------- |
| Taps to clear the level      | ~77                                            |
| Hard tap cap                 | 120                                            |
| Hard spend cap               | $0.25 (checked after every call)               |
| Typical cost per run         | **~$0.002** measured (76 taps, ~681 in / 51 out each) |

A run ends with either *Level cleared* or *Game over* and usually takes 1–2 minutes of wall clock.

## Educational: the prompt *is* the whole game

If you take one thing from this repo, take this: for a decision model the `criteria` strings are **not
documentation — they are the model's entire understanding of the task**. Jev does not reason, does not
remember, and has no idea what Flappy Bird is. It maps `state` + `criteria` to a probability per
option. Get the wording wrong and no amount of physics tuning, tick pacing or gap widening rescues it.

### ❌ The bad prompt (what this repo shipped first)

```ts
criteria: {
  flap: 'Flap now. The bird is too low and will hit the ground or the bottom pipe before the next decision.',
  glide: 'Do not flap. The bird is high enough, or still rising, and flapping would push it into the top pipe.',
}
```

Read as English these are *conditional* descriptions — "if the bird is too low…". A decision model
reads them as statements about **this** request. Meanwhile the same request carried:

```json
"if_you_glide": { "bird_y_after_window": 217, "crashes": false },
"if_you_flap":  { "bird_y_after_window": 172, "crashes": false }
```

*"You will hit the ground"* and `crashes: false`, in one request. Faced with two contradictory signals
the model took the only safe route available: it answered **0.50 / 0.50** and effectively guessed.

### ✅ The good prompt (current)

```ts
criteria: {
  flap: 'Flap. Choose this when if_you_glide.crashes is true, or when if_you_flap.bird_y_after_window is closer to next_pipe.gap_centre_y than if_you_glide.bird_y_after_window.',
  glide: 'Glide. Choose this when if_you_glide.crashes is false and if_you_glide.bird_y_after_window is at least as close to next_pipe.gap_centre_y as if_you_flap.bird_y_after_window.',
}
```

Same model, same game, same request shape. The criteria now name the fields they depend on, so the
prose and the numbers agree and the model commits to an answer.

### Measured difference

5 live runs per version, everything else identical:

| Prompt | Accuracy | Pipes reached | Levels cleared |
| --- | --- | --- | --- |
| ❌ prose | 77.4% ± 5.5 | 1.0 ± 0.9 | 0 / 5 |
| ✅ fields | **89.2% ± 3.7** | **5.6** | **4 / 5** |

`p ≈ 0.004` on accuracy (t-test), Fisher `p ≈ 0.05` on clear rate.

Worth noting what did *not* matter, measured the same way: tick cadence (K=4…24, K=10 already optimal),
horizontal pipe spacing (120…300 px, flat within noise), and frame pacing (proven neutral — identical
replays with and without real-time delays between ticks). Only two levers moved the needle: this
wording, and the vertical gap size.

### Try it yourself

1. Open **`src/app/jev.ts`** and find `QUESTIONS.action.criteria` (line ~61).
2. Paste the **❌ bad** strings in, restart `npm start`, play 5 games.
3. Paste the **✅ good** strings back, restart, play 5 games.
4. Compare the `accuracy` figure in the header and the pipes the bird reaches.

**The tell to watch for:** open any log card. If you see `flap 0.50 · glide 0.50`, the criteria and the
state are contradicting each other and the model is guessing. A perfectly even split is never a
confident decision — it is a model with no signal.

### Where to go next

You *can* make the prompt more explicit still and push accuracy higher — but past this point you are
measuring "can the model follow a stated rule", not "can the model judge a situation". The current
version is deliberately the minimum help needed to make the model decisive.

For the harder experiment, do the opposite: drop the `if_you_glide` / `if_you_flap` fields **and** the
prose criteria, and ask the model to judge from `bird`, `next_pipe` and `physics` alone. Same harness,
same 5-run comparison — a genuinely open question about the model rather than about instruction
following.

## Files

| File                              | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `src/app/app.ts`                  | The loop: ask → apply → tick ×10 → repeat.            |
| `src/app/jev.ts`                  | The only network code, via `@openrouter/sdk`.         |
| `src/app/game/sim.ts`             | Pure physics + level generation + the accuracy grader.|
| `src/app/game/scene.ts`           | Phaser scene. Renders sim state, never owns physics.  |
| `src/app/game/game-canvas.ts`     | Angular host for the Phaser instance.                 |
| `src/app/decision-log/`           | The parallel screen and how each tap is graded.       |
| `tools/gen-env.mjs`               | Turns `.env` into a typed TS module.                  |

## Tuning

Everything interesting is a constant in `TUNING` (`src/app/game/sim.ts`): gravity, flap impulse, gap
size, pipe count, `ticksPerDecision`, and both caps. The defaults are measured rather than guessed —
a 10-tick blind window needs a wide gap and soft gravity, otherwise even a perfect decision-maker
crashes at the first pipe.

## Notes and limits

- **Jev returns no reasoning.** It answers with probabilities and confidence; it does not explain
  itself. The log screen shows the decision, never a justification. Prose would need a second call to
  a chat model.
- Models come from a fixed list (`typesafe/jev-1.14`, `~typesafe/jev-latest`, `typesafe/jev-1.13`).
  Other decision models take the same request shape — edit `MODELS` in `src/app/app.ts`.
- Requests are grouped with a `session_id`, so a run is easy to find in the OpenRouter activity view.

## Assets

Sprites and audio from [samuelcust/flappy-bird-assets](https://github.com/samuelcust/flappy-bird-assets)
(MIT, © 2019 Samuel Custodio) — see `public/LICENSE`.

They live flat in `public/sprites/` and `public/audio/`, which Angular copies to the build output root
untouched, so Phaser can load them as plain runtime URLs (`sprites/yellowbird-midflap.png`).
