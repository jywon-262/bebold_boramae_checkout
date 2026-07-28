import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Calendar,
  Clock,
  Users,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Sun,
  Moon,
  RefreshCw,
  Lock,
  Unlock,
  Trash2,
  LayoutDashboard,
  CalendarPlus,
  CalendarClock,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import BookingView from "./BookingView";
import AdminScheduleView from "./AdminScheduleView";

/* =========================================================================
   BEBOLD BORAMAE · 출석/예약 현황판  (v5 — 예약 시스템 버전)
   -------------------------------------------------------------------------
   v5 변경사항
   1) 네이버 카페 스크래핑 대신 회원이 이 웹에서 직접 예약/취소 (BookingView)
   2) 요일 기본 시간표 + 예외 날짜(공휴일 등) 관리 (AdminScheduleView, 코치 PIN 필요)
   3) 코치는 관리자 모드로 다른 회원의 예약을 대신 취소할 수 있음
   ========================================================================= */

const MORNING_START = "06:30";
const MORNING_END = "12:00";
const AFTERNOON_START = "18:00";
const AFTERNOON_END = "21:30";

// 13~16번째 = 마감임박(주황), 17번째부터 = 대기자(핑크)
const WARN_START = 13;
const WAITLIST_START = 17;

function periodOf(time) {
  if (time >= MORNING_START && time <= MORNING_END) return "morning";
  if (time >= AFTERNOON_START && time <= AFTERNOON_END) return "afternoon";
  return "other";
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatClock(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString("ko-KR");
}

function tierOf(oneBasedIndex) {
  if (oneBasedIndex >= WAITLIST_START) return "waitlist";
  if (oneBasedIndex >= WARN_START) return "warn";
  return "normal";
}

// 순수 한글 2글자(외자) 이름은 3글자 이름과 시각적 너비를 맞추기 위해
// 두 글자 사이에 전각 공백(한 글자 폭)을 넣어준다. "체험" 자체(이름 미기재 체험)는 제외.
function displayName(name) {
  if (name !== "체험" && /^[가-힣]{2}$/.test(name)) {
    return `${name[0]}　${name[1]}`;
  }
  return name;
}

export default function App() {
  const [view, setView] = useState("dashboard"); // "dashboard" | "booking" | "schedule"
  const [members, setMembers] = useState([]);
  const [date, setDate] = useState(todayStr());
  // 접힌(collapsed) 타임만 기록 — 그날 실제로 예약이 있는 시간만 카드가 생기고,
  // 새로 생기는 카드는 기본적으로 펼쳐진 상태로 보인다 (평일/주말/공휴일 구분 없이
  // 그날그날 실제 예약된 시간대만 자동으로 타임테이블에 나타남).
  const [collapsedTimes, setCollapsedTimes] = useState(new Set());
  const [revealedId, setRevealedId] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState(null);

  // 관리자(코치) 모드 — PIN 확인은 클라이언트가 아니라 Supabase RPC(check_admin_pin)가 함.
  // 확인된 PIN만 로컬에 저장해두고, 다음 관리자 작업(시간표 변경 등)을 부를 때 그대로 같이 보냄.
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminPin, setAdminPin] = useState("");
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [pinDraft, setPinDraft] = useState("");

  const showToast = useCallback((msg) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const saved = localStorage.getItem("bb_admin_pin");
    if (!saved) return;
    supabase.rpc("check_admin_pin", { p_pin: saved }).then(({ data, error }) => {
      if (data) {
        setAdminPin(saved);
        setIsAdmin(true);
      } else if (!error) {
        // 잠금 등 에러가 아니라 진짜로 PIN이 틀린 경우에만 저장된 값을 지운다.
        localStorage.removeItem("bb_admin_pin");
      }
    });
  }, []);

  async function submitPin() {
    const { data, error } = await supabase.rpc("check_admin_pin", { p_pin: pinDraft });
    if (error) {
      showToast(error.message.includes("잠깁니다") ? error.message : "인증에 실패했어요");
      return;
    }
    if (!data) {
      showToast("PIN이 올바르지 않아요");
      return;
    }
    localStorage.setItem("bb_admin_pin", pinDraft);
    setAdminPin(pinDraft);
    setIsAdmin(true);
    setPinPromptOpen(false);
    setPinDraft("");
    showToast("관리자 모드가 켜졌어요");
  }

  function lockAdmin() {
    localStorage.removeItem("bb_admin_pin");
    setAdminPin("");
    setIsAdmin(false);
    showToast("관리자 모드를 해제했어요");
  }

  async function forceCancel(id) {
    // 관리자 강제취소는 날짜 제한 없이 동작해야 하므로 PIN 인증 RPC를 통해서만 처리한다.
    const { error } = await supabase.rpc("admin_cancel_reservation", { p_id: id, p_pin: adminPin });
    if (error) {
      showToast(error.message || "취소에 실패했어요");
      return;
    }
    setMembers((prev) => prev.filter((m) => m.id !== id));
    showToast("예약을 취소했어요");
  }

  const fetchMembers = useCallback(async () => {
    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("date", date)
      .order("time")
      .order("commented_at", { ascending: true, nullsFirst: true });
    if (error) {
      console.error("reservations fetch error:", error);
      showToast("예약 현황을 불러오지 못했어요");
      setLoading(false);
      return;
    }
    setMembers(data || []);
    setLastSynced(new Date());
    setLoading(false);
  }, [date, showToast]);

  useEffect(() => {
    setLoading(true);
    fetchMembers();
  }, [fetchMembers]);

  // 예약하기/시간표 탭에 있다가 현황판 탭으로 돌아올 때마다 최신 데이터를 다시 불러온다.
  useEffect(() => {
    if (view === "dashboard") fetchMembers();
  }, [view, fetchMembers]);

  // 스크래핑 스크립트가 reservations를 갱신하면 실시간으로 화면도 갱신
  useEffect(() => {
    const channel = supabase
      .channel("reservations-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reservations" },
        () => fetchMembers()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchMembers]);

  // 그날 실제로 예약이 있는 시간만 타임슬롯 카드로 만든다 (time_slots 템플릿 테이블 사용 안 함).
  // 평일/주말/공휴일 구분 없이, 실제 예약된 시간대만 자동으로 나타나고 사라진다.
  const grouped = useMemo(() => {
    const map = {};
    for (const m of members) {
      if (!map[m.time]) map[m.time] = [];
      map[m.time].push(m);
    }
    return map;
  }, [members]);

  const sortedSlotTimes = useMemo(() => Object.keys(grouped).sort(), [grouped]);

  const slotsByPeriod = useMemo(() => {
    const buckets = { morning: [], afternoon: [], other: [] };
    for (const t of sortedSlotTimes) buckets[periodOf(t)].push(t);
    return buckets;
  }, [sortedSlotTimes]);

  const counts = useMemo(() => {
    const total = members.length;
    const morning = members.filter((m) => periodOf(m.time) === "morning").length;
    const afternoon = members.filter((m) => periodOf(m.time) === "afternoon").length;
    return { total, morning, afternoon };
  }, [members]);

  async function toggleAttended(id, current) {
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, attended: !current } : m)));
    const { error } = await supabase.from("reservations").update({ attended: !current }).eq("id", id);
    if (error) {
      showToast("출석 체크 저장에 실패했어요");
      fetchMembers();
    }
  }

  function toggleExpand(time) {
    setCollapsedTimes((prev) => {
      const next = new Set(prev);
      next.has(time) ? next.delete(time) : next.add(time);
      return next;
    });
  }

  function copySlotList(time) {
    const list = grouped[time] || [];
    let text = `📋 [${time} 타임 예약자 명단] (${list.length}명)\n`;
    list.forEach((m, i) => {
      const n = i + 1;
      if (n === WAITLIST_START) text += `--- 대기자 ---\n`;
      text += `${n}. ${m.name} ${m.phone}\n`;
    });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(`${time} 타임 명단을 복사했어요`),
        () => showToast("복사에 실패했어요")
      );
    } else {
      showToast("이 브라우저에서는 복사를 지원하지 않아요");
    }
  }

  return (
    <div className="min-h-screen w-full bg-[#121316] text-[#F2F3F5]" style={{ fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap');
        .font-display { font-family: 'Oswald', sans-serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes toast-in { from { opacity:0; } to { opacity:1; } }
      `}</style>

      <header className="sticky top-0 z-20 border-b border-[#2E3238] bg-[#121316]/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="flex items-center gap-2.5 justify-self-center sm:justify-self-start">
            <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
              <img src="/logo.png" alt="Bebold Boramae" className="h-full w-full object-cover" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold uppercase tracking-wide leading-none">
                Bebold Boramae
              </h1>
              <p className="text-[11px] text-[#8B9099] mt-0.5 flex items-center gap-1">
                <RefreshCw size={10} />
                {lastSynced ? `${lastSynced.toLocaleTimeString("ko-KR")} 기준 자동 동기화` : "동기화 중..."}
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1 rounded-lg border border-[#2E3238] bg-[#1C1E22] p-1 justify-self-center">
            {[
              { key: "dashboard", label: "현황판", Icon: LayoutDashboard },
              { key: "booking", label: "예약하기", Icon: CalendarPlus },
              { key: "schedule", label: "시간표", Icon: CalendarClock },
            ].map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-semibold transition-colors ${
                  view === key ? "bg-[#E7843B]/15 text-[#E7843B]" : "text-[#8B9099] hover:text-[#F2F3F5]"
                }`}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2 justify-self-center sm:justify-self-end">
            {view === "dashboard" && (
              <>
                <div className="flex items-center gap-1.5 rounded-lg border border-[#2E3238] bg-[#1C1E22] px-2.5 py-1.5">
                  <Calendar size={14} className="text-[#8B9099]" />
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="bg-transparent text-sm font-mono outline-none [color-scheme:dark]"
                  />
                </div>
                <button
                  onClick={() => setDate(todayStr())}
                  className="hidden sm:block rounded-lg border border-[#2E3238] bg-[#1C1E22] px-3 py-1.5 text-xs font-medium text-[#8B9099] hover:text-[#F2F3F5] hover:border-[#E7843B]/40 transition-colors"
                >
                  오늘
                </button>
              </>
            )}
            <button
              onClick={() => (isAdmin ? lockAdmin() : setPinPromptOpen(true))}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                isAdmin
                  ? "border-[#4ADE80]/40 bg-[#4ADE80]/10 text-[#4ADE80]"
                  : "border-[#2E3238] bg-[#1C1E22] text-[#8B9099] hover:text-[#F2F3F5]"
              }`}
            >
              {isAdmin ? <Unlock size={13} /> : <Lock size={13} />}
              <span className="hidden sm:inline">관리자</span>
            </button>
          </div>
        </div>

        {pinPromptOpen && (
          <div className="border-t border-[#2E3238] bg-[#1C1E22] px-4 py-3">
            <div className="mx-auto max-w-6xl flex items-center gap-2">
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitPin()}
                placeholder="관리자 인증"
                className="w-40 rounded-lg border border-[#2E3238] bg-[#121316] px-3 py-1.5 text-sm font-mono outline-none focus:border-[#E7843B]/40"
              />
              <button
                onClick={submitPin}
                className="rounded-lg bg-[#E7843B] px-3 py-1.5 text-xs font-semibold text-[#121316] hover:bg-[#E7843B]/90"
              >
                확인
              </button>
              <button
                onClick={() => {
                  setPinPromptOpen(false);
                  setPinDraft("");
                }}
                className="text-xs text-[#8B9099] hover:text-[#F2F3F5]"
              >
                취소
              </button>
            </div>
          </div>
        )}
      </header>

      {view === "booking" && <BookingView showToast={showToast} />}
      {view === "schedule" && <AdminScheduleView isAdmin={isAdmin} pin={adminPin} showToast={showToast} />}

      {view === "dashboard" && (
      <main className="mx-auto max-w-6xl px-4 py-5 space-y-5" onClick={() => setRevealedId(null)}>
        <section>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h2 className="font-display text-sm font-bold uppercase tracking-wide text-[#8B9099]">
              {date} 타임테이블
            </h2>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-[#E7843B]/15 px-3 py-1 text-xs font-semibold text-[#E7843B]">
                전체 {counts.total}
              </span>
              <span className="flex items-center gap-1.5 rounded-full bg-sky-500/15 px-3 py-1 text-xs font-semibold text-sky-400">
                <Sun size={12} /> 오전 {counts.morning}
              </span>
              <span className="flex items-center gap-1.5 rounded-full bg-[#FF6A3D]/15 px-3 py-1 text-xs font-semibold text-[#FF6A3D]">
                <Moon size={12} /> 오후 {counts.afternoon}
              </span>
            </div>
          </div>

          {loading ? (
            <p className="text-center text-sm text-[#5C6067] py-10">불러오는 중...</p>
          ) : (
            <>
              <PeriodGroup
                label="오전 수업"
                sublabel={`${MORNING_START} ~ ${MORNING_END}`}
                times={slotsByPeriod.morning}
                accent="sky"
                grouped={grouped}
                collapsedTimes={collapsedTimes}
                toggleExpand={toggleExpand}
                copySlotList={copySlotList}
                toggleAttended={toggleAttended}
                revealedId={revealedId}
                setRevealedId={setRevealedId}
                isAdmin={isAdmin}
                onForceCancel={forceCancel}
              />
              <PeriodGroup
                label="오후 수업"
                sublabel={`${AFTERNOON_START} ~ ${AFTERNOON_END}`}
                times={slotsByPeriod.afternoon}
                accent="orange"
                grouped={grouped}
                collapsedTimes={collapsedTimes}
                toggleExpand={toggleExpand}
                copySlotList={copySlotList}
                toggleAttended={toggleAttended}
                revealedId={revealedId}
                setRevealedId={setRevealedId}
                isAdmin={isAdmin}
                onForceCancel={forceCancel}
              />
              {slotsByPeriod.other.length > 0 && (
                <PeriodGroup
                  label="기타 시간대"
                  sublabel="오전/오후 구간 외"
                  times={slotsByPeriod.other}
                  accent="gray"
                  grouped={grouped}
                  collapsedTimes={collapsedTimes}
                  toggleExpand={toggleExpand}
                  copySlotList={copySlotList}
                  toggleAttended={toggleAttended}
                  revealedId={revealedId}
                  setRevealedId={setRevealedId}
                  isAdmin={isAdmin}
                  onForceCancel={forceCancel}
                />
              )}
            </>
          )}
        </section>
      </main>
      )}

      {toast && (
        <div
          className="fixed top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 max-w-[85vw] text-center rounded-lg border border-[#2E3238] bg-[#1C1E22] px-4 py-2.5 text-sm shadow-xl font-mono"
          style={{ animation: "toast-in 0.18s ease-out" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

const ACCENT_MAP = {
  sky: { text: "text-sky-400", bar: "bg-sky-500", icon: Sun },
  orange: { text: "text-[#FF6A3D]", bar: "bg-[#FF6A3D]", icon: Moon },
  gray: { text: "text-[#8B9099]", bar: "bg-[#8B9099]", icon: Clock },
};

// 오전/오후 카드 배경 구분 (은은한 틴트, option A — 위 뱃지 색과 통일감)
const CARD_BG_MAP = {
  sky: "bg-[#1A222B] border-[rgba(56,166,224,0.22)]",
  orange: "bg-[#241D19] border-[rgba(255,106,61,0.22)]",
  gray: "bg-[#1C1E22] border-[#2E3238]",
};

function PeriodGroup({ label, sublabel, times, accent, grouped, collapsedTimes, toggleExpand, copySlotList, toggleAttended, revealedId, setRevealedId, isAdmin, onForceCancel }) {
  if (!times.length) return null;
  const a = ACCENT_MAP[accent];
  const Icon = a.icon;

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2.5 mb-3">
        <span className={`h-4 w-1 rounded-full ${a.bar}`} />
        <Icon size={14} className={a.text} />
        <span className={`font-display text-xs font-bold uppercase tracking-wider ${a.text}`}>{label}</span>
        <span className="text-[11px] text-[#5C6067] font-mono">{sublabel}</span>
        <span className="flex-1 border-t border-dashed border-[#2E3238]" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        {times.map((time) => (
          <SlotCard
            key={time}
            time={time}
            accent={accent}
            list={grouped[time] || []}
            expanded={!collapsedTimes.has(time)}
            onToggle={() => toggleExpand(time)}
            onCopy={() => copySlotList(time)}
            onToggleAttended={toggleAttended}
            revealedId={revealedId}
            setRevealedId={setRevealedId}
            isAdmin={isAdmin}
            onForceCancel={onForceCancel}
          />
        ))}
      </div>
    </div>
  );
}

function SlotCard({ time, list, accent, expanded, onToggle, onCopy, onToggleAttended, revealedId, setRevealedId, isAdmin, onForceCancel }) {
  const count = list.length;
  const waitlistCount = Math.max(0, count - (WAITLIST_START - 1));
  const nearFull = count >= WARN_START && waitlistCount === 0;

  return (
    <div className={`relative flex flex-col h-full rounded-xl border ${CARD_BG_MAP[accent] || CARD_BG_MAP.gray}`}>
      <button onClick={onToggle} className="w-full text-left px-4 pt-4 pb-3 group">
        <div className="flex items-start justify-between">
          <div className="flex items-baseline gap-2">
            <Clock size={14} className="text-[#8B9099] mb-0.5" />
            <span className="font-display text-2xl font-bold tabular-nums leading-none">{time}</span>
          </div>
          {expanded ? (
            <ChevronUp size={16} className="text-[#8B9099] group-hover:text-[#F2F3F5]" />
          ) : (
            <ChevronDown size={16} className="text-[#8B9099] group-hover:text-[#F2F3F5]" />
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5 text-[#8B9099]">
            <Users size={13} />
            <span className="font-mono text-[#F2F3F5] font-semibold">{count}</span>명
          </span>
          {waitlistCount > 0 ? (
            <span className="flex items-center gap-1 rounded-full bg-pink-600/15 px-2 py-0.5 text-[11px] font-semibold text-pink-400">
              <AlertTriangle size={11} /> 대기 {waitlistCount}
            </span>
          ) : nearFull ? (
            <span className="flex items-center gap-1 rounded-full bg-[#FF6A3D]/15 px-2 py-0.5 text-[11px] font-semibold text-[#FF6A3D]">
              <AlertTriangle size={11} /> 마감임박
            </span>
          ) : null}
        </div>
      </button>

      {expanded && (
        <div className="flex flex-1 flex-col border-t border-[#2E3238] px-4 py-3">
          <div className="flex-1">
            {list.length === 0 ? (
              <p className="py-3 text-center text-xs text-[#5C6067]">아직 예약자가 없어요.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-1.5 gap-y-1">
                {list.map((m, i) => (
                  <MemberRow
                    key={m.id}
                    index={i + 1}
                    member={m}
                    tier={tierOf(i + 1)}
                    revealed={revealedId === m.id}
                    onReveal={(id) => setRevealedId(id)}
                    onToggleAttended={() => onToggleAttended(m.id, m.attended)}
                    isAdmin={isAdmin}
                    onForceCancel={() => onForceCancel(m.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <button
            onClick={onCopy}
            disabled={list.length === 0}
            className="mt-3 w-full flex items-center justify-center gap-1.5 rounded-lg border-2 border-[#2E3238] py-2 text-xs font-medium text-[#8B9099] hover:text-[#F0954F] hover:border-[#E7843B] disabled:opacity-30 transition-colors"
          >
            <Copy size={13} /> {time} 타임 명단 복사
          </button>
        </div>
      )}
    </div>
  );
}

const TIER_CLASS = {
  normal: "border-transparent",
  warn: "border-[#FF6A3D]/70 bg-[#FF6A3D]/10",
  waitlist: "border-pink-600/70 bg-pink-600/10",
};

function MemberRow({ index, member, tier, revealed, onReveal, onToggleAttended, isAdmin, onForceCancel }) {
  return (
    <div className="relative flex items-center gap-1.5 rounded-lg px-1.5 py-1 hover:bg-[#24272C] transition-colors min-w-0">
      <button
        onClick={onToggleAttended}
        className={`grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full border transition-colors ${
          member.attended ? "border-[#4ADE80] bg-[#4ADE80]/20 text-[#4ADE80]" : "border-[#3A3E45] text-transparent hover:border-[#8B9099]"
        }`}
        aria-label="출석 체크"
      >
        <Check size={11} strokeWidth={3} />
      </button>

      <span className="w-3.5 shrink-0 text-[10px] font-mono text-[#5C6067]">{index}</span>

      <button
        type="button"
        onMouseEnter={() => onReveal(member.id)}
        onMouseLeave={() => onReveal(null)}
        onClick={(e) => {
          e.stopPropagation();
          onReveal(revealed ? null : member.id);
        }}
        className={`flex-1 min-w-0 truncate rounded border px-1 py-0.5 text-left text-[13px] transition-colors ${TIER_CLASS[tier]} ${
          member.attended ? "text-[#F2F3F5]" : "text-[#D5D7DC]"
        }`}
      >
        {displayName(member.name)}
      </button>

      {revealed && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full z-10 mt-1 w-max max-w-[80vw] whitespace-nowrap rounded-lg border border-[#2E3238] bg-[#0D0E10] px-3 py-2 text-xs font-mono shadow-xl">
          <div className="text-[#F2F3F5]">회원번호 {member.phone}</div>
          {member.changed && (
            <div className="text-[#FF6A3D] mt-0.5">
              비고 : 시간 변경{member.changed_from ? ` (${member.changed_from} → ${member.time})` : ""}
            </div>
          )}
          <div className="text-[#5C6067] mt-0.5">
            작성시간 {formatClock(member.updated_at)}
            {member.changed && <span className="text-[#FF6A3D]"> (변경:{formatClock(member.commented_at)})</span>}
          </div>
          {isAdmin && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onForceCancel();
              }}
              className="mt-1 flex items-center gap-1 text-pink-400 hover:text-pink-300"
            >
              <Trash2 size={11} /> 예약 취소
            </button>
          )}
        </div>
      )}
    </div>
  );
}
