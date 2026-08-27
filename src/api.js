import { supabase } from './supabaseClient';

// ---- mappers: DB rows (snake_case) <-> app objects (camelCase) ----

const empFromDb = (r) => ({ id: r.id, name: r.name, pin: r.pin, role: r.role, active: r.active });

const attFromDb = (r) => ({
  id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, role: r.role,
  date: r.date, clockIn: r.clock_in, clockOut: r.clock_out,
});

const txnFromDb = (r) => ({
  id: r.id, amount: Number(r.amount), description: r.description, type: r.type,
  destination: r.destination, category: r.category, datetime: r.datetime, notes: r.notes,
  createdBy: r.created_by, createdByName: r.created_by_name,
});

const clsFromDb = (r) => ({
  id: r.id, date: r.date,
  openingCash: Number(r.opening_cash) || 0, openingGCash: Number(r.opening_gcash) || 0,
  expectedCash: r.expected_cash != null ? Number(r.expected_cash) : null,
  expectedGCash: r.expected_gcash != null ? Number(r.expected_gcash) : null,
  countedCash: r.counted_cash != null ? Number(r.counted_cash) : null,
  cashDifference: r.cash_difference != null ? Number(r.cash_difference) : null,
  countedGCash: r.counted_gcash != null ? Number(r.counted_gcash) : null,
  gcashDifference: r.gcash_difference != null ? Number(r.gcash_difference) : null,
  denominations: r.denominations, status: r.status, closedBy: r.closed_by, closedAt: r.closed_at,
  notes: r.notes, photoUrl: r.photo_url,
});

// ---- employees ----

export async function fetchEmployees() {
  const { data, error } = await supabase.from('employees').select('*').order('created_at');
  if (error) throw error;
  return data.map(empFromDb);
}

export async function insertEmployee(e) {
  const { data, error } = await supabase
    .from('employees')
    .insert({ name: e.name, pin: e.pin, role: e.role, active: e.active })
    .select()
    .single();
  if (error) throw error;
  return empFromDb(data);
}

export async function updateEmployeeActive(id, active) {
  const { error } = await supabase.from('employees').update({ active }).eq('id', id);
  if (error) throw error;
}

// ---- attendance ----

export async function fetchAttendance() {
  const { data, error } = await supabase.from('attendance').select('*');
  if (error) throw error;
  return data.map(attFromDb);
}

export async function insertAttendance(a) {
  const { data, error } = await supabase
    .from('attendance')
    .insert({
      employee_id: a.employeeId, employee_name: a.employeeName, role: a.role,
      date: a.date, clock_in: a.clockIn, clock_out: a.clockOut,
    })
    .select()
    .single();
  if (error) throw error;
  return attFromDb(data);
}

export async function clockOutAttendance(id, clockOutIso) {
  const { error } = await supabase.from('attendance').update({ clock_out: clockOutIso }).eq('id', id);
  if (error) throw error;
}

// ---- transactions ----

export async function fetchTransactions() {
  const { data, error } = await supabase.from('transactions').select('*');
  if (error) throw error;
  return data.map(txnFromDb);
}

export async function insertTransaction(t) {
  const { error } = await supabase.from('transactions').insert({
    id: t.id, amount: t.amount, description: t.description, type: t.type,
    destination: t.destination, category: t.category, datetime: t.datetime, notes: t.notes,
    created_by: t.createdBy, created_by_name: t.createdByName,
  });
  if (error) throw error;
}

// ---- closings ----

export async function fetchClosings() {
  const { data, error } = await supabase.from('closings').select('*');
  if (error) throw error;
  return data.map(clsFromDb);
}

export async function upsertClosing(c) {
  const payload = {
    date: c.date,
    opening_cash: c.openingCash, opening_gcash: c.openingGCash,
    expected_cash: c.expectedCash ?? null, expected_gcash: c.expectedGCash ?? null,
    counted_cash: c.countedCash ?? null, cash_difference: c.cashDifference ?? null,
    counted_gcash: c.countedGCash ?? null, gcash_difference: c.gcashDifference ?? null,
    denominations: c.denominations ?? null, status: c.status,
    closed_by: c.closedBy ?? null, closed_at: c.closedAt ?? null,
    notes: c.notes ?? null, photo_url: c.photoUrl ?? null,
  };
  const { data, error } = await supabase
    .from('closings')
    .upsert(payload, { onConflict: 'date' })
    .select()
    .single();
  if (error) throw error;
  return clsFromDb(data);
}

export async function uploadClosingPhoto(file, keyHint) {
  const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'jpg';
  const path = `${keyHint}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('closing-photos').upload(path, file, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('closing-photos').getPublicUrl(path);
  return data.publicUrl;
}

// ---- push subscriptions ----

export async function fetchPushSubscriptionForEndpoint(endpoint) {
  const { data, error } = await supabase.from('push_subscriptions').select('*').eq('endpoint', endpoint).maybeSingle();
  if (error) throw error;
  return data;
}

export async function savePushSubscription({ employeeId, employeeName, role, subscription }) {
  const json = subscription.toJSON();
  const { error } = await supabase.from('push_subscriptions').upsert({
    employee_id: employeeId,
    employee_name: employeeName,
    role,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

export async function deletePushSubscription(endpoint) {
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw error;
}

// ---- category spending limits ----

export async function fetchCategoryLimits() {
  const { data, error } = await supabase.from('category_limits').select('*');
  if (error) throw error;
  return data.map(r => ({ category: r.category, monthlyLimit: Number(r.monthly_limit), updatedBy: r.updated_by }));
}

export async function upsertCategoryLimit(category, monthlyLimit, updatedBy) {
  const { error } = await supabase.from('category_limits').upsert({
    category, monthly_limit: monthlyLimit, updated_by: updatedBy, updated_at: new Date().toISOString(),
  }, { onConflict: 'category' });
  if (error) throw error;
}

export async function deleteCategoryLimit(category) {
  const { error } = await supabase.from('category_limits').delete().eq('category', category);
  if (error) throw error;
}

