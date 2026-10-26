/**
 * Панель разбора после ответа: верно/неверно, что сделано не так, почему
 * верный ответ именно такой, другие варианты. props: { review } (результат
 * engine.grade). Числа в тексте считает код упражнения, не панель.
 */
import { h } from '../../ui.js';
import { topicById } from '../topics.js';

export function mount({ review, extra = null }) {
  const verdict = review.ok ? 'Верно' : review.score > 0 ? 'Частично верно' : 'Не верно';
  return h(`section.tr-explain${review.ok ? '.ok' : '.bad'}`, { 'aria-live': 'polite' },
    h('div.tr-verdict', verdict, review.score > 0 && review.score < 1 ? h('span.tr-score', ` · ${Math.round(review.score * 100)}%`) : null),
    review.mistakes.length ? h('div.tr-block',
      h('div.section-label', 'Что пошло не так'),
      h('ul.tr-list', review.mistakes.map((m) => h('li', m.text || 'Ошибка', ' ', h('small', `Тема: ${topicById(m.topic)?.title || m.topic}`))))) : null,
    h('div.tr-block', h('div.section-label', 'Почему так'), h('div.tr-why', review.why)),
    extra ? h('div.tr-block', h('div.section-label', 'Диапазон на матрице'), extra) : null,
    review.alternatives.length ? h('div.tr-block',
      h('div.section-label', 'Другие варианты'),
      h('ul.tr-list.alts', review.alternatives.map((a) => h(`li${a.verdict === 'верно' ? '.good' : ''}`,
        h('b', a.label), ' — ', h('span.tr-verd', a.verdict), a.text ? h('div', a.text) : null)))) : null);
}
