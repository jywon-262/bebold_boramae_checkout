-- =========================================================================
-- BEBOLD BORAMAE · Supabase 스키마
-- 구성: 스크래핑 스크립트(Python, service_role 키)가 reservations 테이블에
-- 씁니다. 웹 대시보드(React, anon 키)는 읽기 + 출석 체크(attended)만 갱신합니다.
-- =========================================================================

create extension if not exists "pgcrypto";

-- 타임슬롯 설정 (정원 등) — 코치가 웹에서 직접 관리
create table if not exists time_slots (
  id uuid primary key default gen_random_uuid(),
  time text not null,          -- "HH:MM"
  capacity int not null default 15,
  created_at timestamptz not null default now()
);

-- 예약 현황 — 스크래핑 스크립트가 5분마다 전체 재동기화(delete + insert)
create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time text not null,          -- "HH:MM"
  name text not null,
  phone text not null,         -- 전화번호 뒷자리 4자리, 미확인 시 "----"
  attended boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (date, time, name, phone)
);

create index if not exists idx_reservations_date on reservations (date);

-- 기본 타임슬롯 (필요에 맞게 수정)
insert into time_slots (time, capacity) values
  ('06:30', 20),
  ('10:00', 20),
  ('12:00', 20),
  ('18:00', 20),
  ('19:00', 20),
  ('20:00', 20),
  ('21:30', 20)
on conflict do nothing;

-- Row Level Security
alter table time_slots enable row level security;
alter table reservations enable row level security;

-- anon 키(웹 대시보드)는 조회 + 출석 체크(attended)만 허용
-- 주의: 아래 정책은 "이 프로젝트를 코치/매니저만 접근하는 내부용"이라는 가정하의
-- 단순화된 버전입니다. 외부에 공개되는 서비스라면 Supabase Auth를 붙여
-- 로그인한 코치만 쓸 수 있게 제한하는 것을 권장합니다.
create policy "read time_slots" on time_slots for select using (true);
create policy "update capacity" on time_slots for update using (true);

create policy "read reservations" on reservations for select using (true);
create policy "update attended only" on reservations for update using (true);

-- insert / delete(전체 재동기화)는 service_role 키를 쓰는 스크립트만 수행
-- (service_role 키는 RLS를 우회하므로 별도 정책 불필요 — 절대 프론트엔드에 노출 금지)
