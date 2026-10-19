'use strict';
/**
 * Бот шашек: соперник для одиночной партии (вход из лички бота).
 *
 * Ходит через тот же `handle`, что и человек, — значит, по тем же правилам и
 * с теми же проверками: незаконный ход сервер отклонит и у бота. Видит он то
 * же, что любой за доской: в шашках скрытого нет, поэтому движку отдаётся
 * сама позиция (как в шахматах). Серию взятий шлёт с путём — сервер сверяет,
 * кого она бьёт.
 *
 * Думает в отдельном потоке (engine-worker.js); если поток не поднялся, —
 * прямо здесь, это медленнее, но партия не встанет.
 */
import { engineQueue } from '../engine-queue.js';
import * as C from './rules.js';
import { toFen, sqName, fromFen } from './board.js';
import { bestMove, evaluate, LEVELS } from './engine.js';

export { LEVELS };

/** Поток движка с очередью: брошенные партии не занимают его (engine-queue.js). */
const engine = engineQueue(new URL('./engine-worker.js', import.meta.url), (fen, level, seed) => bestMove(fen, level, { seed }));

const clampLevel = (v) => Math.max(0, Math.min(LEVELS.length - 1, Math.round(Number(v)) || 0));

export default {
  /** Что показать в форме перед партией: уровни словами. */
  catalog: () => ({
    levels: LEVELS.map((l) => l.name),
    defaultLevel: 1,
    levelHints: [
      'Видит на ход вперёд и часто ошибается — для первых партий.',
      'Не подставляет шашки просто так, но далеко не считает.',
      'Считает размены на несколько ходов — уже соперник.',
      'Думает глубоко и не прощает зевков.',
      'Самый сильный: считает очень глубоко, ход — до полутора секунд.',
    ],
  }),

  /** Что можно выбрать перед партией: уровень, цвет, часы. */
  settings(raw = {}) {
    return { base: raw.base ?? 0, inc: raw.inc ?? 0, side: raw.side ?? 'random' };
  },
  lineup(raw = {}) {
    return [{ type: 'engine', level: clampLevel(raw.level ?? 1) }];
  },
  seat(room, spec, i) {
    const p = C.addPlayer(room, { id: `bot${i + 1}`, tgId: 0, name: `🤖 ${LEVELS[spec.level].name}`, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },
  /** Пауза перед ходом — чтобы ход не прилетал раньше, чем человек отпустил фигуру. */
  delay: (room, p, w, rng) => (w.kind === 'move' ? 350 + Math.floor(rng() * 500) : 900 + Math.floor(rng() * 800)),

  /**
   * Чего ещё ждут от бота, кроме хода: ответа на ничью и на просьбу об откате.
   * Ключ меняется с каждым ходом — на новую просьбу будет новый ответ.
   */
  wants(room) {
    const m = C.live(room);
    if (!m) return [];
    const out = [];
    for (const [offer, kind] of [[m.drawOffer, 'draw'], [m.takeback, 'takeback']]) {
      if (!offer) continue;
      const opp = offer.by === m.white ? m.black : m.white;
      if (room.players.find((p) => p.id === opp)?.bot) out.push({ id: opp, key: `${kind}:${m.moves.length}`, kind });
    }
    return out;
  },

  async decide({ room, me, wait, rng }) {
    const m = C.live(room);
    if (!m) return null;
    const level = me.bot.level;
    if (wait.kind === 'takeback') {
      // Лёгкие боты добрые: разрешают вернуть ход. Сильные — как в турнире.
      return { t: level <= 2 ? 'takeback' : 'declinetb' };
    }
    if (wait.kind === 'draw') {
      // Соглашается, только если сам стоит хуже (или слабый и устал). Оценка — в сотых простой.
      const myColor = m.white === me.id ? 'w' : 'b';
      const pos = fromFen(toFen(m.pos));
      const forMe = pos.t === myColor ? evaluate(pos) : -evaluate(pos);
      return { t: forMe < -150 || (level === 0 && rng() < 0.3) ? 'draw' : 'decline' };
    }
    // Нужен ли ещё этот поиск: партию могли заменить («Сыграть ещё»), удалить
    // или в ней уже сходили — тогда поток его не получит.
    const plies = m.moves.length;
    const alive = () => !room.gone && C.live(room) === m && m.moves.length === plies;
    const best = await engine(toFen(m.pos), level, Math.floor(rng() * 2 ** 31), alive);
    if (!best) return null;
    return { t: 'move', from: sqName(best.from), to: sqName(best.to), path: best.path.map(sqName), ply: m.moves.length };
  },

  /** Запасной ход, если решение не прошло: первый законный из того, что видит бот. */
  fallback(view, wait) {
    if (wait.kind === 'takeback') return { t: 'declinetb' };
    if (wait.kind === 'draw') return { t: 'decline' };
    const mv = view.legal?.moves?.[0];
    if (!mv) return null;
    return { t: 'move', from: mv.from, to: mv.to, path: mv.path };
  },
};
