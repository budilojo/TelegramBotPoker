/**
 * Верх главной — чистая логика (без DOM, проверяется в Node).
 * Что показать над играми: «Вернуться к столу», «Стол группы» или подсказку.
 */
export function topKind(lobbies) {
  const list = Array.isArray(lobbies) ? lobbies : [];
  if (list.some((l) => l.inside)) return { kind: 'back' };
  const l = list.find((x) => x.status === 'lobby') || list.find((x) => x.status === 'playing');
  return l ? { kind: 'table', lobby: l } : { kind: 'hint' };
}
