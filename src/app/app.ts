import { ChangeDetectionStrategy, Component, computed, signal, viewChild } from '@angular/core';
import { DecisionLog, type DecisionLogEntry } from './decision-log/decision-log';
import { GameCanvas } from './game/game-canvas';
import { bestAction, createLevel, flap, tick, TUNING } from './game/sim';
import { API_KEY, askJev, choiceAnswer, noulAnswer, type JevDecision } from './jev';

const MODELS = ['typesafe/jev-1.14', '~typesafe/jev-latest', 'typesafe/jev-1.13'];

/** One physics tick of game time. */
const TICK_MS = 1000 / 60;

/**
 * Wait until the next simulation tick is due.
 *
 * Deliberately time-gated rather than "one tick per animation frame". On a
 * 120/240 Hz display rAF fires far faster than the simulation should run, so
 * frame-pacing made a 10-tick window blast past in ~40 ms — a jerk followed by a
 * pause, which reads as stutter. Gating on elapsed time holds the game at a
 * constant 60 ticks per second whatever the refresh rate.
 *
 * rAF is suspended entirely while the tab is hidden, so don't wait at all then
 * — otherwise the run deadlocks mid-flight the moment the window loses focus.
 * The timer is a fallback in case rAF stalls for any other reason.
 */
function nextTickSlot(): Promise<void> {
  if (document.hidden) return Promise.resolve();

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const poll = () => {
      if (performance.now() - startedAt >= TICK_MS - 1) finish();
      else requestAnimationFrame(poll);
    };

    requestAnimationFrame(poll);
    setTimeout(finish, TICK_MS + 60);
  });
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GameCanvas, DecisionLog],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly canvas = viewChild.required(GameCanvas);

  readonly models = MODELS;
  readonly hasKey = API_KEY.length > 0;
  readonly pipeCount = TUNING.pipeCount;

  readonly model = signal(MODELS[0]);
  readonly status = signal<'idle' | 'running' | 'over'>('idle');
  readonly entries = signal<DecisionLogEntry[]>([]);
  readonly score = signal(0);
  readonly totalSpend = signal(0);
  readonly lastLatency = signal(0);
  readonly matched = signal(0);
  readonly errorMessage = signal<string | null>(null);
  readonly verdict = signal('');

  /** Share of taps where Jev picked the same action a one-step lookahead would. */
  readonly accuracy = computed(() => {
    const total = this.entries().length;
    return total === 0 ? null : Math.round((this.matched() / total) * 100);
  });

  readonly canStart = computed(() => this.hasKey && this.status() !== 'running');
  readonly canStop = computed(() => this.status() === 'running');

  private controller: AbortController | null = null;

  async start(): Promise<void> {
    if (!this.canStart()) return;

    this.entries.set([]);
    this.score.set(0);
    this.totalSpend.set(0);
    this.lastLatency.set(0);
    this.matched.set(0);
    this.errorMessage.set(null);
    this.verdict.set('');

    // A fresh level every time, with freshly randomised pipe gaps.
    const sim = createLevel();
    const view = this.canvas().view;
    view.state = sim;
    view.status = 'playing';

    this.status.set('running');
    this.controller = new AbortController();
    const signal = this.controller.signal;

    let seq = 0;

    while (!sim.dead && !sim.cleared) {
      if (seq >= TUNING.maxDecisions) {
        this.verdict.set(`Stopped at the ${TUNING.maxDecisions}-decision cap.`);
        break;
      }
      if (this.totalSpend() >= TUNING.maxSpendUsd) {
        this.verdict.set(`Stopped at the $${TUNING.maxSpendUsd.toFixed(2)} spend cap.`);
        break;
      }

      // The world holds still while the model thinks. That pause *is* the latency.
      view.status = 'thinking';

      let decision: JevDecision;
      try {
        decision = await askJev(this.model(), sim, signal);
      } catch (error) {
        if (signal.aborted) break;

        this.errorMessage.set(error instanceof Error ? error.message : String(error));
        this.status.set('over');
        this.verdict.set('Request failed — see the error above.');
        this.controller = null;
        return;
      }

      const actionAnswer = choiceAnswer(decision.response, 'action');
      const probabilities = actionAnswer?.probabilities ?? {};

      const flapProbability = probabilities['flap'] ?? 0;
      const glideProbability = probabilities['glide'] ?? 0;
      const danger = noulAnswer(decision.response, 'danger');

      // Jev plays the game. Its answer is executed verbatim — no guardrail, no override.
      const action = actionAnswer?.choice === 'flap' ? 'flap' : 'glide';

      // Grade this tap against a local lookahead of both options.
      const ideal = bestAction(sim);
      const matched = action === ideal;

      const usage = decision.response.usage;
      seq++;

      const entry: DecisionLogEntry = {
        seq,
        tick: sim.ticks,
        latencyMs: decision.latencyMs,
        action,
        ideal,
        matched,
        flapProbability,
        glideProbability,
        confidence: actionAnswer?.confidence ?? null,
        danger,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: usage.cost ?? 0,
        request: decision.request,
        response: decision.response,
      };
      this.entries.update((list) => [...list, entry]);
      if (matched) this.matched.update((count) => count + 1);

      this.totalSpend.update((total) => total + (usage.cost ?? 0));
      this.lastLatency.set(decision.latencyMs);
      view.status = 'playing';

      if (action === 'flap') {
        flap(sim);
        view.sfx = 'flap';
      }

      const scoreBefore = sim.score;
      // One tick per painted frame, so the window is visible flight instead of a jump cut.
      for (let i = 0; i < TUNING.ticksPerDecision && !sim.dead; i++) {
        if (signal.aborted) break;
        await nextTickSlot();
        tick(sim);
      }
      if (sim.score > scoreBefore) {
        view.sfx = 'score';
      }

      this.score.set(sim.score);
      view.status = sim.dead ? 'dead' : sim.cleared ? 'cleared' : 'playing';
    }

    this.controller = null;
    this.status.set('over');

    if (sim.cleared) {
      view.status = 'cleared';
      this.verdict.set(`Level cleared — ${sim.score}/${TUNING.pipeCount} pipes.`);
    } else if (sim.dead) {
      view.status = 'dead';
      this.verdict.set(`Game over — ${sim.cause}, score ${sim.score}.`);
    } else {
      view.status = 'idle';
      if (!this.verdict()) this.verdict.set('Run ended.');
    }
  }

  stop(): void {
    if (!this.canStop()) return;

    this.verdict.set('Stopped by you.');
    this.controller?.abort();
  }

  money(value: number): string {
    return '$' + value.toFixed(4);
  }

}

