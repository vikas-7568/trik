-- 04_doctor_memory.sql : Doctor Memory (learns each doctor's prescribing habits)
-- One append-only row per medicine line of every APPROVED prescription.
-- No patient identity is stored here: no name, phone, age, patient id.

create table if not exists public.doctor_rx_memory (
  id               bigint generated always as identity primary key,
  doctor_id        text not null,
  clinic_id        text not null,
  prescription_id  text not null,
  approved_at      timestamptz not null,
  diagnosis_norm   text not null default '',
  spoken_norm      text not null,          -- what the doctor said, normalised
  base_norm        text not null,          -- approved brand base
  label            text not null,          -- approved label, e.g. "Dolo 650 mg"
  cdci_code        text,
  form_text        text not null default '',
  frequency        text not null default '',
  duration         text not null default '',
  after_food       boolean,
  doctor_confirmed boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (prescription_id, label)          -- re-running the learner for one Rx cannot double count
);
create index if not exists doctor_rx_memory_scope_idx
  on public.doctor_rx_memory (clinic_id, doctor_id, approved_at desc);

-- Only the backend (service role) reads and writes. App users never query this table directly.
alter table public.doctor_rx_memory enable row level security;
