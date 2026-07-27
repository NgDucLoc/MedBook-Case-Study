const { query, pool } = require("../db/pool");

// Vị trí FIFO trong hàng đợi (chỉ tính entry active) — dùng chung.
const POSITION_SUBQUERY = `
  (
    select count(*)::int
    from waitlist_entries w2
    where w2.doctor_id = w.doctor_id
      and w2.status = 'active'
      and (w2.created_at < w.created_at
           or (w2.created_at = w.created_at and w2.id < w.id))
  ) + 1 as position
`;

// NFR-05: projection cho BỆNH NHÂN — KHÔNG chứa patientName/patientId của người khác.
function patientSelect(where) {
  return `
    select
      w.id,
      w.doctor_id as "doctorId",
      d.name as "doctorName",
      to_char(w.date_from, 'YYYY-MM-DD') as "dateFrom",
      to_char(w.date_to, 'YYYY-MM-DD') as "dateTo",
      w.status,
      ${POSITION_SUBQUERY}
    from waitlist_entries w
    join doctors d on d.id = w.doctor_id
    ${where}
  `;
}

// Projection cho STAFF — có patientName (staff được phép xem toàn bộ).
function staffSelect(where) {
  return `
    select
      w.id,
      w.patient_id as "patientId",
      p.name as "patientName",
      w.doctor_id as "doctorId",
      d.name as "doctorName",
      to_char(w.date_from, 'YYYY-MM-DD') as "dateFrom",
      to_char(w.date_to, 'YYYY-MM-DD') as "dateTo",
      w.status,
      to_char(w.created_at, 'YYYY-MM-DD HH24:MI') as "createdAt",
      ${POSITION_SUBQUERY}
    from waitlist_entries w
    join patients p on p.id = w.patient_id
    join doctors d on d.id = w.doctor_id
    ${where}
  `;
}

async function create({ patientId, doctorId, dateFrom, dateTo }) {
  const rows = await query(
    `insert into waitlist_entries (patient_id, doctor_id, date_from, date_to)
     values ($1, $2, $3, $4)
     returning id`,
    [patientId, doctorId, dateFrom, dateTo],
  );
  return detailById(rows[0].id);
}

async function detailById(id) {
  const rows = await query(patientSelect("where w.id = $1"), [id]);
  return rows[0] || null;
}

async function findById(id) {
  const rows = await query(
    `select id, patient_id, doctor_id, status from waitlist_entries where id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function listActiveByPatient(patientId) {
  return query(
    patientSelect("where w.patient_id = $1 and w.status = 'active'") +
      " order by w.doctor_id, w.created_at, w.id",
    [patientId],
  );
}

async function listForStaff({ doctorId, status } = {}) {
  const params = [];
  const filters = [];
  params.push(status || "active");
  filters.push(`w.status = $${params.length}`);
  if (doctorId) {
    params.push(doctorId);
    filters.push(`w.doctor_id = $${params.length}`);
  }
  const where = `where ${filters.join(" and ")}`;
  return query(staffSelect(where) + " order by w.doctor_id, w.created_at, w.id", params);
}

// BR-01: bệnh nhân đủ điều kiện cho slot -> lọc eligibility TRƯỚC, rồi FIFO.
async function findEligibleForSlot(client, slotId) {
  const runner = client || pool;
  const result = await runner.query(
    `
    select w.id, w.patient_id, w.doctor_id
    from waitlist_entries w
    join slots s on s.id = $1
    where w.doctor_id = s.doctor_id                              -- (a)
      and w.status = 'active'                                    -- (b)
      and s.date between w.date_from and w.date_to               -- (c)
      and not exists (                                           -- (d) không trùng khung giờ
        select 1 from appointments a
        join slots s2 on s2.id = a.slot_id
        where a.patient_id = w.patient_id
          and a.status in ('booked', 'confirmed')
          and s2.date = s.date
          and s2.start_time < s.end_time
          and s2.end_time > s.start_time
      )
      and not exists (                                           -- BR-06 loại người đang có offer pending (bất kỳ slot)
        select 1 from appointment_offers o
        where o.patient_id = w.patient_id and o.status = 'pending'
      )
      and not exists (                                           -- BR-08: mỗi bệnh nhân chỉ được chào 1 lần cho MỘT slot
        select 1 from appointment_offers o2                       -- (đã từ chối/hết hạn slot này thì không chào lại slot đó)
        where o2.patient_id = w.patient_id and o2.slot_id = $1
      )
    order by w.created_at asc, w.id asc
    `,
    [slotId],
  );
  return result.rows;
}

async function updateStatus(client, id, status) {
  const sql = `update waitlist_entries set status = $2, updated_at = now() where id = $1`;
  const runner = client || pool;
  await runner.query(sql, [id, status]);
}

module.exports = {
  create,
  detailById,
  findById,
  listActiveByPatient,
  listForStaff,
  findEligibleForSlot,
  updateStatus,
};
