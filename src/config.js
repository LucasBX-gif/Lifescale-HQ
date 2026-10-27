// Supabase project. The anon key is designed to be public: the database rules
// in supabase/schema.sql are what keep your data private.
export const SUPABASE_URL = "https://knmohuhsrphggevrsets.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_5uJubFCAwtxdzIMkCiL1pg_bNk0DGE3";

// Employee of the month scoring.
export const POINTS_PER_FLOW_MINUTE = 1;
export const POINTS_PER_WIN = 25;
export const POINTS_PER_FULL_DAY = 15; // checked in AND wrote what you did

// Flow timer stops itself if your Mac has had no keyboard/mouse input for this long.
export const IDLE_CUTOFF_MINUTES = 10;

// Celebrations: shortest flow session that gets the full-screen message.
export const CHEER_MIN_FLOW_MINUTES = 20;
// Shortest partner session that pops up on your screen.
export const CHEER_MIN_PARTNER_FLOW_MINUTES = 30;

// Bonus for every minute you're both in flow at the same time (on top of the normal flow point).
export const POINTS_PER_TOGETHER_MINUTE = 0.5;
