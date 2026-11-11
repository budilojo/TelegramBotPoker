const prefix = () => globalThis.CARDGAME_UX ? 'cardgame:ux:' : '';
const wrap = name => ({
  getItem: key => globalThis[name].getItem(prefix() + key),
  setItem: (key, value) => globalThis[name].setItem(prefix() + key, value),
  removeItem: key => globalThis[name].removeItem(prefix() + key),
});
export const local = wrap('localStorage');
export const session = wrap('sessionStorage');
export function clearUX() {
  if (!globalThis.CARDGAME_UX) return;
  for (const name of ['localStorage', 'sessionStorage']) {
    const s = globalThis[name];
    for (const k of Object.keys(s)) if (k.startsWith('cardgame:ux:')) s.removeItem(k);
  }
}
