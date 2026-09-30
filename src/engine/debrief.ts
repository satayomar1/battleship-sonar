import { DebriefStats, MoveRecord } from '../types/game';
import { BOARD_SIZE } from './board';

export const computeDebrief = (moves: MoveRecord[]): DebriefStats => {
  const totalShots = moves.length;
  const hits = moves.filter((m) => m.result !== 'miss').length;
  const misses = totalShots - hits;
  const accuracy = totalShots === 0 ? 0 : hits / totalShots;

  let longestHitStreak = 0;
  let current = 0;
  for (const m of moves) {
    if (m.result !== 'miss') {
      current++;
      longestHitStreak = Math.max(longestHitStreak, current);
    } else {
      current = 0;
    }
  }

  const edgeShots = moves.filter(
    (m) =>
      m.x === 0 || m.y === 0 || m.x === BOARD_SIZE - 1 || m.y === BOARD_SIZE - 1,
  ).length;
  const edgeShotShare = totalShots === 0 ? 0 : edgeShots / totalShots;

  // Hunting shots (i.e. shots that missed) on checkerboard parity.
  const huntingShots = moves.filter((m) => m.result === 'miss');
  const parityShots = huntingShots.filter((m) => (m.x + m.y) % 2 === 0).length;
  const parityShare =
    huntingShots.length === 0 ? 0 : parityShots / huntingShots.length;

  const observations: string[] = [];
  const tips: string[] = [];

  observations.push(
    `Точность ${(accuracy * 100).toFixed(0)}% — ${hits} попаданий из ${totalShots} выстрелов.`,
  );
  observations.push(`Лучшая серия попаданий: ${longestHitStreak}.`);
  observations.push(
    `${(edgeShotShare * 100).toFixed(0)}% выстрелов пришлось на край поля.`,
  );

  if (accuracy < 0.3 && totalShots >= 20) {
    tips.push(
      'Низкая точность: стреляйте по «шахматной» сетке — однопалубники редки, а сетка с шагом 2 покрывает все корабли длиной 2+.',
    );
  }
  if (parityShare < 0.5 && huntingShots.length >= 10) {
    tips.push(
      'Мало выстрелов по чётным клеткам во время поиска. Поиск по чётной сетке находят корабли быстрее: 4-палубник занимает чётную клетку всегда.',
    );
  }
  if (edgeShotShare > 0.45 && totalShots >= 15) {
    tips.push(
      `Слишком много выстрелов по краям (${(edgeShotShare * 100).toFixed(0)}%). Крайние ряды статистически менее «плотные»: у корабля у края вдвое меньше соседних клеток, часть флота там тонет редко.`,
    );
  }
  if (longestHitStreak >= 3) {
    observations.push(
      'Вы эффективно добивали найденные корабли — серия попаданий говорит о продолжении обстрела вдоль линии.',
    );
  } else if (hits >= 4 && longestHitStreak <= 1) {
    tips.push(
      'После попадания не переключайтесь на случайные клетки: продолжайте обстрел соседних клеток, пока корабль не потоплен.',
    );
  }
  if (tips.length === 0) {
    tips.push(
      'Хороший баланс атаки. Следующий шаг — следить за картой промахов: она сокращает зону поиска вдвое к середине партии.',
    );
  }

  return {
    totalShots,
    hits,
    misses,
    accuracy,
    longestHitStreak,
    edgeShotShare,
    parityShare,
    observations,
    tips,
  };
};

export const formatShareText = (
  won: boolean,
  stats: DebriefStats,
  mode: string,
): string =>
  `🚢 Sonar.io — ${won ? 'Победа' : 'Поражение'} (${mode})\n` +
  `Точность: ${(stats.accuracy * 100).toFixed(0)}% (${stats.hits}/${stats.totalShots})\n` +
  `Лучшая серия: ${stats.longestHitStreak}\n` +
  `Сыграем ещё?`;
