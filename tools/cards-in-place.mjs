/**
 * «Карты на месте» — общая проверка для tools/e2e.mjs (покер) и
 * tools/e2e-durak.mjs (дурак). Владелец видел на iPhone: «в какой-то момент
 * карты на столе отдаляются, и их становится не видно» (2026-10-21).
 *
 * Ждём, пока доиграют анимации стола, и меряем каждую карту стола и руки:
 * целиком в окне, не прозрачная, не сплющенная, не сдвинутая остаточным
 * смещением. Потом просим стол разложиться заново (resize) и сравниваем:
 * раскладка на экране обязана совпасть со свежей — иначе её посчитали по
 * картинке, которой уже нет (посреди анимации, в старом размере окна).
 */
import assert from 'node:assert/strict';

/** Пока на столе что-то движется (эффекты поверх стола не в счёт). */
export async function waitStill(page, ms = 6000) {
  await page.waitForFunction(() => !document.getAnimations().some((a) => {
    const t = a.effect?.getComputedTiming?.();
    return a.playState !== 'finished' && t && Number.isFinite(t.endTime) && !a.effect.target?.closest?.('#fx');
  }), null, { timeout: ms, polling: 50 });
  // Второй пересчёт раскладки — в следующем кадре после конца анимаций (ui.js).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Что сейчас на столе: масштаб, ширина карт и рамка каждой карты. */
export function snapshot(page) {
  return page.evaluate(() => {
    const t = document.querySelector('.table, .dk-felt');
    const cards = [...document.querySelectorAll('#app .board img.card, #app .minis img.card, #app .hero-cards img.card, #app .dk-pairs img.card, #app .dk-hand img.card')]
      .map((img) => {
        const r = img.getBoundingClientRect();
        let op = 1;
        for (let e = img; e && e !== document.body; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const where = img.closest('.board, .dk-pairs') ? 'стол' : img.closest('.minis') ? 'место' : 'рука';
        return { where, alt: img.alt, left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, op, layoutW: img.offsetWidth };
      });
    const w = (sel) => document.querySelector(sel)?.offsetWidth || 0;
    return {
      W: innerWidth,
      H: innerHeight,
      u: t?.style.getPropertyValue('--u') || '',
      cardW: t?.style.getPropertyValue('--card-w') || '',
      boardW: w('.board img.card') || w('.dk-pair img.att'),
      handOv: document.querySelector('.dk-hand')?.style.getPropertyValue('--ov') || '',
      cards,
    };
  });
}

/**
 * Все карты на месте — после того как анимации доиграли.
 * @param empty  карт может не быть совсем (конец партии в дураке)
 * @returns снимок стола (для сравнения размеров между улицами)
 */
export async function cardsInPlace(page, label, { empty = false } = {}) {
  await waitStill(page);
  const s = await snapshot(page);
  if (!empty) assert.ok(s.cards.length > 0, `${label}: на экране нет ни одной карты стола или руки`);
  for (const c of s.cards) {
    const id = `${label}: ${c.where} ${c.alt}`;
    assert.ok(c.left >= -1 && c.top >= -1 && c.right <= s.W + 1 && c.bottom <= s.H + 1,
      `${id} за краем экрана ${s.W}×${s.H}: ${c.left.toFixed(0)},${c.top.toFixed(0)}–${c.right.toFixed(0)},${c.bottom.toFixed(0)}`);
    assert.ok(c.op >= 0.3, `${id} почти прозрачна (${c.op.toFixed(2)})`);
    // Рамка не меньше раскладки: карта не сжата остаточным scale() анимации.
    // Место игрока целиком уменьшено масштабом стола (--u) — это раскладка, не сжатие.
    const k = c.where === 'место' ? Number(s.u) || 1 : 1;
    assert.ok(c.w >= c.layoutW * k * 0.9, `${id} сжата: на экране ${c.w.toFixed(0)} px при ширине ${c.layoutW} px`);
  }
  // Раскладка на экране — та же, что посчитал бы стол заново прямо сейчас.
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await waitStill(page);
  const again = await snapshot(page);
  assert.equal(again.u, s.u, `${label}: масштаб стола устарел — заново ${again.u}, было ${s.u}`);
  assert.equal(again.cardW, s.cardW, `${label}: ширина общих карт устарела — заново ${again.cardW}, было ${s.cardW}`);
  assert.equal(again.handOv, s.handOv, `${label}: веер руки устарел — заново ${again.handOv}, было ${s.handOv}`);
  return s;
}

/** Окно меняется посреди анимаций (шапка Telegram, клавиатура, поворот) и возвращается. */
export async function resizeMidAnimation(page, [w, h]) {
  const was = page.viewportSize();
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(80);
  await page.setViewportSize(was);
}
