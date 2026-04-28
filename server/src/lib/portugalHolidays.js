const { DateTime } = require('luxon');

function computeEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const FIXED_HOLIDAYS = [
  [1, 1],    // Ano Novo
  [4, 25],   // Dia da Liberdade
  [5, 1],    // Dia do Trabalhador
  [6, 10],   // Dia de Portugal
  [8, 15],   // Assunção
  [10, 5],   // Implantação da República
  [11, 1],   // Todos-os-Santos
  [12, 1],   // Restauração da Independência
  [12, 8],   // Imaculada Conceição
  [12, 25],  // Natal
];

const cacheByYear = new Map();

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function getPortugueseHolidays(year) {
  const cached = cacheByYear.get(year);
  if (cached) return cached;

  const set = new Set();
  for (const [m, d] of FIXED_HOLIDAYS) {
    set.add(`${year}-${pad2(m)}-${pad2(d)}`);
  }

  const easter = computeEaster(year);
  const easterDt = DateTime.fromObject({ year, month: easter.month, day: easter.day });
  set.add(easterDt.toISODate());
  set.add(easterDt.minus({ days: 2 }).toISODate());   // Sexta-feira Santa
  set.add(easterDt.plus({ days: 60 }).toISODate());   // Corpo de Deus

  cacheByYear.set(year, set);
  return set;
}

function isPortugueseHoliday(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 10) return false;
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (!Number.isFinite(year)) return false;
  return getPortugueseHolidays(year).has(dateStr.slice(0, 10));
}

module.exports = { computeEaster, getPortugueseHolidays, isPortugueseHoliday };
