/** Chips flying from the pot to a winner. Purely decorative, never blocking. */
import { h, flash } from '../util.js';

const reduced = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * @param from element the chips leave (the pot)
 * @param to   element they land on (a player card)
 * @param n    how many chips to throw — scaled to the size of the win
 */
export function flyChips(from, to, n = 6, onDone) {
  if (!from || !to || reduced()) {
    flash(to, 'win-flash');
    onDone?.();
    return;
  }
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const x0 = a.left + a.width / 2 - 13;
  const y0 = a.top + a.height / 2 - 13;
  const x1 = b.left + b.width / 2 - 13;
  const y1 = b.top + b.height / 2 - 13;

  const count = Math.max(3, Math.min(10, n));
  let landed = 0;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };

  for (let i = 0; i < count; i++) {
    const chip = h('div.chip-fly');
    chip.style.left = `${x0}px`;
    chip.style.top = `${y0}px`;
    document.body.append(chip);

    const jitterX = (Math.random() - 0.5) * 46;
    const jitterY = (Math.random() - 0.5) * 26;
    const lift = -60 - Math.random() * 50;
    const delay = i * 42;
    const dur = 460 + Math.random() * 170;

    const anim = chip.animate(
      [
        { transform: 'translate(0,0) scale(.6)', opacity: 0 },
        { transform: `translate(${(x1 - x0) * 0.45 + jitterX}px, ${(y1 - y0) * 0.35 + lift}px) scale(1)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${x1 - x0 + jitterX * 0.3}px, ${y1 - y0 + jitterY}px) scale(.82)`, opacity: 1, offset: 0.92 },
        { transform: `translate(${x1 - x0}px, ${y1 - y0}px) scale(.3)`, opacity: 0 },
      ],
      { duration: dur, delay, easing: 'cubic-bezier(.3,.8,.4,1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      chip.remove();
      if (++landed === count) done();
    };
    // Never leak a chip if the tab is backgrounded mid-animation.
    setTimeout(() => chip.remove(), delay + dur + 400);
  }

  setTimeout(() => flash(to, 'win-flash'), 300);
  setTimeout(done, count * 42 + 700);
}

/** Scale the number of chips to how big the win felt. */
export const chipCount = (amount, bigBlind) =>
  Math.max(3, Math.min(10, Math.round(Math.log2(Math.max(2, amount / Math.max(1, bigBlind))) + 2)));
