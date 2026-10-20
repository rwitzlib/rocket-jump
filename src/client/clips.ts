// Replays as video: while a killcam or the play of the match is showing, the game canvas is
// recorded (MediaRecorder, in the browser's own WebM or MP4), and the last one can be saved to a
// file to share. Nothing is recorded where the browser can't do it.

const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

export class ClipRecorder {
  readonly supported = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private last: { blob: Blob; label: string } | null = null;
  /** Called when a recording is ready to save. */
  onReady: (label: string) => void = () => {};

  get hasClip(): boolean {
    return !!this.last;
  }

  start(canvas: HTMLCanvasElement, label: string) {
    if (!this.supported || this.recorder) return;
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return;
    try {
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      this.chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) this.chunks.push(e.data);
      };
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        if (!this.chunks.length) return;
        this.last = { blob: new Blob(this.chunks, { type: mimeType }), label };
        this.onReady(label);
      };
      recorder.start();
      this.recorder = recorder;
    } catch {
      this.recorder = null;
    }
  }

  stop() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recorder = null;
  }

  /** Saves the last clip as a file. False if there's none. */
  save(): boolean {
    const clip = this.last;
    if (!clip) return false;
    const ext = clip.blob.type.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(clip.blob);
    a.download = `rocket-jump-${clip.label.replace(/[^\w-]+/g, '-').toLowerCase()}-${stamp}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return true;
  }
}
