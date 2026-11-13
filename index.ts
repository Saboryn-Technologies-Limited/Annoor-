// Supabase Edge Function: verify-payment
// Asks Paystack whether a payment really succeeded, then marks it PAID in the database.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: 'Please log in again.' });

    const { reference } = await req.json();
    if (!reference || typeof reference !== 'string') return json({ error: 'Missing reference.' });

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Only the parent's own payment can be checked.
    const { data: pay } = await admin.from('payments').select('*')
      .eq('reference', reference).eq('user_id', user.id).maybeSingle();
    if (!pay) return json({ status: 'FAILED' });
    if (pay.status === 'PAID') return json({ status: 'PAID' });

    const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      headers: { Authorization: 'Bearer ' + Deno.env.get('PAYSTACK_SECRET_KEY') },
    });
    const p = await r.json();
    if (!p.status) return json({ status: pay.status }); // could not confirm right now

    const d = p.data;
    // Paid only if Paystack says success AND the amount and currency match what we asked for.
    if (d.status === 'success' && d.amount === pay.amount_kobo && d.currency === 'NGN') {
      await admin.from('payments').update({ status: 'PAID' }).eq('id', pay.id);
      return json({ status: 'PAID' });
    }
    if (d.status === 'failed') {
      await admin.from('payments').update({ status: 'FAILED' }).eq('id', pay.id);
      return json({ status: 'FAILED' });
    }
    return json({ status: 'PENDING' });
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' });
  }
});
