-- =========================================================================
-- BEBOLD BORAMAE · 예약 시스템 v2 스키마 (신규 Supabase 프로젝트에서 통째로 실행)
-- 구성:
--   - reservations         : 예약 데이터 (회원이 직접 생성/취소, 코치가 대신 취소도 가능)
--   - weekday_defaults     : 요일별 기본 시간표 (월~금 / 토·일) — 코치가 손대지 않아도
--                            자정마다 자동으로 적용됨
--   - schedule_overrides   : 특정 날짜만 예외로 다르게 운영할 때 (공휴일 등) 코치가 등록
--   - admin_secrets        : 코치용 PIN 저장 (anon 키로는 절대 못 읽음, RPC 함수 내부에서만 확인)
-- =========================================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------------------
-- 1. 예약 테이블
-- -------------------------------------------------------------------------
create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time text not null,          -- "HH:MM"
  name text not null,
  phone text not null,         -- 전화번호 뒷자리 4자리
  attended boolean not null default false,
  changed boolean not null default false,
  commented_at timestamptz not null default now(),  -- 예약(신청) 시각 — 정렬 기준
  updated_at timestamptz not null default now(),
  unique (date, time, name, phone)
);

create index if not exists idx_reservations_date on reservations (date);

-- -------------------------------------------------------------------------
-- 2. 요일 기본 시간표 (0=일 .. 6=토, Postgres extract(dow) 기준)
-- -------------------------------------------------------------------------
create table if not exists weekday_defaults (
  weekday int primary key check (weekday between 0 and 6),
  times text[] not null
);

insert into weekday_defaults (weekday, times) values
  (0, ARRAY['10:30','12:00']),
  (1, ARRAY['06:30','10:00','12:00','18:00','19:00','20:00','21:30']),
  (2, ARRAY['06:30','10:00','12:00','18:00','19:00','20:00','21:30']),
  (3, ARRAY['06:30','10:00','12:00','18:00','19:00','20:00','21:30']),
  (4, ARRAY['06:30','10:00','12:00','18:00','19:00','20:00','21:30']),
  (5, ARRAY['06:30','10:00','12:00','18:00','19:00','20:00','21:30']),
  (6, ARRAY['10:30','12:00'])
on conflict (weekday) do update set times = excluded.times;

-- -------------------------------------------------------------------------
-- 3. 날짜별 예외 (공휴일 등) — 있으면 요일 기본값 대신 이걸 씀
-- -------------------------------------------------------------------------
create table if not exists schedule_overrides (
  date date primary key,
  times text[] not null,
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------------------
-- 4. 코치 PIN 저장 (RLS로 anon 접근 자체를 막아버림 — 정책을 안 만들면 기본 전체 차단)
-- -------------------------------------------------------------------------
create table if not exists admin_secrets (
  key text primary key,
  value text not null
);

-- ⚠️ 실행 전에 아래 PIN 값을 원하는 숫자로 바꿔주세요 (예: '4821')
insert into admin_secrets (key, value) values ('coach_pin', 'CHANGE_ME_1234')
on conflict (key) do update set value = excluded.value;

-- -------------------------------------------------------------------------
-- 5. 예약이 실제로 열려있는 시간에만 들어가도록 막는 트리거
-- -------------------------------------------------------------------------
create or replace function validate_reservation_time()
returns trigger
language plpgsql
as $$
declare
  v_times text[];
begin
  select times into v_times from schedule_overrides where date = new.date;
  if v_times is null then
    select times into v_times from weekday_defaults where weekday = extract(dow from new.date);
  end if;

  if v_times is null or not (new.time = any(v_times)) then
    raise exception '해당 날짜(%)에는 %시간이 열려있지 않습니다', new.date, new.time;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_reservation_time on reservations;
create trigger trg_validate_reservation_time
  before insert or update of time, date on reservations
  for each row execute function validate_reservation_time();

-- -------------------------------------------------------------------------
-- 6. 관리자 전용 RPC — 시간표 예외/기본값 변경은 PIN 확인 후에만 가능
--    (테이블에 직접 anon insert/update 정책을 주지 않고, 이 함수를 통해서만 쓰게 함)
-- -------------------------------------------------------------------------
create or replace function check_admin_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correct text;
begin
  select value into v_correct from admin_secrets where key = 'coach_pin';
  return v_correct is not null and p_pin = v_correct;
end;
$$;

create or replace function set_schedule_override(p_date date, p_times text[], p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not check_admin_pin(p_pin) then
    raise exception 'PIN이 올바르지 않습니다';
  end if;
  insert into schedule_overrides (date, times, updated_at)
  values (p_date, p_times, now())
  on conflict (date) do update set times = excluded.times, updated_at = now();
end;
$$;

create or replace function clear_schedule_override(p_date date, p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not check_admin_pin(p_pin) then
    raise exception 'PIN이 올바르지 않습니다';
  end if;
  delete from schedule_overrides where date = p_date;
end;
$$;

create or replace function set_weekday_default(p_weekday int, p_times text[], p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not check_admin_pin(p_pin) then
    raise exception 'PIN이 올바르지 않습니다';
  end if;
  insert into weekday_defaults (weekday, times) values (p_weekday, p_times)
  on conflict (weekday) do update set times = excluded.times;
end;
$$;

grant execute on function check_admin_pin(text) to anon;
grant execute on function set_schedule_override(date, text[], text) to anon;
grant execute on function clear_schedule_override(date, text) to anon;
grant execute on function set_weekday_default(int, text[], text) to anon;

-- -------------------------------------------------------------------------
-- 7. Row Level Security
-- -------------------------------------------------------------------------
alter table reservations enable row level security;
alter table weekday_defaults enable row level security;
alter table schedule_overrides enable row level security;
alter table admin_secrets enable row level security;
-- admin_secrets: 정책을 아예 안 만듦 → anon은 완전히 접근 불가 (RPC 함수만 SECURITY DEFINER로 우회)

-- reservations: 조회는 누구나, 예약 생성/취소/출석체크는 이름+전화번호 뒷자리 확인 정도의
-- 가벼운 신뢰 모델로 열어둠 (이 앱은 로그인 없는 소규모 내부 도구라는 전제)
create policy "read reservations" on reservations for select using (true);
create policy "book reservation" on reservations for insert with check (true);
create policy "cancel reservation" on reservations for delete using (true);
create policy "update attended" on reservations for update using (true);

-- weekday_defaults / schedule_overrides: 조회(오늘 열린 시간 확인)는 누구나,
-- 변경은 위 RPC 함수(PIN 확인)를 통해서만 — 테이블에 직접 쓰는 정책은 만들지 않음
create policy "read weekday_defaults" on weekday_defaults for select using (true);
create policy "read schedule_overrides" on schedule_overrides for select using (true);
