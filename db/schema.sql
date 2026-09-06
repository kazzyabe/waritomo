-- ワリトモ initial PostgreSQL schema.
-- IDs are text to keep application-level ID generation portable.

create table if not exists line_users (
  id text primary key,
  line_user_id text not null unique,
  display_name text,
  picture_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists groups (
  id text primary key,
  owner_user_id text not null references line_users(id),
  name text not null,
  base_currency_code char(3) not null,
  rounding_unit numeric(18, 4) not null default 1,
  invite_token text not null unique,
  allow_member_self_add boolean not null default false,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table groups add column if not exists completed_at timestamptz;

create table if not exists group_members (
  id text primary key,
  group_id text not null references groups(id) on delete cascade,
  line_user_id text references line_users(id),
  name text not null,
  color_code text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, line_user_id),
  unique (group_id, name)
);

-- Written by nothing today. Every amount is stored in JPY and settlement.js
-- reads rate_to_base from its own input, not from here. It stays because the
-- settlement code already carries the multi-currency shape and this is where
-- the rates would live; drop it if that stops being the plan.
create table if not exists group_currencies (
  group_id text not null references groups(id) on delete cascade,
  currency_code char(3) not null,
  rate_to_base numeric(24, 10) not null default 1,
  rate_source text,
  rate_captured_at timestamptz not null default now(),
  primary key (group_id, currency_code)
);

create table if not exists expenses (
  id text primary key,
  group_id text not null references groups(id) on delete cascade,
  payer_member_id text not null references group_members(id),
  created_by_user_id text not null references line_users(id),
  title text not null,
  currency_code char(3) not null,
  amount numeric(18, 4) not null check (amount > 0),
  rate_to_base numeric(24, 10) not null default 1,
  split_mode text not null check (split_mode in ('equal', 'custom')),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists expense_debtors (
  expense_id text not null references expenses(id) on delete cascade,
  member_id text not null references group_members(id),
  amount numeric(18, 4) not null check (amount >= 0),
  primary key (expense_id, member_id)
);

create table if not exists settlement_confirmations (
  id text primary key,
  group_id text not null references groups(id) on delete cascade,
  from_member_id text not null references group_members(id),
  to_member_id text not null references group_members(id),
  amount numeric(18, 4) not null check (amount > 0),
  currency_code char(3) not null,
  marked_paid_by_user_id text references line_users(id),
  confirmed_by_user_id text references line_users(id),
  marked_paid_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_group_members_group on group_members(group_id);
create index if not exists idx_expenses_group on expenses(group_id, created_at desc);
create index if not exists idx_expense_debtors_member on expense_debtors(member_id);
