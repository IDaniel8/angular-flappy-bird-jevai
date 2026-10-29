import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  viewChild,
} from '@angular/core';
import Phaser from 'phaser';
import { FlappyScene, type GameView } from './scene';
import { VIEW } from './sim';

/** Owns the Phaser instance and nothing else. The view object is shared with App. */
@Component({
  selector: 'app-game-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="host"></div>`,
  styleUrl: './game-canvas.scss',
})
export class GameCanvas implements AfterViewInit, OnDestroy {
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  readonly view: GameView = { state: null, status: 'idle', sfx: null };

  private game?: Phaser.Game;

  ngAfterViewInit(): void {
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: this.host().nativeElement,
      width: VIEW.width,
      height: VIEW.height,
      backgroundColor: '#4ec0ca',
      pixelArt: true,
      roundPixels: true,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [new FlappyScene(this.view)],
    });
  }

  ngOnDestroy(): void {
    this.game?.destroy(true);
    this.game = undefined;
  }
}
