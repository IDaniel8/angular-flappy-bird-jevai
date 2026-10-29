/**
 * Everything that talks to OpenRouter lives here.
 *
 * Jev is a *decision* model, not a chat model: it answers typed questions about a
 * `state` you send, and returns probabilities instead of prose.
 * Docs: https://openrouter.ai/docs/guides/community/jev
 */
import { OpenRouterCore } from '@openrouter/sdk/core.js';
import { alphaDecisionsCreate } from '@openrouter/sdk/funcs/alphaDecisionsCreate.js';
import type {
  DecisionsChoiceAnswer,
  DecisionsRequest,
  DecisionsResponse,
} from '@openrouter/sdk/models';

import {
  PLAY_HEIGHT,
  nextPipe,
  predict,
  TUNING,
  type Prediction,
  type SimState,
} from './game/sim';

import { ENV } from '../environments/env.generated';

/**
 * Injected at build time from the git-ignored `.env` file by tools/gen-env.mjs,
 * which the prestart / prebuild / postinstall npm scripts run automatically.
 */
export const API_KEY = ENV.openRouterKey;

/** Grouping id so every request of this browser session is easy to find in the dashboard. */
const SESSION_ID = crypto.randomUUID();

let client: OpenRouterCore | null = null;

/** Built lazily so a missing key doesn't throw at import time. */
function openRouter(): OpenRouterCore {
  client ??= new OpenRouterCore({ apiKey: API_KEY, appTitle: 'Flappy Bird Jev' });
  return client;
}

export interface JevDecision {
  latencyMs: number;
  request: DecisionsRequest;
  response: DecisionsResponse;
}

/**
 * Two questions about the same state, answered in parallel for the price of one
 * request. `action` is what the bird actually does — nothing overrides it.
 * `danger` is a second, independent read of the situation, logged for comparison.
 */
export const QUESTIONS = {
  action: {
    type: 'choice',
    instructions:
      'The bird only moves when it flaps. Decide what it should do for the next 10 physics ticks. ' +
      'The state already contains the simulated outcome of both options in if_you_glide and if_you_flap — use them.',
    criteria: {
      flap: 'Flap. Choose this when if_you_glide.crashes is true, or when if_you_flap.bird_y_after_window is closer to next_pipe.gap_centre_y than if_you_glide.bird_y_after_window.',
      glide: 'Glide. Choose this when if_you_glide.crashes is false and if_you_glide.bird_y_after_window is at least as close to next_pipe.gap_centre_y as if_you_flap.bird_y_after_window.',
    },
  },
  danger: {
    type: 'noul',
    instructions:
      'If the bird does not flap at all, will it crash into a pipe or the ground within the next 10 physics ticks?',
    criteria: {
      true: 'A collision is imminent.',
      false: 'The bird can survive the next 10 ticks without flapping.',
    },
  },
} as const;

/** The `choice` answer for a question, or null if it came back as something else. */
export function choiceAnswer(
  response: DecisionsResponse,
  question: string,
): DecisionsChoiceAnswer | null {
  const answer = response.answers[question];
  return answer?.type === 'choice' ? answer : null;
}

/** Probability of "yes" for a `noul` question, or 0 if the answer is a different type. */
export function noulAnswer(response: DecisionsResponse, question: string): number {
  const answer = response.answers[question];
  return answer?.type === 'noul' ? answer.noul : 0;
}

/** Turn the simulation into the compact state object the model reads. */
function buildState(state: SimState): Record<string, unknown> {
  const pipe = nextPipe(state);
  const index = pipe ? state.pipes.indexOf(pipe) : -1;
  const after = index >= 0 ? (state.pipes[index + 1] ?? null) : null;

  const gapCentre = pipe ? pipe.gapY + TUNING.pipeGap / 2 : 0;
  const distance = pipe ? Math.round(pipe.x - TUNING.birdX) : 0;
  const aboveCentre = Math.round(gapCentre - state.birdY);
  const remaining = state.pipes.filter((p) => !p.scored).length;

  const motion = state.birdVy < -1 ? 'rising' : state.birdVy > 2 ? 'falling fast' : 'falling';

  // Where each option actually lands. Deterministic physics we already know, so
  // the model doesn't have to simulate a 10-tick trajectory in its head.
  const glide = predict(state, 'glide');
  const hop = predict(state, 'flap');

  const describe = (p: Prediction): string =>
    p.outcome === 'safe'
      ? `y=${p.birdY} without crashing`
      : `y=${p.birdY} and crashing into the ${p.outcome === 'ground' ? 'ground' : 'pipe'}`;

  const scenario =
    `Over the next ${TUNING.ticksPerDecision} ticks: gliding ends at ${describe(glide)}; ` +
    `flapping ends at ${describe(hop)}.`;

  const situation = pipe
    ? `The bird is ${Math.abs(aboveCentre)}px ${aboveCentre >= 0 ? 'above' : 'below'} the gap centre ` +
      `and ${distance}px away from the next pipe, ${motion}. ${remaining} of ${TUNING.pipeCount} pipes left. ${scenario}`
    : `All pipes are cleared. ${scenario}`;

  return {
    situation,
    if_you_glide: {
      bird_y_after_window: glide.birdY,
      crashes: glide.outcome !== 'safe',
      would_hit: glide.outcome,
    },
    if_you_flap: {
      bird_y_after_window: hop.birdY,
      crashes: hop.outcome !== 'safe',
      would_hit: hop.outcome,
    },
    score: state.score,
    pipes_remaining: remaining,
    playfield_height: PLAY_HEIGHT,
    physics: {
      gravity_per_tick: TUNING.gravity,
      flap_impulse: TUNING.flapVelocity,
      max_fall_speed: TUNING.maxFallSpeed,
      pipe_speed_per_tick: TUNING.pipeSpeed,
      ticks_until_next_decision: TUNING.ticksPerDecision,
    },
    bird: {
      y: Math.round(state.birdY),
      vertical_speed: Number(state.birdVy.toFixed(2)),
      motion,
    },
    next_pipe: pipe
      ? {
          horizontal_distance: distance,
          gap_top_y: Math.round(pipe.gapY),
          gap_bottom_y: Math.round(pipe.gapY + TUNING.pipeGap),
          gap_centre_y: Math.round(gapCentre),
          bird_is_above_gap_centre_by: aboveCentre,
          ticks_until_arrival: Math.round(distance / TUNING.pipeSpeed),
        }
      : null,
    pipe_after_next_gap_centre_y: after ? Math.round(after.gapY + TUNING.pipeGap / 2) : null,
  };
}

/** One decision round-trip. Throws on network/API errors so the UI can report them. */
export async function askJev(
  model: string,
  state: SimState,
  signal: AbortSignal,
): Promise<JevDecision> {
  if (!API_KEY) {
    throw new Error('Missing NG_APP_OPENROUTER_KEY. Add it to .env and restart the dev server.');
  }

  const request: DecisionsRequest = {
    model,
    state: buildState(state),
    questions: QUESTIONS,
    sessionId: SESSION_ID,
  };

  const startedAt = performance.now();

  const result = await alphaDecisionsCreate(
    openRouter(),
    { decisionsRequest: request },
    { fetchOptions: { signal } },
  );

  if (!result.ok) {
    const detail =
      (result.error as { message?: string } | undefined)?.message ?? String(result.error);
    throw new Error(detail);
  }

  return { latencyMs: Math.round(performance.now() - startedAt), request, response: result.value };
}
