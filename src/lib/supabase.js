import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

// Browser client using the public anon key. Row-level security on the `trees`
// table is what actually guards the data — never ship the service_role key here.
export const supabase =
  PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_ANON_KEY
    ? createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY)
    : null;

// The whole tree is stored as one JSON blob in a single row.
export const TREE_ID = 'default';
