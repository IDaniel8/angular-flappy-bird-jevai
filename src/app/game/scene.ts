/**
 * Phaser is only the renderer here. Every frame it copies the numbers out of
 * `view.state` (owned by sim.ts) onto sprites. It never owns physics or timing.
 */
import Phaser from 'phaser';
import { PLAY_HEIGHT, TUNING, VIEW, type SimState } from './sim';

const SPRITES = 'sprites/';
const AUDIO = 'audio/';

export type ViewStatus = 'idle' | 'playing' | 'thinking' | 'dead' | 'cleared' | 'error';
export type Sfx = 'flap' | 'score' | 'hit' | null;

/** Shared mutable object: Angular writes it, Phaser reads it. */
export interface GameView {
  state: SimState | null;
  status: ViewStatus;
  /** Fire-and-forget sound request, cleared by the scene once played. */
  sfx: Sfx;
}

const FLAP_FRAMES = ['bird-up', 'bird-mid', 'bird-down', 'bird-mid'];

export class FlappyScene extends Phaser.Scene {
  private bird!: Phaser.GameObjects.Sprite;
  private ground!: Phaser.GameObjects.TileSprite;
  private message!: Phaser.GameObjects.Image;
  private gameOverImage!: Phaser.GameObjects.Image;
  private pipeTops: Phaser.GameObjects.Image[] = [];
  private pipeBottoms: Phaser.GameObjects.Image[] = [];
  private scoreDigits: Phaser.GameObjects.Image[] = [];
  private sounds: Partial<Record<'flap' | 'score' | 'hit', Phaser.Sound.BaseSound>> = {};

  constructor(private readonly view: GameView) {
    super('flappy');
  }

  preload(): void {
    this.load.image('bg', SPRITES + 'background-day.png');
    this.load.image('ground', SPRITES + 'base.png');
    this.load.image('pipe', SPRITES + 'pipe-green.png');
    this.load.image('message', SPRITES + 'message.png');
    this.load.image('gameover', SPRITES + 'gameover.png');
    this.load.image('bird-up', SPRITES + 'yellowbird-upflap.png');
    this.load.image('bird-mid', SPRITES + 'yellowbird-midflap.png');
    this.load.image('bird-down', SPRITES + 'yellowbird-downflap.png');

    for (let i = 0; i <= 9; i++) {
      this.load.image('d' + i, SPRITES + i + '.png');
    }

    this.load.audio('flap', AUDIO + 'wing.wav');
    this.load.audio('score', AUDIO + 'point.wav');
    this.load.audio('hit', AUDIO + 'hit.wav');
  }

  create(): void {
    this.add.image(0, 0, 'bg').setOrigin(0, 0);

    for (let i = 0; i < TUNING.pipeCount; i++) {
      this.pipeTops.push(this.add.image(0, 0, 'pipe').setOrigin(0.5, 1).setFlipY(true));
      this.pipeBottoms.push(this.add.image(0, 0, 'pipe').setOrigin(0.5, 0));
    }

    // Ground is added after the pipes so it masks their lower ends.
    this.ground = this.add
      .tileSprite(0, PLAY_HEIGHT, VIEW.width, VIEW.groundHeight, 'ground')
      .setOrigin(0, 0);

    this.bird = this.add.sprite(TUNING.birdX, PLAY_HEIGHT / 2, 'bird-mid').setDepth(10);

    for (let i = 0; i < 3; i++) {
      this.scoreDigits.push(this.add.image(0, 70, 'd0').setVisible(false).setDepth(20));
    }

    this.message = this.add.image(VIEW.width / 2, 190, 'message').setDepth(30);
    this.gameOverImage = this.add.image(VIEW.width / 2, 190, 'gameover').setVisible(false).setDepth(30);

    this.sounds.flap = this.sound.add('flap', { volume: 0.5 });
    this.sounds.score = this.sound.add('score', { volume: 0.4 });
    this.sounds.hit = this.sound.add('hit', { volume: 0.5 });
  }

  override update(): void {
    if (this.view.sfx) {
      this.sounds[this.view.sfx]?.play();
      this.view.sfx = null;
    }

    const state = this.view.state;
    const status = this.view.status;

    if (!state || status === 'idle' || status === 'error') {
      this.showIdle();
      return;
    }

    this.message.setVisible(false);
    // Only a crash is a game over — a cleared level is not.
    this.gameOverImage.setVisible(status === 'dead');

    // Wings beat on ticks while flying, and keep beating on wall-clock time while
    // waiting for the next decision — the pause reads as "thinking", not "frozen".
    const beat = status === 'thinking' ? this.time.now / 60 : state.ticks / 3;
    this.bird.setTexture(FLAP_FRAMES[Math.floor(beat) % FLAP_FRAMES.length]);
    this.bird.setPosition(TUNING.birdX, state.birdY);
    this.bird.setAngle(Phaser.Math.Clamp(state.birdVy * 4, -25, 90));
    if (status === 'dead') {
      this.bird.setAngle(90);
    }

    state.pipes.forEach((pipe, i) => {
      const top = this.pipeTops[i];
      const bottom = this.pipeBottoms[i];
      if (!top || !bottom) return;

      const centreX = pipe.x + TUNING.pipeWidth / 2;
      top.setVisible(true).setPosition(centreX, pipe.gapY);
      bottom.setVisible(true).setPosition(centreX, pipe.gapY + TUNING.pipeGap);
    });

    // Scroll tied to sim ticks, so the ground never drifts out of sync with the pipes.
    this.ground.tilePositionX = state.ticks * TUNING.pipeSpeed;

    this.drawScore(state.score);
  }

  private showIdle(): void {
    const bob = PLAY_HEIGHT / 2 + Math.sin(this.time.now / 300) * 8;

    this.bird.setTexture(FLAP_FRAMES[Math.floor(this.time.now / 120) % FLAP_FRAMES.length]);
    this.bird.setPosition(TUNING.birdX, bob).setAngle(0);
    this.ground.tilePositionX = this.time.now / 40;

    this.message.setVisible(true);
    this.gameOverImage.setVisible(false);
    this.pipeTops.forEach((p) => p.setVisible(false));
    this.pipeBottoms.forEach((p) => p.setVisible(false));
    this.scoreDigits.forEach((d) => d.setVisible(false));
  }

  private drawScore(score: number): void {
    const text = String(score);
    const spacing = 14;
    const startX = VIEW.width / 2 - ((text.length - 1) * spacing) / 2;

    this.scoreDigits.forEach((digit, i) => {
      const char = text[i];
      if (char === undefined) {
        digit.setVisible(false);
        return;
      }
      digit.setVisible(true).setTexture('d' + char).setPosition(startX + i * spacing, 70);
    });
  }
}
