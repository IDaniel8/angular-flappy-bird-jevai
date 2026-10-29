import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  input,
  signal,
  viewChild,
} from '@angular/core';

/** One Jev round-trip, rendered verbatim on the parallel screen. */
export interface DecisionLogEntry {
  seq: number;
  tick: number;
  latencyMs: number;
  action: 'flap' | 'glide';
  /** The action a one-step lookahead would have taken from the same state. */
  ideal: 'flap' | 'glide';
  /** True when Jev picked the same action as that lookahead. */
  matched: boolean;
  flapProbability: number;
  glideProbability: number;
  confidence: number | null;
  danger: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  request: unknown;
  response: unknown;
}

@Component({
  selector: 'app-decision-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './decision-log.html',
  styleUrl: './decision-log.scss',
})
export class DecisionLog {
  readonly entries = input.required<DecisionLogEntry[]>();

  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');
  readonly opened = signal<number | null>(null);

  constructor() {
    // Keep the newest decision in view, like a console that is following along.
    afterRenderEffect(() => {
      this.entries();
      const el = this.scroller().nativeElement;
      el.scrollTop = el.scrollHeight;
    });
  }

  toggle(seq: number): void {
    this.opened.update((current) => (current === seq ? null : seq));
  }

  fixed(value: number | null, digits = 2): string {
    return value === null ? '—' : value.toFixed(digits);
  }

  json(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
}
