// 특정 날짜에 실제로 열려있는 시간 목록을 계산한다.
// 우선순위: schedule_overrides(예외 날짜)가 있으면 그걸 쓰고,
// 일요일이면 그 달의 몇 번째 일요일인지에 따라(홀수주=오픈짐 기본/짝수주=휴회 기본),
// 그 외 요일이면 weekday_defaults를 쓴다.
export function effectiveTimes(dateStr, weekdayDefaults, overrides, sundayPatternDefaults = []) {
  const override = overrides.find((o) => o.date === dateStr);
  if (override) return [...override.times].sort();

  const date = new Date(`${dateStr}T00:00:00`);
  const dow = date.getDay();

  if (dow === 0) {
    const parity = sundayParity(dateStr);
    const pattern = sundayPatternDefaults.find((p) => p.parity === parity);
    return pattern ? [...pattern.times].sort() : [];
  }

  const def = weekdayDefaults.find((w) => w.weekday === dow);
  return def ? [...def.times].sort() : [];
}

// 그 날짜가 일요일이 아니면 null. 일요일이면 그 달의 몇 번째 일요일인지로
// "odd"(1/3/5주) 또는 "even"(2/4주)을 반환한다.
export function sundayParity(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (date.getDay() !== 0) return null;
  const nth = Math.ceil(date.getDate() / 7);
  return nth % 2 === 1 ? "odd" : "even";
}

export function weekdayLabel(dow) {
  return ["일", "월", "화", "수", "목", "금", "토"][dow] ?? "?";
}

// 오픈짐 선택 가능 시간대: 10:00 ~ 18:00, 1시간 단위
export const OPEN_GYM_HOURS = Array.from({ length: 9 }, (_, i) => `${String(10 + i).padStart(2, "0")}:00`);

// start~end(둘 다 OPEN_GYM_HOURS 안의 값) 사이의 시간을 전부 만들어준다.
export function hourRange(start, end) {
  const times = OPEN_GYM_HOURS;
  const si = times.indexOf(start);
  const ei = times.indexOf(end);
  if (si === -1 || ei === -1 || si > ei) return [];
  return times.slice(si, ei + 1);
}

// 기존 시간 배열에서 오픈짐 범위(연속된 1시간 간격)를 역으로 추정 — 편집 시 초기값으로 사용.
export function deriveHourRange(times) {
  const inRange = [...times].filter((t) => OPEN_GYM_HOURS.includes(t)).sort();
  if (inRange.length === 0) return { start: "10:00", end: "18:00" };
  return { start: inRange[0], end: inRange[inRange.length - 1] };
}

// 시간 배열이 1시간 간격으로 쭉 이어져 있는지(=오픈짐 같은 "범위"인지) 판단.
export function isContiguousHourly(times) {
  if (times.length < 2) return false;
  const sorted = [...times].sort();
  for (let i = 1; i < sorted.length; i++) {
    const [h1, m1] = sorted[i - 1].split(":").map(Number);
    const [h2, m2] = sorted[i].split(":").map(Number);
    if (h2 * 60 + m2 - (h1 * 60 + m1) !== 60) return false;
  }
  return true;
}
