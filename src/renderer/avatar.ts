// Local idle playback is independent of the cloud call and GPU connection.
export class AvatarView {
  private speaking = false;
  private visible = !document.hidden;
  private failed = false;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private readonly surface: HTMLElement;
  constructor(private canvas: HTMLCanvasElement, private idle: HTMLVideoElement) {
    this.surface = canvas.parentElement!;
    this.canvas.hidden = false;
    idle.muted = true;
    idle.addEventListener('loadeddata', () => this.sync());
    idle.addEventListener('error', () => { this.failed = true; this.sync(); });
    this.sync();
  }
  setVisible(visible: boolean) { this.visible = visible; this.sync(); }
  showSpeaking() { if (!this.speaking) { this.speaking = true; this.sync(); } }
  showIdle() { this.speaking = false; this.sync(); }
  private sync() {
    clearTimeout(this.pauseTimer);
    this.surface.dataset.mode = this.speaking ? 'speaking' : !this.failed && this.idle.readyState >= 2 ? 'idle' : 'static';
    if (!this.visible || this.failed) { this.idle.pause(); return; }
    if (this.speaking) {
      // Keep the outgoing idle moving until the short crossfade has finished.
      this.pauseTimer = setTimeout(() => this.idle.pause(), 250);
    } else {
      void this.idle.play().catch(() => {
        // A hide/show or a new reply can cancel a pending play request.
        if (this.visible && !this.speaking && this.idle.paused) this.surface.dataset.mode = 'static';
      });
    }
  }
  dispose() { clearTimeout(this.pauseTimer); this.idle.pause(); }
}
