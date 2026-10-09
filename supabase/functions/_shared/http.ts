export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function envKeys() {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SUPABASE_SECRET_KEY')
    ?? '';
  let anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!anon) {
    try {
      const parsed = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
      anon = parsed.default || parsed.anon || '';
    } catch {
      anon = '';
    }
  }
  return { url, service, anon };
}
