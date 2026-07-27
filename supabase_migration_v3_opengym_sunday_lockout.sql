-- =========================================================================
-- BEBOLD BORAMAE · v3 마이그레이션 (신규 Supabase 프로젝트 SQL Editor에서 실행)
-- 내용:
--   1) 일요일은 더 이상 고정 요일 기본값을 쓰지 않음 — "1/3(/5)주 = 오픈짐 기본",
--      "2/4주 = 휴회 기본"으로 자동 계산됨 (sunday_pattern_defaults)
--   2) "오픈짐" 프리셋을 아무 날짜(월~토 포함, 공휴일 등)에도 적용 가능하도록 지원
--   3) 관리자 PIN 무한 시도 방지 — 5회 연속 틀리면 2분 잠금 (admin_pin_state)
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. 일요일은 더 이상 weekday_defaults의 고정값을 쓰지 않음
-- -------------------------------------------------------------------------
delete from weekday_defaults where weekday = 0;

-- -------------------------------------------------------------------------
-- 2. 일요일 홀수주(1/3/5주)=오픈짐 기본, 짝수주(2/4주)=휴회 기본
-- -------------------------------------------------------------------------
create table if not exists sunday_pattern_defaults (
  parity text primary key check (parity in ('odd', 'even')),
  times text[] not null
);

insert into sunday_pattern_defaults (parity, times) values
  ('odd', ARRAY['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00']),  -- 1/3(/5)주 일요일 오픈짐 기본 시간(10:00~18:00) — 관리자 화면에서 나중에 조정 가능
  ('even', ARRAY[]::text[])                  -- 2/4주 일요일 기본 휴회(시간 없음)
on conflict (parity) do update set times = excluded.times;

alter table sunday_pattern_defaults enable row level security;
drop policy if exists "read sunday_pattern_defaults" on sunday_pattern_defaults;
create policy "read sunday_pattern_defaults" on sunday_pattern_defaults for select using (true);

-- -------------------------------------------------------------------------
-- 3. 예약 유효성 검사 트리거 — 일요일은 홀/짝주 패턴을 보도록 갱신
-- -------------------------------------------------------------------------
create or replace function validate_reservation_time()
returns trigger
language plpgsql
as $$
declare
  v_times text[];
  v_dow int;
  v_nth int;
  v_parity text;
begin
  select times into v_times from schedule_overrides where date = new.date;

  if v_times is null then
    v_dow := extract(dow from new.date);
    if v_dow = 0 then
      v_nth := ceil(extract(day from new.date) / 7.0);
      v_parity := case when v_nth % 2 = 1 then 'odd' else 'even' end;
      select times into v_times from sunday_pattern_defaults where parity = v_parity;
    else
      select times into v_times from weekday_defaults where weekday = v_dow;
    end if;
  end if;

  if v_times is null or not (new.time = any(v_times)) then
    raise exception '해당 날짜(%)에는 %시간이 열려있지 않습니다', new.date, new.time;
  end if;
  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- 4. 일요일 홀/짝주 기본값을 바꾸는 관리자 RPC (평소엔 안 건드려도 됨 — 예외적으로
--    "오픈짐 기본 시간대 자체"를 바꾸고 싶을 때만 사용. 특정 날짜 하나만 다르게
--    하고 싶으면 set_schedule_override를 그대로 쓰면 됨)
-- -------------------------------------------------------------------------
create or replace function set_sunday_pattern_default(p_parity text, p_times text[], p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not check_admin_pin(p_pin) then
    raise exception 'PIN이 올바르지 않습니다';
  end if;
  if p_parity not in ('odd', 'even') then
    raise exception 'parity는 odd 또는 even 이어야 합니다';
  end if;
  insert into sunday_pattern_defaults (parity, times) values (p_parity, p_times)
  on conflict (parity) do update set times = excluded.times;
end;
$$;

grant execute on function set_sunday_pattern_default(text, text[], text) to anon;

-- -------------------------------------------------------------------------
-- 5. 관리자 PIN 무한 시도 방지 — 5회 연속 틀리면 2분간 전체 잠금
--    (틀린 시도 자체를 세는 거라 누가 시도하든 카운트가 같이 올라감 — 소규모
--    내부 도구에서 구현 난이도 대비 충분히 실용적인 수준의 보호)
-- -------------------------------------------------------------------------
create table if not exists admin_pin_state (
  id int primary key default 1 check (id = 1),
  fail_count int not null default 0,
  locked_until timestamptz
);
insert into admin_pin_state (id) values (1) on conflict (id) do nothing;
alter table admin_pin_state enable row level security;
-- 정책 없음 → anon 직접 접근 불가, check_admin_pin() 함수 내부에서만 SECURITY DEFINER로 접근

create or replace function check_admin_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correct text;
  v_state admin_pin_state%rowtype;
  v_ok boolean;
begin
  select * into v_state from admin_pin_state where id = 1 for update;

  if v_state.locked_until is not null and v_state.locked_until > now() then
    raise exception '너무 많이 시도했습니다. %까지 잠깁니다', to_char(v_state.locked_until, 'HH24:MI:SS');
  end if;

  select value into v_correct from admin_secrets where key = 'coach_pin';
  v_ok := v_correct is not null and p_pin = v_correct;

  if v_ok then
    update admin_pin_state set fail_count = 0, locked_until = null where id = 1;
  else
    update admin_pin_state
      set fail_count = v_state.fail_count + 1,
          locked_until = case when v_state.fail_count + 1 >= 5 then now() + interval '2 minutes' else null end
      where id = 1;
  end if;

  return v_ok;
end;
$$;

grant execute on function check_admin_pin(text) to anon;
