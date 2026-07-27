const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OFFER_JOB_DISABLED = "1"; // không cho job tự chạy trong test
const { app, migrateAndSeed, pool } = require("../server");
const offerExpiryJob = require("../src/jobs/offerExpiryJob");

let server;
let baseUrl;

// Bản đồ seed: user 1->patient1, 3->patient2, 4->patient3, 5->patient4, 6->patient5; staff: 2,7,8.
const USER = { p1: 1, p2: 3, p3: 4, p4: 5, staff: 2 };

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Khoảng đăng ký chờ lấy theo current_date của DB để phủ đúng ngày slot đã seed
// (tránh lệch timezone giữa máy chủ Node và DB). Gán trong test.before.
let DFROM;
let DTO;

async function request(path, { userId, ...options } = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (userId) headers["X-Demo-User-Id"] = String(userId);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const join = (userId, doctorId, dateFrom = DFROM, dateTo = DTO) =>
  request("/api/waitlist", { userId, method: "POST", body: JSON.stringify({ doctorId, dateFrom, dateTo }) });

const cancelAppt = (userId, id) =>
  request(`/api/appointments/${id}/cancel`, { userId, method: "POST" });

async function pendingOfferForSlot(slotId) {
  const { rows } = await pool.query(
    "select * from appointment_offers where slot_id = $1 and status = 'pending'",
    [slotId],
  );
  return rows[0] || null;
}

test.before(async () => {
  await migrateAndSeed({ reset: true });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { rows } = await pool.query(
    "select to_char(current_date,'YYYY-MM-DD') d0, to_char(current_date + 7,'YYYY-MM-DD') d7",
  );
  DFROM = rows[0].d0;
  DTO = rows[0].d7;
});

test.beforeEach(async () => {
  await migrateAndSeed({ reset: true });
});

test.after(async () => {
  offerExpiryJob.stop();
  if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await pool.end();
});

// ---------- US-01: đăng ký danh sách chờ ----------

test("AC-11: bệnh nhân đăng ký waitlist thành công, trả position FIFO", async () => {
  const { response, body } = await join(USER.p2, 1);
  assert.equal(response.status, 201);
  assert.equal(body.data.status, "active");
  assert.equal(body.data.position, 1);
  assert.equal(body.data.doctorId, 1);
  assert.ok(body.data.doctorName);
});

test("AC-11: position tăng dần theo thứ tự vào hàng đợi", async () => {
  await join(USER.p2, 1);
  const { body } = await join(USER.p3, 1);
  assert.equal(body.data.position, 2);
});

test("AC-12: đăng ký trùng bác sĩ khi đang active -> 409", async () => {
  await join(USER.p2, 1);
  const { response, body } = await join(USER.p2, 1);
  assert.equal(response.status, 409);
  assert.match(body.error, /danh sách chờ/);
});

test("AC-13: dateFrom > dateTo -> 400", async () => {
  const { response } = await join(USER.p2, 1, today(), "2000-01-01");
  assert.equal(response.status, 400);
});

test("AC-13: doctorId không tồn tại -> 404", async () => {
  const { response } = await join(USER.p2, 9999);
  assert.equal(response.status, 404);
});

test("AC-14: bệnh nhân rời hàng đợi của mình -> 200 cancelled", async () => {
  const { body } = await join(USER.p2, 1);
  const { response, body: del } = await request(`/api/waitlist/${body.data.id}`, {
    userId: USER.p2,
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.equal(del.data.status, "cancelled");
});

test("AC-15: xoá entry của người khác -> 403", async () => {
  const { body } = await join(USER.p2, 1);
  const { response } = await request(`/api/waitlist/${body.data.id}`, {
    userId: USER.p3,
    method: "DELETE",
  });
  assert.equal(response.status, 403);
});

test("AC-15: staff gọi endpoint chỉ dành cho patient -> 403", async () => {
  const { response } = await request("/api/waitlist/1", { userId: USER.staff, method: "DELETE" });
  assert.equal(response.status, 403);
});

test("AC-16: my-waitlist chỉ trả entry của mình kèm position, không lộ bệnh nhân khác", async () => {
  await join(USER.p2, 1);
  await join(USER.p3, 1);
  const { body } = await request("/api/my-waitlist", { userId: USER.p3 });
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].position, 2);
  assert.equal(body.data[0].patientName, undefined);
});

// ---------- US-03: tự động chào offer khi slot trống ----------

test("AC-01: huỷ lịch -> tạo offer cho bệnh nhân đủ điều kiện, slot vẫn 'available' (BR-03)", async () => {
  await join(USER.p3, 1); // patient3 chờ bác sĩ 1 (slot 2 thuộc bác sĩ 1)
  const { response } = await cancelAppt(USER.staff, 1); // huỷ appointment 1 -> slot 2 trống
  assert.equal(response.status, 200);

  const offer = await pendingOfferForSlot(2);
  assert.ok(offer, "phải có offer pending cho slot 2");
  assert.equal(offer.patient_id, 3);

  const { rows } = await pool.query("select status from slots where id = 2");
  assert.equal(rows[0].status, "available"); // BR-03: KHÔNG hold slot
});

test("AC-25: my-offers trả offer kèm secondsRemaining và thông tin slot", async () => {
  await join(USER.p3, 1);
  await cancelAppt(USER.staff, 1);
  const { body } = await request("/api/my-offers", { userId: USER.p3 });
  assert.equal(body.data.length, 1);
  assert.ok(body.data[0].secondsRemaining > 0);
  assert.equal(body.data[0].slot.id, 2);
});

// ---------- US-02: chấp nhận / từ chối ----------

test("AC-21: chấp nhận offer -> tạo appointment booked, slot booked, entry fulfilled", async () => {
  await join(USER.p3, 1);
  await cancelAppt(USER.staff, 1);
  const offer = await pendingOfferForSlot(2);

  const { response, body } = await request(`/api/offers/${offer.id}/accept`, {
    userId: USER.p3,
    method: "POST",
  });
  assert.equal(response.status, 201);
  assert.equal(body.data.appointment.status, "booked");
  assert.equal(body.data.appointment.slotId, 2);

  const slot = await pool.query("select status from slots where id = 2");
  assert.equal(slot.rows[0].status, "booked");
  const entry = await pool.query("select status from waitlist_entries where patient_id = 3 and doctor_id = 1");
  assert.equal(entry.rows[0].status, "fulfilled");
});

test("AC-23: chấp nhận offer đã hết hạn -> 409, không tạo appointment", async () => {
  await join(USER.p3, 1);
  await cancelAppt(USER.staff, 1);
  const offer = await pendingOfferForSlot(2);
  await pool.query("update appointment_offers set expires_at = now() - interval '1 minute' where id = $1", [offer.id]);

  const { response } = await request(`/api/offers/${offer.id}/accept`, { userId: USER.p3, method: "POST" });
  assert.equal(response.status, 409);
  const appt = await pool.query("select count(*)::int c from appointments where slot_id = 2 and status = 'booked'");
  assert.equal(appt.rows[0].c, 0);
});

test("AC-24: chấp nhận offer của người khác -> 403", async () => {
  await join(USER.p3, 1);
  await cancelAppt(USER.staff, 1);
  const offer = await pendingOfferForSlot(2);
  const { response } = await request(`/api/offers/${offer.id}/accept`, { userId: USER.p2, method: "POST" });
  assert.equal(response.status, 403);
});

test("AC-22: từ chối offer -> entry giữ 'active', chào bệnh nhân kế tiếp", async () => {
  await join(USER.p3, 1); // vị trí 1
  await join(USER.p4, 1); // vị trí 2
  await cancelAppt(USER.staff, 1);
  const offer = await pendingOfferForSlot(2); // của patient3

  const { response } = await request(`/api/offers/${offer.id}/decline`, { userId: USER.p3, method: "POST" });
  assert.equal(response.status, 200);

  const entry = await pool.query("select status from waitlist_entries where patient_id = 3 and doctor_id = 1");
  assert.equal(entry.rows[0].status, "active"); // BR-08

  const next = await pendingOfferForSlot(2);
  assert.ok(next);
  assert.equal(next.patient_id, 4); // chào patient4
});

// ---------- US-04: timeout & chuyển tiếp ----------

test("AC-41: job cho offer hết hạn -> chuyển sang bệnh nhân kế tiếp", async () => {
  await join(USER.p3, 1);
  await join(USER.p4, 1);
  await cancelAppt(USER.staff, 1);
  const first = await pendingOfferForSlot(2);
  await pool.query("update appointment_offers set expires_at = now() - interval '1 minute' where id = $1", [first.id]);

  const processed = await offerExpiryJob.runOnce();
  assert.ok(processed >= 1);

  const expired = await pool.query("select status from appointment_offers where id = $1", [first.id]);
  assert.equal(expired.rows[0].status, "expired");
  const next = await pendingOfferForSlot(2);
  assert.equal(next.patient_id, 4);
});

test("AC-42: hết danh sách -> offer expired, không tạo offer mới, báo staff", async () => {
  await join(USER.p3, 1);
  await cancelAppt(USER.staff, 1);
  const offer = await pendingOfferForSlot(2);
  await pool.query("update appointment_offers set expires_at = now() - interval '1 minute' where id = $1", [offer.id]);

  await offerExpiryJob.runOnce();

  const stillPending = await pendingOfferForSlot(2);
  assert.equal(stillPending, null);
  const staffNotif = await pool.query(
    "select count(*)::int c from notifications where recipient_user_id = 2 and type = 'slot_unfilled'",
  );
  assert.ok(staffNotif.rows[0].c >= 1);
});

test("AC-43: job chạy 2 lần chồng nhau -> chỉ tạo đúng 1 offer kế tiếp (idempotent)", async () => {
  await join(USER.p3, 1);
  await join(USER.p4, 1);
  await cancelAppt(USER.staff, 1);
  const first = await pendingOfferForSlot(2);
  await pool.query("update appointment_offers set expires_at = now() - interval '1 minute' where id = $1", [first.id]);

  await Promise.all([offerExpiryJob.runOnce(), offerExpiryJob.runOnce()]);

  const offersForP4 = await pool.query(
    "select count(*)::int c from appointment_offers where slot_id = 2 and patient_id = 4",
  );
  assert.equal(offersForP4.rows[0].c, 1);
});
