/**
 * Дурак: что делает тап. Один жест на всё — первый тап поднимает карту,
 * второй играет. Здесь только решение, без экрана: что можно, говорит сервер
 * (`legal` из его вида), и он же перепроверяет присланный ход.
 */

/** Открытые (непобитые) карты на столе, которые `card` может покрыть. */
export const coverTargets = (legal, card) => legal?.defend?.[card] ?? [];

/**
 * Тап (или Enter) по своей карте.
 *   iDefend — отбиваюсь и ещё не решил брать; picked — уже поднятая карта.
 * Возвращает одно из:
 *   { do: 'pick' }              поднять карту
 *   { do: 'attack' }            сходить или подкинуть
 *   { do: 'defend', target }    покрыть единственную подходящую
 *   { do: 'choose' }            ходов несколько — пусть выберет сам
 *   { do: 'transfer-button' }   ею можно только перевести — это кнопка
 *   { do: 'cannot' }            в защите этой картой нечего делать
 */
export function handTap({ legal, picked, card, iDefend }) {
  if (!iDefend) return { do: picked === card ? 'attack' : 'pick' };
  const targets = coverTargets(legal, card);
  const transfers = !!legal?.transfer?.includes(card);
  if (!targets.length && !transfers) return { do: 'cannot' };
  if (picked !== card) return { do: 'pick' };
  if (!targets.length) return { do: 'transfer-button' };
  // Не угадываем: две цели — или козырь того же достоинства, которым можно
  // и покрыть, и перевести. Ход обратно не взять.
  if (targets.length > 1 || transfers) return { do: 'choose' };
  return { do: 'defend', target: targets[0] };
}

/** Строка посреди стола для отбивающегося, пока есть что крыть или переводить. */
export function defendHint({ legal, picked }) {
  const canCover = Object.keys(legal?.defend ?? {}).length > 0;
  const canTransfer = !!legal?.transfer?.length;
  const targets = coverTargets(legal, picked);
  const transfers = !!legal?.transfer?.includes(picked);
  if (targets.length && transfers) return 'Покрыть — тап по карте на столе, перевести — кнопка';
  if (targets.length > 1) return 'Нажмите на столе карту, которую кроете';
  if (targets.length) return 'Ещё тап по карте — покрыть ею';
  if (transfers) return 'Перевести — кнопкой «Перевести»';
  if (canCover) return 'Покрыть: тап по своей карте и ещё тап';
  return canTransfer ? 'Крыть нечем: «Перевести» или «Взять»' : 'Крыть нечем — «Взять»';
}
