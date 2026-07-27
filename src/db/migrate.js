const { pool } = require("./pool");

async function migrate() {
  await pool.query(`
    create table if not exists patients (
      id serial primary key,
      name varchar(150) not null,
      phone varchar(30) not null
    );

    create table if not exists users (
      id serial primary key,
      name varchar(150) not null,
      email varchar(150) unique not null,
      demo_password varchar(80) not null default 'demo123',
      role varchar(20) not null check (role in ('patient', 'staff')),
      patient_id integer references patients(id)
    );

    alter table users add column if not exists demo_password varchar(80) not null default 'demo123';

    create table if not exists specializations (
      id serial primary key,
      name varchar(120) unique not null
    );

    create table if not exists doctors (
      id serial primary key,
      name varchar(150) not null,
      title varchar(150) not null,
      room varchar(50) not null,
      specialization_id integer not null references specializations(id)
    );

    create table if not exists slots (
      id serial primary key,
      doctor_id integer not null references doctors(id),
      date date not null,
      start_time time not null,
      end_time time not null,
      status varchar(20) not null default 'available' check (status in ('available', 'booked'))
    );

    create table if not exists appointments (
      id serial primary key,
      patient_id integer not null references patients(id),
      slot_id integer not null references slots(id),
      status varchar(20) not null default 'booked' check (status in ('booked', 'confirmed', 'cancelled')),
      type varchar(20) not null default 'in_person' check (type in ('in_person', 'online')),
      created_at timestamptz not null default now()
    );

    create unique index if not exists one_active_appointment_per_slot
      on appointments(slot_id)
      where status in ('booked', 'confirmed');

    -- ===== Dynamic Appointment Rescheduling & Waiting List (Day 3) =====
    create table if not exists waitlist_entries (
      id          serial primary key,
      patient_id  integer not null references patients(id),
      doctor_id   integer not null references doctors(id),
      date_from   date not null,
      date_to     date not null,
      status      varchar(20) not null default 'active'
                  check (status in ('active', 'fulfilled', 'cancelled', 'expired')),
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now(),
      check (date_from <= date_to)
    );

    -- BR-06: mỗi bệnh nhân chỉ có 1 entry đang hoạt động cho mỗi bác sĩ
    create unique index if not exists one_active_waitlist_per_patient_doctor
      on waitlist_entries(patient_id, doctor_id) where status = 'active';

    -- BR-01: phục vụ truy vấn chọn bệnh nhân theo FIFO
    create index if not exists idx_waitlist_doctor_active
      on waitlist_entries(doctor_id, status, created_at);

    create table if not exists appointment_offers (
      id                serial primary key,
      slot_id           integer not null references slots(id),
      waitlist_entry_id integer not null references waitlist_entries(id),
      patient_id        integer not null references patients(id),
      status            varchar(20) not null default 'pending'
                        check (status in ('pending', 'accepted', 'declined', 'expired', 'superseded')),
      expires_at        timestamptz,
      notified_at       timestamptz,
      responded_at      timestamptz,
      created_at        timestamptz not null default now()
    );

    -- BR-06: tối đa 1 offer pending cho mỗi slot và cho mỗi bệnh nhân
    create unique index if not exists one_pending_offer_per_slot
      on appointment_offers(slot_id) where status = 'pending';
    create unique index if not exists one_pending_offer_per_patient
      on appointment_offers(patient_id) where status = 'pending';

    -- BR-02: phục vụ job quét offer hết hạn
    create index if not exists idx_offers_pending_expiry
      on appointment_offers(status, expires_at);

    -- BR-05: Notification là bảng MỚI, MedBook chưa có
    create table if not exists notifications (
      id                serial primary key,
      recipient_user_id integer not null references users(id),
      type              varchar(40) not null,
      title             varchar(200) not null,
      body              text,
      ref_offer_id      integer references appointment_offers(id),
      read_at           timestamptz,
      created_at        timestamptz not null default now()
    );
    create index if not exists idx_notifications_recipient
      on notifications(recipient_user_id, created_at desc);

  `);
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { migrate };
