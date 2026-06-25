// admin-create-user — first Edge Function in the repo (issue #6).
//
// Privileged user creation for the DIA pilot. The browser never holds the
// service_role key; it calls this function with the admin's JWT. The function:
//   1. verifies the caller is an authenticated admin (via get_my_role());
//   2. uses the service_role key to create the auth user + sync the profile.
//
// Request:  POST { email, password, display_name, role, tenant? }
// Response: 200 { user_id, email, role, tenant } | 4xx/5xx { error }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'

const VALID_ROLES = ['admin', 'branch_manager', 'field_operator', 'read_only']

interface CreateUserBody {
  email?: string
  password?: string
  display_name?: string
  role?: string
  tenant?: string
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'Server misconfigured: missing Supabase env vars' }, 500)
  }

  // ── 1. Authenticate the caller from the Bearer token ──────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'Missing or invalid Authorization header' }, 401)
  }

  // Anon client bound to the caller's JWT → RLS + get_my_role() run as the caller.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userData, error: userErr } = await callerClient.auth.getUser()
  if (userErr || !userData?.user) {
    return jsonResponse({ error: 'Invalid or expired token' }, 401)
  }

  // ── 2. Authorize: caller must be admin ────────────────────────────────────
  const { data: callerRole, error: roleErr } = await callerClient.rpc('get_my_role')
  if (roleErr) {
    return jsonResponse({ error: `Could not resolve caller role: ${roleErr.message}` }, 403)
  }
  if (callerRole !== 'admin') {
    return jsonResponse({ error: 'Only admins can create users' }, 403)
  }

  // ── 3. Validate the request body ──────────────────────────────────────────
  let body: CreateUserBody
  try {
    body = (await req.json()) as CreateUserBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const email = body.email?.trim()
  const password = body.password
  const displayName = body.display_name?.trim() || (email ? email.split('@')[0] : '')
  const role = body.role?.trim()

  if (!email || !password) {
    return jsonResponse({ error: 'email and password are required' }, 400)
  }
  if (!role || !VALID_ROLES.includes(role)) {
    return jsonResponse({ error: `role must be one of ${VALID_ROLES.join(', ')}` }, 400)
  }

  // Default tenant to the caller's tenant when omitted.
  let tenant = body.tenant?.trim()
  if (!tenant) {
    const { data: callerTenant } = await callerClient.rpc('get_my_tenant')
    tenant = (callerTenant as string) || 'default'
  }

  // ── 4. Create the user with the service_role admin client ─────────────────
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role, tenant },
    user_metadata: { display_name: displayName },
  })

  if (createErr || !created?.user) {
    return jsonResponse({ error: createErr?.message ?? 'Failed to create user' }, 400)
  }

  const newUserId = created.user.id

  // ── 5. Ensure the profile row reflects the chosen values (trigger may have
  //       already synced from app_metadata; upsert to be safe). ──────────────
  const { error: profileErr } = await adminClient
    .from('profiles')
    .upsert(
      {
        id: newUserId,
        display_name: displayName,
        role,
        tenant,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )

  if (profileErr) {
    return jsonResponse({ error: `User created but profile sync failed: ${profileErr.message}` }, 500)
  }

  return jsonResponse({ user_id: newUserId, email, role, tenant }, 200)
})
