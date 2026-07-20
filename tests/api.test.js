const test = require("node:test");
const assert = require("node:assert/strict");
const { app, migrateAndSeed, pool } = require("../server");

let server;
let baseUrl;

function headers(userId) {
  return {
    "Content-Type": "application/json",
    "X-Demo-User-Id": String(userId),
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

test.before(async () => {
  await migrateAndSeed({ reset: true });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await migrateAndSeed({ reset: true });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await pool.end();
});

test("health endpoint is ready", async () => {
  const { response, body } = await request("/health");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test("demo auth rejects requests without X-Demo-User-Id", async () => {
  const { response, body } = await request("/api/me");
  assert.equal(response.status, 401);
  assert.match(body.error, /Thiếu tài khoản demo/);
});

test("demo auth blocks patient from staff-only endpoint", async () => {
  const { response, body } = await request("/api/appointments", {
    headers: headers(1),
  });
  assert.equal(response.status, 403);
  assert.equal(body.error, "Không đủ quyền");
});

test("patient can book an available slot", async () => {
  const { response, body } = await request("/api/appointments", {
    method: "POST",
    headers: headers(1),
    body: JSON.stringify({ slotId: 1, type: "online" }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.data.slotId, 1);
  assert.equal(body.data.status, "booked");
  assert.equal(body.data.type, "online");
});

test("patient cannot book an already booked slot", async () => {
  const { response, body } = await request("/api/appointments", {
    method: "POST",
    headers: headers(1),
    body: JSON.stringify({ slotId: 2, type: "in_person" }),
  });
  assert.equal(response.status, 409);
  assert.equal(body.error, "Khung giờ đã được đặt");
});

test("cancel appointment returns its slot to available", async () => {
  const cancel = await request("/api/appointments/1/cancel", {
    method: "POST",
    headers: headers(1),
    body: "{}",
  });
  assert.equal(cancel.response.status, 200);
  assert.equal(cancel.body.data.status, "cancelled");

  const slots = await request(`/api/doctors/1/slots?date=${cancel.body.data.date}`, {
    headers: headers(1),
  });
  assert.equal(slots.response.status, 200);
  assert.ok(slots.body.data.some((slot) => slot.id === 2 && slot.status === "available"));
});

test("staff confirms booked appointment", async () => {
  const { response, body } = await request("/api/appointments/1/confirm", {
    method: "POST",
    headers: headers(2),
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.id, 1);
  assert.equal(body.data.status, "confirmed");
});

test("staff can create a new available slot", async () => {
  const { response, body } = await request("/api/slots", {
    method: "POST",
    headers: headers(2),
    body: JSON.stringify({
      doctorId: 2,
      date: "2099-01-20",
      startTime: "11:00",
      endTime: "11:30",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.data.doctorId, 2);
  assert.equal(body.data.date, "2099-01-20");
  assert.equal(body.data.startTime, "11:00");
  assert.equal(body.data.endTime, "11:30");
  assert.equal(body.data.status, "available");
});

test("demo login requires a correct password", async () => {
  const { response, body } = await request("/api/demo-login", {
    method: "POST",
    body: JSON.stringify({ email: "an@medbook.local", password: "sai-mat-khau" }),
  });
  assert.equal(response.status, 401);
  assert.equal(body.error, "Sai email hoặc mật khẩu demo");
});

test("demo login cannot be bypassed with userId alone", async () => {
  const { response } = await request("/api/demo-login", {
    method: "POST",
    body: JSON.stringify({ userId: 2 }),
  });
  assert.equal(response.status, 400);
});

test("staff cannot reopen a slot that still has an active appointment", async () => {
  // Slot 2 đang giữ appointment 1 ở trạng thái booked theo seed.
  const { response, body } = await request("/api/slots/2", {
    method: "PUT",
    headers: headers(2),
    body: JSON.stringify({ status: "available" }),
  });
  assert.equal(response.status, 409);
  assert.equal(body.error, "Không thể mở lại khung giờ đang có lịch hẹn");
});

test("staff can reopen a slot once its appointment is cancelled", async () => {
  await request("/api/appointments/1/cancel", {
    method: "POST",
    headers: headers(2),
    body: "{}",
  });
  const { response, body } = await request("/api/slots/2", {
    method: "PUT",
    headers: headers(2),
    body: JSON.stringify({ status: "available" }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.status, "available");
});

test("concurrent booking of the same slot produces exactly one success", async () => {
  const book = () =>
    request("/api/appointments", {
      method: "POST",
      headers: headers(1),
      body: JSON.stringify({ slotId: 1, type: "in_person" }),
    });

  const results = await Promise.all([book(), book()]);
  const statuses = results.map((item) => item.response.status).sort();
  assert.deepEqual(statuses, [201, 409]);
});

test("staff can update slot status", async () => {
  const { response, body } = await request("/api/slots/3", {
    method: "PUT",
    headers: headers(2),
    body: JSON.stringify({ status: "booked" }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.id, 3);
  assert.equal(body.data.status, "booked");
});
