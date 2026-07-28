import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Calendar, Clock, User, Hash, Search, X, CalendarCheck, Repeat } from "lucide-react";
import { supabase } from "./lib/supabase";
import { effectiveTimes, sundayParity } from "./lib/schedule";

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function BookingView({ showToast }) {
  const [weekdayDefaults, setWeekdayDefaults] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [sundayPatternDefaults, setSundayPatternDefaults] = useState([]);

  const bookDate = todayStr();
  const [bookTime, setBookTime] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [cancelDate, setCancelDate] = useState(todayStr());
  const [cancelName, setCancelName] = useState("");
  const [cancelPhone, setCancelPhone] = useState("");
  const [searching, setSearching] = useState(false);
  const [foundReservations, setFoundReservations] = useState(null);
  const [changingId, setChangingId] = useState(null);
  const [changeDraft, setChangeDraft] = useState("");

  const loadSchedule = useCallback(async () => {
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
    loadSchedule();
  }, [loadSchedule]);

  const availableTimes = useMemo(
    () => effectiveTimes(bookDate, weekdayDefaults, overrides, sundayPatternDefaults),
    [bookDate, weekdayDefaults, overrides, sundayPatternDefaults]
  );

  useEffect(() => {
    if (bookTime && !availableTimes.includes(bookTime)) setBookTime("");
  }, [availableTimes, bookTime]);

  const isCancelToday = cancelDate === todayStr();

  const cancelDateTimes = useMemo(
    () => effectiveTimes(cancelDate, weekdayDefaults, overrides, sundayPatternDefaults),
    [cancelDate, weekdayDefaults, overrides, sundayPatternDefaults]
  );

  async function submitBooking(e) {
    e.preventDefault();
    if (!bookTime) {
      showToast("시간을 선택해주세요");
      return;
    }
    if (!name.trim()) {
      showToast("이름을 입력해주세요");
      return;
    }
    if (!/^\d{4}$/.test(phone.trim())) {
      showToast("회원번호 4자리를 입력해주세요");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.from("reservations").insert({
      date: bookDate,
      time: bookTime,
      name: name.trim(),
      phone: phone.trim(),
      commented_at: new Date().toISOString(),
    });
    setSubmitting(false);

    if (error) {
      if (error.code === "23505") {
        showToast("이미 같은 시간에 예약되어 있어요");
      } else if (error.code === "42501") {
        showToast("예약은 당일에만 할 수 있어요");
      } else {
        showToast(error.message || "예약에 실패했어요");
      }
      return;
    }

    showToast(`${bookDate} ${bookTime} 예약이 완료됐어요`);
    setName("");
    setPhone("");
  }

  async function searchMyReservations(e) {
    e.preventDefault();
    const nameQuery = cancelName.trim();
    const phoneQuery = cancelPhone.trim();
    if (!nameQuery && !phoneQuery) {
      showToast("이름 또는 회원번호를 입력해주세요");
      return;
    }
    setSearching(true);
    let query = supabase.from("reservations").select("*").eq("date", cancelDate);
    if (nameQuery) query = query.ilike("name", `%${nameQuery}%`); // 이름은 일부만 일치해도 검색됨
    if (phoneQuery) query = query.eq("phone", phoneQuery); // 회원번호는 완전히 일치해야 함
    const { data, error } = await query.order("time");
    setSearching(false);

    if (error) {
      showToast("조회에 실패했어요");
      return;
    }
    setFoundReservations(data || []);
    setChangingId(null);
    if (!data || data.length === 0) showToast("일치하는 예약이 없어요");
  }

  async function cancelReservation(id) {
    const { error } = await supabase.from("reservations").delete().eq("id", id);
    if (error) {
      if (error.code === "42501") {
        showToast("당일 예약만 취소할 수 있어요");
      } else {
        showToast("취소에 실패했어요");
      }
      return;
    }
    setFoundReservations((prev) => (prev || []).filter((r) => r.id !== id));
    showToast("예약을 취소했어요");
  }

  function openChangeTime(r) {
    setChangingId(r.id);
    setChangeDraft(r.time);
  }

  async function confirmChangeTime(id) {
    if (!changeDraft) {
      showToast("변경할 시간을 선택해주세요");
      return;
    }
    const current = (foundReservations || []).find((r) => r.id === id);
    const fromTime = current?.time;
    const { error } = await supabase
      .from("reservations")
      .update({ time: changeDraft, commented_at: new Date().toISOString(), changed: true, changed_from: fromTime })
      .eq("id", id);

    if (error) {
      if (error.code === "23505") {
        showToast("이미 그 시간에 예약이 있어요");
      } else if (error.code === "42501" || error.code === "P0001") {
        showToast(error.message || "당일 예약만 시간을 변경할 수 있어요");
      } else {
        showToast(error.message || "시간 변경에 실패했어요");
      }
      return;
    }
    setFoundReservations((prev) =>
      (prev || []).map((r) => (r.id === id ? { ...r, time: changeDraft, changed: true, changed_from: fromTime } : r))
    );
    setChangingId(null);
    showToast(`${fromTime} → ${changeDraft}로 시간을 변경했어요`);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 space-y-6">
      <section className="rounded-xl border border-[#2E3238] bg-[#1C1E22] p-5">
        <h2 className="font-display text-sm font-bold uppercase tracking-wide text-[#E7843B] flex items-center gap-2 mb-4">
          <CalendarCheck size={16} /> 예약하기
        </h2>

        <form onSubmit={submitBooking} className="space-y-3">
          <div>
            <label className="text-xs text-[#8B9099] mb-1.5 flex items-center gap-1.5">
              <Calendar size={12} /> 날짜
            </label>
            <div className="w-full rounded-lg border border-[#2E3238] bg-[#121316]/60 px-3 py-2 text-sm font-mono text-[#8B9099]">
              {bookDate} <span className="text-[11px] text-[#5C6067]">(예약은 당일에만 가능해요)</span>
            </div>
          </div>

          <div>
            <label className="text-xs text-[#8B9099] mb-1.5 flex items-center gap-1.5">
              <Clock size={12} /> 시간
            </label>
            {availableTimes.length === 0 ? (
              <p className="text-xs text-[#5C6067] py-2">
                {sundayParity(bookDate) === "even" ? "이 날은 휴회일이에요." : "이 날짜엔 열려있는 시간이 없어요."}
              </p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {availableTimes.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBookTime(t)}
                    className={`rounded-lg border-2 py-2 text-sm font-mono transition-colors ${
                      bookTime === t
                        ? "border-[#F0954F] bg-[#E7843B]/20 text-[#F0954F] font-semibold"
                        : "border-[#2E3238] text-[#D5D7DC] hover:border-[#E7843B]/80"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#8B9099] mb-1.5 flex items-center gap-1.5">
                <User size={12} /> 이름
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="홍길동"
                className="w-full rounded-lg border border-[#2E3238] bg-[#121316] px-3 py-2 text-sm outline-none focus:border-[#E7843B]/40"
              />
            </div>
            <div>
              <label className="text-xs text-[#8B9099] mb-1.5 flex items-center gap-1.5">
                <Hash size={12} /> 회원번호
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="1234"
                className="w-full rounded-lg border border-[#2E3238] bg-[#121316] px-3 py-2 text-sm font-mono outline-none focus:border-[#E7843B]/40"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || availableTimes.length === 0}
            className="w-full rounded-lg bg-[#E7843B] py-2.5 text-sm font-semibold text-white hover:bg-[#E7843B]/90 disabled:opacity-40 transition-colors"
          >
            {submitting ? "예약 중..." : "예약하기"}
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-[#2E3238] bg-[#1C1E22] p-5">
        <h2 className="font-display text-sm font-bold uppercase tracking-wide text-[#8B9099] flex items-center gap-2 mb-4">
          <X size={16} /> 내 예약 취소 · 시간 변경
        </h2>

        <form onSubmit={searchMyReservations} className="space-y-3">
          <div>
            <label className="text-xs text-[#8B9099] mb-1.5 block">날짜</label>
            <input
              type="date"
              value={cancelDate}
              onChange={(e) => setCancelDate(e.target.value)}
              className="w-full rounded-lg border border-[#2E3238] bg-[#121316] px-2 py-2 text-xs font-mono outline-none focus:border-[#E7843B]/40 [color-scheme:dark]"
            />
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
            <div>
              <label className="text-xs text-[#8B9099] mb-1.5 block">이름 (일부만 입력해도 검색돼요)</label>
              <input
                type="text"
                value={cancelName}
                onChange={(e) => setCancelName(e.target.value)}
                placeholder="홍길동"
                className="w-full rounded-lg border border-[#2E3238] bg-[#121316] px-2 py-2 text-sm outline-none focus:border-[#E7843B]/40"
              />
            </div>
            <span className="pb-2.5 text-[11px] font-medium text-[#5C6067]">또는</span>
            <div>
              <label className="text-xs text-[#8B9099] mb-1.5 block">회원번호</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={cancelPhone}
                onChange={(e) => setCancelPhone(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="1234"
                className="w-full rounded-lg border border-[#2E3238] bg-[#121316] px-2 py-2 text-sm font-mono outline-none focus:border-[#E7843B]/40"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={searching}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-[#2E3238] py-2 text-xs font-medium text-[#8B9099] hover:text-[#E7843B] hover:border-[#E7843B]/40 disabled:opacity-40 transition-colors"
          >
            <Search size={13} /> {searching ? "조회 중..." : "내 예약 찾기"}
          </button>
        </form>

        {foundReservations && !isCancelToday && foundReservations.length > 0 && (
          <p className="mt-3 text-[11px] text-[#5C6067] text-center">
            {cancelDate < todayStr() ? "지난 날짜의 예약은 조회만 가능해요." : "당일 예약만 변경·취소할 수 있어요."}
          </p>
        )}

        {foundReservations && (
          <div className="mt-3 space-y-1.5">
            {foundReservations.length === 0 ? (
              <p className="text-xs text-[#5C6067] py-2 text-center">일치하는 예약이 없어요.</p>
            ) : (
              foundReservations.map((r) => (
                <div key={r.id} className="rounded-lg border border-[#2E3238] px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-mono font-semibold">{r.time}</span>
                      <span className="text-sm text-[#D5D7DC]">{r.name}</span>
                      <span className="text-[11px] text-[#5C6067] font-mono">회원번호 {r.phone}</span>
                    </div>
                    {isCancelToday && (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => (changingId === r.id ? setChangingId(null) : openChangeTime(r))}
                          className="flex items-center gap-1 text-xs font-medium text-[#8B9099] hover:text-[#E7843B]"
                        >
                          <Repeat size={12} /> 시간 변경
                        </button>
                        <button
                          onClick={() => cancelReservation(r.id)}
                          className="text-xs font-medium text-pink-400 hover:text-pink-300"
                        >
                          예약취소
                        </button>
                      </div>
                    )}
                  </div>

                  {isCancelToday && changingId === r.id && (
                    <div className="mt-2.5 flex items-center gap-2 border-t border-[#2E3238] pt-2.5">
                      <select
                        value={changeDraft}
                        onChange={(e) => setChangeDraft(e.target.value)}
                        className="flex-1 rounded-lg border border-[#2E3238] bg-[#121316] px-2 py-1.5 text-sm font-mono outline-none focus:border-[#E7843B]/40"
                      >
                        {cancelDateTimes.length === 0 && <option value="">열려있는 시간 없음</option>}
                        {cancelDateTimes.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => confirmChangeTime(r.id)}
                        className="rounded-lg bg-[#E7843B] px-3 py-1.5 text-xs font-semibold text-[#121316] hover:bg-[#E7843B]/90"
                      >
                        변경
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}
