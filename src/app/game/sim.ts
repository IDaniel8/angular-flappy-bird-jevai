/**
 * Deterministic-ish Flappy Bird physics. No Phaser in here — this module is the
 * single source of truth for the bird, the pipes and the score. Phaser only draws it.
 */

/** Classic playfield: 288 x 512, with a 112px ground strip at the bottom. */
export const VIEW = {
  width: 288,
  height: 512,
  groundHeight: 112,
} as const;

/** Vertical space the bird can actually fly through. */
export const PLAY_HEIGHT = VIEW.height - VIEW.groundHeight;

export const TUNING = {
  birdX: 70,
  birdWidth: 34,
  birdHeight: 24,
  /** Slightly forgiving hitbox — fairer for a model that only acts every 10 ticks. */
  hitWidth: 26,
  hitHeight: 18,

  gravity: 0.3,
  flapVelocity: -4.5,
  maxFallSpeed: 6,

  pipeSpeed: 1.4,
  pipeWidth: 52,
  /** Wide gap + soft gravity: measured, not guessed. A 10-tick blind window needs room. */
  pipeGap: 170,
  pipeSpacing: 150,
  firstPipeX: 320,
  pipeCount: 6,
  gapMargin: 50,

  /** One Jev answer buys this many physics ticks (~167ms of flight). */
  ticksPerDecision: 10,
  /** Hard caps, so a run can never eat the credit balance. */
  maxDecisions: 120,
  maxSpendUsd: 0.25,
} as const;

export type Action = 'flap' | 'glide';

export interface Pipe {
  x: number;
  /** Top edge of the gap. */
  gapY: number;
  scored: boolean;
}

export interface SimState {
  birdY: number;
  birdVy: number;
  pipes: Pipe[];
  score: number;
  ticks: number;
  dead: boolean;
  cleared: boolean;
  cause: string | null;
}

/**
 * Fresh level. Pipe gap heights are randomised on every call, so each run is
 * a new layout — the model cannot memorise one solution.
 */
export function createLevel(): SimState {
  const gapMin = TUNING.gapMargin;
  const gapMax = PLAY_HEIGHT - TUNING.pipeGap - TUNING.gapMargin;

  const pipes: Pipe[] = [];
  for (let i = 0; i < TUNING.pipeCount; i++) {
    pipes.push({
      x: TUNING.firstPipeX + i * TUNING.pipeSpacing,
      gapY: gapMin + Math.random() * (gapMax - gapMin),
      scored: false,
    });
  }

  return {
    birdY: PLAY_HEIGHT / 2,
    birdVy: 0,
    pipes,
    score: 0,
    ticks: 0,
    dead: false,
    cleared: false,
    cause: null,
  };
}

/** The model said "flap": give the bird one upward impulse. */
export function flap(state: SimState): void {
  if (state.dead || state.cleared) return;
  state.birdVy = TUNING.flapVelocity;
}

/** Advance the world by exactly one physics tick. */
export function tick(state: SimState): void {
  if (state.dead || state.cleared) return;

  state.ticks++;
  state.birdVy = Math.min(state.birdVy + TUNING.gravity, TUNING.maxFallSpeed);
  state.birdY += state.birdVy;

  const halfW = TUNING.hitWidth / 2;
  const halfH = TUNING.hitHeight / 2;
  const birdLeft = TUNING.birdX - halfW;
  const birdRight = TUNING.birdX + halfW;

  // Ceiling is solid but not fatal, like the original game.
  if (state.birdY - halfH <= 0) {
    state.birdY = halfH;
    state.birdVy = 0;
  }

  // Ground is fatal.
  if (state.birdY + halfH >= PLAY_HEIGHT) {
    state.birdY = PLAY_HEIGHT - halfH;
    state.dead = true;
    state.cause = 'hit the ground';
    return;
  }

  for (const pipe of state.pipes) {
    pipe.x -= TUNING.pipeSpeed;

    if (!pipe.scored && pipe.x + TUNING.pipeWidth < birdLeft) {
      pipe.scored = true;
      state.score++;
    }

    const overlapsX = birdRight > pipe.x && birdLeft < pipe.x + TUNING.pipeWidth;
    const outsideGap = state.birdY - halfH < pipe.gapY || state.birdY + halfH > pipe.gapY + TUNING.pipeGap;

    if (overlapsX && outsideGap) {
      state.dead = true;
      state.cause = 'hit a pipe';
      return;
    }
  }

  if (state.pipes.every((p) => p.scored)) {
    state.cleared = true;
  }
}

/** The pipe the bird is currently flying toward (or through), if any. */
export function nextPipe(state: SimState): Pipe | null {
  const birdLeft = TUNING.birdX - TUNING.hitWidth / 2;
  return state.pipes.find((p) => p.x + TUNING.pipeWidth > birdLeft) ?? null;
}

/** Copy for lookahead simulation, so the real game state is never touched. */
function clone(state: SimState): SimState {
  return { ...state, pipes: state.pipes.map((p) => ({ ...p })) };
}

/** How good an option looks: distance from the gap centre, or Infinity if it dies. */
function rollout(state: SimState, action: Action): number {
  const trial = clone(state);
  if (action === 'flap') flap(trial);

  for (let i = 0; i < TUNING.ticksPerDecision; i++) {
    tick(trial);
    if (trial.dead) return Number.POSITIVE_INFINITY;
  }

  const pipe = nextPipe(trial);
  if (!pipe) return 0;

  return Math.abs(trial.birdY - (pipe.gapY + TUNING.pipeGap / 2));
}

/**
 * Hindsight check, computed locally with no API call: from this exact state,
 * play out both options for one decision window and report which one ends up
 * better. This is the yardstick each Jev decision is graded against.
 */
export function bestAction(state: SimState): Action {
  return rollout(state, 'flap') <= rollout(state, 'glide') ? 'flap' : 'glide';
}

/** What one decision window would do, simulated without touching the live state. */
export interface Prediction {
  /** Bird centre after the window. */
  birdY: number;
  /** 'safe' if nothing is hit, otherwise what it would hit. */
  outcome: 'safe' | 'ground' | 'pipe';
}

/**
 * Play one decision window forward for a given action.
 *
 * This is pure physics we already know, so handing it to the model removes the
 * part of the task it is worst at: holding a 10-tick trajectory in its head. It
 * does not decide anything — the model still has to weigh the two outcomes.
 */
export function predict(state: SimState, action: Action): Prediction {
  const trial = clone(state);
  if (action === 'flap') flap(trial);

  for (let i = 0; i < TUNING.ticksPerDecision; i++) {
    tick(trial);
    if (trial.dead) {
      return {
        birdY: Math.round(trial.birdY),
        outcome: trial.cause === 'hit the ground' ? 'ground' : 'pipe',
      };
    }
    if (trial.cleared) break;
  }

  return { birdY: Math.round(trial.birdY), outcome: 'safe' };
}
