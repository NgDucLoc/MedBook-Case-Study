const { query, pool } = require("../db/pool");

async function create(client, { slotId, waitlistEntryId, patientId }) {
  const runner = client || pool;
  const result = await runner.query(
    `insert into appointment_offers (slot_id, waitlist_entry_id, patient_id, status)
     values ($1, $2, $3, 'pending')
     returning *`,
    [slotId, waitlistEntryId, patientId],
  );
  return result.rows[0];
}

async function findById(id) {
  const rows = await query("select * from appointment_offers where id = $1", [id]);
  return rows[0] || null;
}

async function findByIdForUpdate(client, id) {
  const result = await client.query(
    "select * from appointment_offers where id = $1 for update",
    [id],
  );
  return result.rows[0] || null;
}

async function findPendingByWaitlistEntry(waitlistEntryId) {
  const rows = await query(
    "select * from appointment_offers where waitlist_entry_id = $1 and status = 'pending'",
    [waitlistEntryId],
  );
  return rows[0] || null;
}

// BR-05: chỉ đặt notified_at + expires_at SAU khi thông báo thành công.
async function markNotified(id, timeoutMinutes) {
  const rows = await query(
    `update appointment_offers
       set notified_at = now(),
           expires_at = now() + make_interval(mins => $2)
     where id = $1 and status = 'pending'
     returning *`,
    [id, timeoutMinutes],
  );
  return rows[0] || null;
}

// NFR-04 / BR-03 L1: cập nhật trạng thái nguyên tử, chỉ khi đang 'pending'.
async function updateStatusIfPending(client, id, status) {
  const responded = status === "accepted" || status === "declined" ? ", responded_at = now()" : "";
  const runner = client || pool;
  const result = await runner.query(
    `update appointment_offers set status = $2${responded}
     where id = $1 and status = 'pending'
     returning *`,
    [id, status],
  );
  return result.rows[0] || null;
}

// BR-02: offer pending đã quá hạn (đã notify).
async function findExpired() {
  return query(
    `select * from appointment_offers
     where status = 'pending' and expires_at is not null and expires_at <= now()
     order by expires_at asc`,
  );
}

function offerDetailSelect(where) {
  return `
    select
      o.id,
      o.patient_id as "patientId",
      p.name as "patientName",
      o.status,
      to_char(o.expires_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "expiresAt",
      greatest(0, floor(extract(epoch from (o.expires_at - now()))))::int as "secondsRemaining",
      to_char(o.created_at, 'YYYY-MM-DD HH24:MI') as "createdAt",
      json_build_object(
        'id', s.id,
        'doctorName', d.name,
        'date', to_char(s.date, 'YYYY-MM-DD'),
        'startTime', to_char(s.start_time, 'HH24:MI'),
        'endTime', to_char(s.end_time, 'HH24:MI')
      ) as slot
    from appointment_offers o
    join patients p on p.id = o.patient_id
    join slots s on s.id = o.slot_id
    join doctors d on d.id = s.doctor_id
    ${where}
  `;
}

async function listPendingByPatientDetailed(patientId) {
  return query(
    offerDetailSelect("where o.patient_id = $1 and o.status = 'pending'") +
      " order by o.created_at desc",
    [patientId],
  );
}

async function listForStaffDetailed({ status, doctorId } = {}) {
  const params = [];
  const filters = [];
  if (status) {
    params.push(status);
    filters.push(`o.status = $${params.length}`);
  }
  if (doctorId) {
    params.push(doctorId);
    filters.push(`s.doctor_id = $${params.length}`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  return query(offerDetailSelect(where) + " order by o.created_at desc", params);
}

module.exports = {
  create,
  findById,
  findByIdForUpdate,
  findPendingByWaitlistEntry,
  markNotified,
  updateStatusIfPending,
  findExpired,
  listPendingByPatientDetailed,
  listForStaffDetailed,
};
