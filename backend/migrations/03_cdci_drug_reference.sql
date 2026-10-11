-- 03_cdci_drug_reference.sql  (apply after drug_references_schema.sql and 02_add_pgvector.sql)
-- Drug reference tables built from Common Drug Codes for India (CDCI) Flat Files Package,
-- NRCeS / C-DAC Pune, CC BY 4.0. Column choices match the actual CDCI files.
-- Tested on PostgreSQL 16 (same major version family as Supabase).

create extension if not exists pg_trgm;

-- One row per imported CDCI release.
create table if not exists public.drug_releases (
  id              serial primary key,
  source          text not null default 'CDCI',
  release_date    date not null unique,          -- from the NRCeS release note, passed to the importer
  imported_at     timestamptz not null default now(),
  brand_count     int not null,
  generic_count   int not null,
  file_sha256     jsonb not null                 -- checksum per file, proves exactly what was imported
);

create table if not exists public.drug_substances (     -- SubstanceMaster.txt
  code       text primary key,                          -- Identifier (SNOMED CT id)
  name       text not null,                             -- Substance Name, e.g. "Acetaminophen"
  name_norm  text not null
);

create table if not exists public.drug_dose_forms (     -- DrugFormMaster.txt
  code text primary key,                                -- Id
  name text not null                                    -- Dose Form
);

create table if not exists public.drug_routes (         -- RouteOfAdministrationMaster.txt
  code text primary key,                                -- Identifier
  name text not null                                    -- RouteOfAdministration
);

create table if not exists public.drug_generics (       -- GenericMaster.txt
  code             text primary key,                    -- Identifier
  name             text not null,                       -- Generic Name, e.g. "Acetaminophen 650 mg oral tablet"
  name_norm        text not null,
  substance_codes  text[] not null default '{}',        -- "Substance Identifier", split on '+'
  route_codes      text[] not null default '{}',        -- "Route of Administration", split on '+'
  dose_form_code   text                                 -- "Dose Form" (not FK: a few codes are missing from DrugFormMaster)
  -- Therapeutic Role / Indication / Contra Indication / Interaction columns are NOT imported.
  -- They are sparse and unreviewed by us. If we ever use them, it is a separate, reviewed project.
);

create table if not exists public.drug_suppliers (      -- SupplierMaster.txt
  code text primary key,
  name text not null
);

create table if not exists public.drug_products (       -- ProductMaster.txt: bare brand, e.g. "Dolo"
  code      text primary key,
  name      text not null,
  name_norm text not null
);

do $$ begin
  create type public.drug_source as enum ('cdci', 'mr_catalogue', 'clinic_correction', 'manual');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.drug_review as enum ('unreviewed', 'reviewed', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.drug_brands (         -- BrandMaster.txt + parsed fields
  id               bigint generated always as identity primary key,
  cdci_code        text unique,                         -- Identifier; null for non-CDCI rows
  brand_name       text not null,                       -- "Dolo 650 mg oral tablet" (full label)
  product_code     text references public.drug_products(code),
  base_name        text not null,                       -- "Dolo"
  base_norm        text not null,                       -- "dolo"
  strength_text    text not null default '',            -- "650 mg" / "500 mg + 125 mg" / "250 mg/5 mL"
  strength_mg      numeric,                             -- single solid component in mg, else null
  total_mg         numeric,                             -- sum of combo components in mg (Augmentin DUO 625)
  form_text        text not null default '',            -- "gastro-resistant oral tablet"
  is_oral          boolean not null default false,
  generic_code     text references public.drug_generics(code),   -- null for the 14 brands whose generic is missing
  supplier_code    text references public.drug_suppliers(code),
  source           public.drug_source not null default 'cdci',
  review_status    public.drug_review not null default 'unreviewed',
  is_active        boolean not null default true,
  release_id       int references public.drug_releases(id),
  cdci_updated_on  date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Non-CDCI rows must say where they came from; CDCI rows must carry a code.
  constraint drug_brands_source_code check ((source = 'cdci') = (cdci_code is not null))
);
create index if not exists drug_brands_base_norm_idx on public.drug_brands (base_norm) where is_active;
create index if not exists drug_brands_base_trgm_idx on public.drug_brands using gin (base_norm gin_trgm_ops);
create index if not exists drug_brands_generic_idx   on public.drug_brands (generic_code);

-- CDCI uses SNOMED/US generic names (Acetaminophen). Indian doctors say Paracetamol.
create table if not exists public.drug_generic_synonyms (
  indian_name  text primary key,       -- 'paracetamol'
  snomed_name  text not null,          -- 'acetaminophen'
  reviewed_by  text not null,          -- a person, not a script
  created_at   timestamptz not null default now()
);

-- Spelling / speech-recognition aliases ONLY. Never a different brand, never a strength.
create table if not exists public.drug_aliases (
  alias_norm text primary key,         -- 'dolow'
  base_norm  text not null,            -- 'dolo'
  added_by   text not null,
  created_at timestamptz not null default now()
);

-- Read-only for signed-in app users; writes only via the importer (service role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['drug_releases','drug_substances','drug_dose_forms','drug_routes',
                           'drug_generics','drug_suppliers','drug_products','drug_brands',
                           'drug_generic_synonyms','drug_aliases']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;
