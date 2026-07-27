import { createClient } from "@supabase/supabase-js";

// Vercel/로컬 .env에 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 를 설정하세요.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
