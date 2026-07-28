-- =========================================================================
-- BEBOLD BORAMAE · v4 마이그레이션 (신규 Supabase 프로젝트 SQL Editor에서 실행)
-- 내용:
--   일반 회원의 예약 생성/시간변경/취소를 "당일(오늘)"만 가능하도록 서버단에서 강제.
--   - 어제까지(과거) 날짜: 조회(select)만 가능, 생성/변경/취소 불가
--   - 내일 이후(미래) 날짜: 마찬가지로 생성/변경/취소 불가
--   - 관리자(코치)는 PIN 인증 RPC(admin_cancel_reservation)를 통해서만 예외적으로
--     날짜 상관없이 강제 취소 가능 (기존 forceCancel 기능 유지)
--   - "출석 체크(attended)" 토글은 이 제한과 무관 (기존 동작 그대로 유지)
--   - 네이버 동기화 스크립트(naver_cafe_sync.py)는 service_role 키를 쓰기 때문에
--     RLS 자체가 적용되지 않아 이 마이그레이션의 영향을 받지 않음
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. INSERT(예약 생성) — 오늘 날짜인 경우에만 허용
-- -------------------------------------------------------------------------
drop policy if exists "book reservation" on reservations;
create policy "book reservation" on reservations
  for insert
  with check (date = (now() at time zone 'Asia/Seoul')::date);

-- -------------------------------------------------------------------------
-- 2. DELETE(회원 본인 취소) — 오늘 날짜인 경우에만 허용
--    (관리자 강제취소는 아래 admin_cancel_reservation RPC로 별도 처리)
-- -------------------------------------------------------------------------
drop policy if exists "cancel reservation" on reservations;
create policy "cancel reservation" on reservations
  for delete
  using (date = (now() at time zone 'Asia/Seoul')::date);

-- -------------------------------------------------------------------------
-- 3. UPDATE(시간 변경) — 컬럼 단위로 트리거에서 검사.
--    RLS의 update policy는 attended 토글과 시간변경을 구분하지 못하므로(둘 다
--    같은 "update" 정책을 타기 때문에) 기존 "update attended" 정책은 그대로 두고,
--    time/date 컬럼이 실제로 SET 되는 경우에만 트리거로 "오늘"인지 검사한다.
-- -------------------------------------------------------------------------
create or replace function enforce_same_day_mutation()
returns trigger
language plpgsql
as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if old.date <> v_today then
    raise exception '지난 날짜의 예약은 변경할 수 없습니다';
  end if;
  if new.date <> v_today then
    raise exception '오늘 날짜로만 변경할 수 있습니다';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_same_day_mutation on reservations;
create trigger trg_enforce_same_day_mutation
  before update of time, date on reservations
  for each row execute function enforce_same_day_mutation();

-- -------------------------------------------------------------------------
-- 4. 관리자 강제취소 RPC — PIN 확인 후 날짜 상관없이 취소 (RLS/트리거 우회)
--    SECURITY DEFINER 함수는 테이블 소유자 권한으로 실행되어 RLS를 우회한다.
-- -------------------------------------------------------------------------
create or replace function admin_cancel_reservation(p_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not check_admin_pin(p_pin) then
    raise exception 'PIN이 올바르지 않습니다';
  end if;
  delete from reservations where id = p_id;
end;
$$;

grant execute on function admin_cancel_reservation(uuid, text) to anon;
