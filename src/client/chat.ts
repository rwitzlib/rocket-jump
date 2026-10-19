import { MAX_CHAT } from '../shared/protocol';
import { isTyping, type Input } from './input';

// Text chat: T or Enter to talk, Enter to send, Esc to cancel. Lines fade after a while but come
// back whenever the box is open, so you can scroll up through what you missed.

const LINE_TIME = 10000; // ms a line stays visible while the box is closed
const MAX_LINES = 50;

export class Chat {
  private readonly log = document.querySelector<HTMLElement>('#chat-log')!;
  private readonly box = document.querySelector<HTMLInputElement>('#chat-input')!;
  private readonly root = document.querySelector<HTMLElement>('#chat')!;
  /** Set while in a game: where typed lines go. */
  send: ((text: string) => void) | null = null;
  onLine: () => void = () => {};

  constructor(private readonly input: Input) {
    this.box.maxLength = MAX_CHAT;
    document.addEventListener('keydown', (e) => {
      if (!this.send || isTyping(e.target) || !document.pointerLockElement) return;
      if (e.code === 'KeyT' || e.code === 'Enter') {
        e.preventDefault();
        this.open();
      }
    });
    this.box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.box.value.trim();
        if (text) this.send?.(text);
        this.close();
      } else if (e.key === 'Escape') this.close();
    });
    this.box.addEventListener('blur', () => this.close());
  }

  get isOpen() {
    return !this.box.hidden;
  }

  open() {
    this.input.enabled = false;
    this.box.hidden = false;
    this.box.value = '';
    this.root.classList.add('open');
    this.box.focus();
  }

  close() {
    if (this.box.hidden) return;
    this.box.hidden = true;
    this.root.classList.remove('open');
    this.input.enabled = true;
    this.box.blur();
  }

  /** `name` null: a server notice. */
  add(name: string | null, text: string, mine = false) {
    const line = document.createElement('div');
    line.className = 'line';
    if (name === null) {
      line.classList.add('system');
      line.textContent = text;
    } else {
      const who = document.createElement('b');
      who.textContent = `${name}: `;
      if (mine) who.classList.add('mine');
      line.append(who, text);
    }
    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
    setTimeout(() => line.classList.add('old'), LINE_TIME);
    if (name !== null) this.onLine();
  }

  clear() {
    this.close();
    this.log.replaceChildren();
  }
}
