import React, { useState, useEffect, useCallback } from "react";
import { CalendarClock, Plus, X, RotateCcw, Lock, Dumbbell, Pencil } from "lucide-react";
import { supabase } from "./lib/supabase";
import {
  effectiveTimes,
  weekdayLabel,
  sundayParity,
  OPEN_GYM_HOURS,
  hourRange,
  deriveHourRange,
  isContiguousHourly,
} from "./lib/schedule";

function toDateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nextDays(n) {
  const out = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d);
  }
  return out;
}

// 시작~종료 시간(10:00~18:00 범위)을 골라 "오픈짐으로" 또는 "휴회로" 저장하는 패널.
function OpenGymPicker({ initialTimes, onSaveRange, onSaveClosed, onCancel, busy }) {
  const initial = deriveHourRange(initialTimes);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const invalid = OPEN_GYM_HOURS.indexOf(start) > OPEN_GYM_HOURS.indexOf(end);

  return (
    <div className="mt-2.5 rounded-lg border border-[#2E3238] bg-[#121316] p-3">
      <div className="flex items-center gap-2 mb-3">
        <select
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="rounded-md border border-[#2E3238] bg-[#1C1E22] px-2 py-1.5 text-sm font-mono outline-none focus:border-[#F5C518]/40"
        >
          {OPEN_GYM_HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span className="text-xs text-[#5C6067]">~</span>
        <select
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="rounded-md border border-[#2E3238] bg-[#1C1E22] px-2 py-1.5 text-sm font-mono outline-none focus:border-[#F5C518]/40"
        >
          {OPEN_GYM_HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        {invalid && <span className="text-[11px] text-pink-400">종료가 시작보다 빨라요</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy || invalid}
          onClick={() => onSaveRange(hourRange(start, end))}
          className="rounded-md bg-[#F5C518] px-3 py-1.5 text-xs font-semibold text-[#121316] hover:bg-[#F5C518]/90 disabled:opacity-40"
        >
          오픈짐으로 저장
        </button>
        <button
          disabled={busy}
          onClick={onSaveClosed}
          className="rounded-md border border-[#2E3238] px-3 py-1.5 text-xs font-medium text-[#8B9099] hover:text-[#F2F3F5] hover:border-[#F5C518]/40 disabled:opacity-40"
        >
          휴회로 저장
        </button>
        <button onClick={onCancel} className="text-xs text-[#8B9099] hover:text-[#F2F3F5]">
          취소
        </button>
      </div>
    </div>
  );
}

// 시간 목록을 보여준다 — 1시간 간격으로 쭉 이어진 범위(오픈짐)면 "10:00 ~ 18:00"처럼 크게,
// 아니면 기존처럼 칩으로 하나씩(+ 관리자면 개별 삭제 가능).
function TimesDisplay({ times, isAdmin, onRemove }) {
  if (times.length === 0) return null;
  if (isContiguousHourly(times)) {
    return (
      <span className="text-base font-bold font-mono text-[#F5C518]">
        {times[0]} ~ {times[times.length - 1]}
      </span>
    );
  }
  return (
    <>
      {times.map((t) => (
        <span
          key={t}
          className="flex items-center gap-1 rounded-full border border-[#2E3238] bg-[#121316] px-2.5 py-1 text-xs font-mono"
        >
          {t}
          {isAdmin && (
            <button
              disabled={!onRemove}
              onClick={() => onRemove(t)}
              aria-label={`${t} 삭제`}
              className="text-[#5C6067] hover:text-pink-400"
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
    </>
  );
}

export default function AdminScheduleView({ isAdmin, pin, showToast }) {
  const [weekdayDefaults, setWeekdayDefaults] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [sundayPatternDefaults, setSundayPatternDefaults] = useState([]);
  const [newTimeByDate, setNewTimeByDate] = useState({});
  const [openGymTarget, setOpenGymTarget] = useState(null); // 날짜(YYYY-MM-DD)
  const [editingSundayParity, setEditingSundayParity] = useState(null); // "odd" | "even" | null
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data: wd, error: e1 }, { data: ov, error: e2 }, { data: sp, error: e3 }] = await Promise.all([
      supabase.from("weekday_defaults").select("*"),
      supabase.from("schedule_overrides").select("*"),
      supabase.from("sunday_pattern_defaults").select("*"),
    ]);
    if (e1 || e2 || e3) {
      showToast("시간표를 불러오지 못했어요");
      return;
    }
    setWeekdayDefaults(wd || []);
    setOverrides(ov || []);
    setSundayPatternDefaults(sp || []);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const weekdayPreset = weekdayDefaults.find((w) => w.weekday === 1)?.times || [];
  const weekendPreset = weekdayDefaults.find((w) => w.weekday === 6)?.times || [];
  const sundayOdd = sundayPatternDefaults.find((p) => p.parity === "odd")?.times || [];
  const sundayEven = sundayPatternDefaults.find((p) => p.parity === "even")?.times || [];

  function handleRpcError(error, fallbackMsg) {
    if (!error) return false;
    if (error.message?.includes("PIN") || error.message?.includes("잠깁니다")) {
      showToast(error.message);
    } else {
      showToast(fallbackMsg);
    }
    return true;
  }

  async function applyOverride(dateStr, times) {
    setBusy(true);
    const { error } = await supabase.rpc("set_schedule_override", { p_date: dateStr, p_times: times, p_pin: pin });
    setBusy(false);
    if (handleRpcError(error, "저장에 실패했어요")) return;
    showToast(`${dateStr} 시간표를 저장했어요`);
    setOpenGymTarget(null);
    load();
  }

  async function resetToDefault(dateStr) {
    setBusy(true);
    const { error } = await supabase.rpc("clear_schedule_override", { p_date: dateStr, p_pin: pin });
    setBusy(false);
    if (handleRpcError(error, "되돌리기에 실패했어요")) return;
    showToast(`${dateStr}을 기본값으로 되돌렸어요`);
    load();
  }

  async function saveSundayPattern(parity, times) {
    setBusy(true);
    const { error } = await supabase.rpc("set_sunday_pattern_default", { p_parity: parity, p_times: times, p_pin: pin });
    setBusy(false);
    if (handleRpcError(error, "저장에 실패했어요")) return;
    showToast(`${parity === "odd" ? "오픈짐" : "휴회"} 기본값을 저장했어요`);
    setEditingSundayParity(null);
    load();
  }

  function addTime(dateStr, currentTimes) {
    const t = (newTimeByDate[dateStr] || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(t)) {
      showToast("HH:MM 형식으로 입력해주세요 (예: 10:30)");
      return;
    }
    if (currentTimes.includes(t)) {
      showToast("이미 있는 시간이에요");
      return;
    }
    applyOverride(dateStr, [...currentTimes, t]);
    setNewTimeByDate((prev) => ({ ...prev, [dateStr]: "" }));
  }

  function removeTime(dateStr, currentTimes, t) {
    applyOverride(dateStr, currentTimes.filter((x) => x !== t));
  }

  const days = nextDays(7);

  return (
    <div className="mx-auto max-w-3xl px-4 py-5">
      <div className="flex items-center gap-2 mb-4">
        <CalendarClock size={16} className="text-[#8B9099]" />
        <h2 className="font-display text-sm font-bold uppercase tracking-wide text-[#8B9099]">
          앞으로 7일 시간표
        </h2>
      </div>

      {!isAdmin && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#2E3238] bg-[#1C1E22] px-3 py-2.5 text-xs text-[#8B9099]">
          <Lock size={13} /> 관리자 인증을 하면 시간표를 수정할 수 있어요. 지금은 조회만 가능해요.
        </div>
      )}

      {isAdmin && (
        <div className="mb-5 rounded-xl border border-[#2E3238] bg-[#1C1E22] p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B9099] mb-2.5">
            일요일 기본값
          </h3>
          <p className="text-[11px] text-[#5C6067] mb-3">
            일요일은 격주로 오픈짐/휴회가 자동으로 바뀌어요. 특정 날짜만 다르게 하려면 아래 날짜별 카드에서
            바꾸면 돼요.
          </p>

          <div className="space-y-3">
            {[
              { parity: "odd", label: "오픈짐", times: sundayOdd },
              { parity: "even", label: "휴회", times: sundayEven },
            ].map(({ parity, label, times }) => (
              <div key={parity}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-bold text-sky-400">{label}</span>
                  {editingSundayParity !== parity && (
                    <button
                      onClick={() => setEditingSundayParity(parity)}
                      className="flex items-center gap-1 text-[11px] text-[#8B9099] hover:text-[#F5C518]"
                    >
                      <Pencil size={11} /> 수정
                    </button>
                  )}
                </div>
                {editingSundayParity === parity ? (
                  <OpenGymPicker
                    initialTimes={times}
                    busy={busy}
                    onSaveRange={(t) => saveSundayPattern(parity, t)}
                    onSaveClosed={() => saveSundayPattern(parity, [])}
                    onCancel={() => setEditingSundayParity(null)}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TimesDisplay times={times} isAdmin={false} />
                    {times.length === 0 && <span className="text-xs text-[#5C6067]">시간 없음</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2.5">
        {days.map((d) => {
          const dateStr = toDateStr(d);
          const dow = d.getDay();
          const isSunday = dow === 0;
          const parity = isSunday ? sundayParity(dateStr) : null;
          const isOverridden = overrides.some((o) => o.date === dateStr);
          const times = effectiveTimes(dateStr, weekdayDefaults, overrides, sundayPatternDefaults);
          const pickerOpen = openGymTarget === dateStr;
          const rangeMode = isContiguousHourly(times);

          return (
            <div key={dateStr} className="rounded-xl border border-[#2E3238] bg-[#1C1E22] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold">{dateStr}</span>
                  <span className="text-xs text-[#8B9099]">({weekdayLabel(dow)})</span>
                  {isSunday && (
                    <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-sm font-bold text-sky-400">
                      {parity === "odd" ? "오픈짐" : "휴회"}
                    </span>
                  )}
                  {isOverridden && (
                    <span className="rounded-full bg-[#F5C518]/15 px-2 py-0.5 text-[10px] font-semibold text-[#F5C518]">
                      예외 적용됨
                    </span>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1.5">
                    {!isSunday && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => applyOverride(dateStr, weekdayPreset)}
                          className="rounded-md border border-[#2E3238] px-2 py-1 text-[11px] text-[#8B9099] hover:text-[#F2F3F5] hover:border-[#F5C518]/40 disabled:opacity-40"
                        >
                          평일 프리셋
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => applyOverride(dateStr, weekendPreset)}
                          className="rounded-md border border-[#2E3238] px-2 py-1 text-[11px] text-[#8B9099] hover:text-[#F2F3F5] hover:border-[#F5C518]/40 disabled:opacity-40"
                        >
                          주말 프리셋
                        </button>
                      </>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => setOpenGymTarget(pickerOpen ? null : dateStr)}
                      className="flex items-center gap-1 rounded-md border border-[#2E3238] px-2 py-1 text-[11px] text-[#8B9099] hover:text-[#F2F3F5] hover:border-[#F5C518]/40 disabled:opacity-40"
                    >
                      <Dumbbell size={11} /> 오픈짐
                    </button>
                    {isOverridden && (
                      <button
                        disabled={busy}
                        onClick={() => resetToDefault(dateStr)}
                        className="flex items-center gap-1 rounded-md border border-[#2E3238] px-2 py-1 text-[11px] text-[#8B9099] hover:text-[#F2F3F5] hover:border-[#F5C518]/40 disabled:opacity-40"
                      >
                        <RotateCcw size={11} /> 기본값으로
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {times.length === 0 && (
                  <span className="text-xs text-[#5C6067]">
                    {parity === "even" ? "휴회일" : "열려있는 시간 없음"}
                  </span>
                )}
                <TimesDisplay
                  times={times}
                  isAdmin={isAdmin}
                  onRemove={(t) => removeTime(dateStr, times, t)}
                />

                {isAdmin && !rangeMode && (
                  <div className="flex items-center gap-1 ml-1">
                    <input
                      type="text"
                      placeholder="10:30"
                      value={newTimeByDate[dateStr] || ""}
                      onChange={(e) =>
                        setNewTimeByDate((prev) => ({ ...prev, [dateStr]: e.target.value }))
                      }
                      className="w-16 rounded-md border border-[#2E3238] bg-[#121316] px-2 py-1 text-xs font-mono outline-none focus:border-[#F5C518]/40"
                    />
                    <button
                      disabled={busy}
                      onClick={() => addTime(dateStr, times)}
                      aria-label="시간 추가"
                      className="grid h-6 w-6 place-items-center rounded-md border border-[#2E3238] text-[#8B9099] hover:text-[#F5C518] hover:border-[#F5C518]/40 disabled:opacity-40"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                )}
              </div>

              {pickerOpen && isAdmin && (
                <OpenGymPicker
                  initialTimes={times}
                  busy={busy}
                  onSaveRange={(t) => applyOverride(dateStr, t)}
                  onSaveClosed={() => applyOverride(dateStr, [])}
                  onCancel={() => setOpenGymTarget(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
