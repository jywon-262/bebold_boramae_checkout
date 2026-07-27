-- 이미 v1 스키마로 테이블을 만들어두셨다면, 아래만 실행하면 v2로 업그레이드됩니다.
-- (테이블을 새로 만들 필요 없이 기존 데이터는 유지됩니다)

alter table reservations add column if not exists changed boolean not null default false;
alter table reservations add column if not exists commented_at timestamptz;

create index if not exists idx_reservations_date_time_commented
  on reservations (date, time, commented_at);
