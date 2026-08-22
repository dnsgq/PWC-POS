-- PWC Prints & Crafts POS — database schema

create table employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin text not null,
  role text not null check (role in ('Employee','Manager','Admin','Owner')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id),
  employee_name text not null,
  role text not null,
  date date not null,
  clock_in timestamptz not null,
  clock_out timestamptz
);

create table transactions (
  id text primary key,
  amount numeric not null,
  description text,
  type text not null check (type in ('Cash In','Cash Out')),
  destination text not null check (destination in ('Cash','GCash')),
  category text not null,
  datetime timestamptz not null,
  notes text,
  created_by uuid references employees(id),
  created_by_name text
);

create table closings (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  opening_cash numeric not null default 0,
  opening_gcash numeric not null default 0,
  expected_cash numeric,
  expected_gcash numeric,
  counted_cash numeric,
  cash_difference numeric,
  counted_gcash numeric,
  gcash_difference numeric,
  denominations jsonb,
  status text not null default 'Draft' check (status in ('Draft','Closed')),
  closed_by text,
  closed_at timestamptz
);

-- Seed the two default accounts
insert into employees (name, pin, role) values
  ('Razel', '1109', 'Admin'),
  ('Raquel', '7178', 'Owner');

-- Enable row-level security with permissive policies.
-- This app uses its own in-app PIN login rather than Supabase Auth,
-- so access control lives in the app itself, not in the database.
alter table employees enable row level security;
alter table attendance enable row level security;
alter table transactions enable row level security;
alter table closings enable row level security;

create policy "allow all - employees" on employees for all using (true) with check (true);
create policy "allow all - attendance" on attendance for all using (true) with check (true);
create policy "allow all - transactions" on transactions for all using (true) with check (true);
create policy "allow all - closings" on closings for all using (true) with check (true);
