const waitlistRepository = require("../repositories/waitlistRepository");
const doctorRepository = require("../repositories/doctorRepository");
const offerService = require("./offerService");
const { toInt, required } = require("../utils/validate");
const { httpError } = require("../errors");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  // Kiểm bằng UTC để không lệ thuộc timezone máy chủ (VD +07 làm lệch ngày).
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// AC-13: dữ liệu không hợp lệ -> 400 (đồng bộ với validate.js của MedBook).
// Không tự ép "dateFrom >= hôm nay": spec không yêu cầu, và "hôm nay" theo timezone
// máy chủ có thể lệch với ngày của slot (slot seed bằng current_date của DB).
function validateDateRange(dateFrom, dateTo) {
  if (!isValidDate(dateFrom) || !isValidDate(dateTo)) {
    throw httpError(400, "Ngày không hợp lệ (định dạng YYYY-MM-DD)");
  }
  if (dateFrom > dateTo) {
    throw httpError(400, "Khoảng ngày không hợp lệ: dateFrom phải nhỏ hơn hoặc bằng dateTo");
  }
}

// US-01 (AC-11→13): bệnh nhân đăng ký vào danh sách chờ của một bác sĩ.
async function join({ user, doctorId, dateFrom, dateTo }) {
  const docId = toInt(required(doctorId, "doctorId"));
  const from = required(dateFrom, "dateFrom");
  const to = required(dateTo, "dateTo");
  validateDateRange(from, to);

  const doctor = await doctorRepository.findById(docId);
  if (!doctor) throw httpError(404, "Không tìm thấy bác sĩ");

  try {
    return await waitlistRepository.create({
      patientId: user.patientId,
      doctorId: docId,
      dateFrom: from,
      dateTo: to,
    });
  } catch (error) {
    // AC-12: cưỡng chế bởi index one_active_waitlist_per_patient_doctor.
    if (error.code === "23505") {
      throw httpError(409, "Bạn đã ở trong danh sách chờ của bác sĩ này");
    }
    throw error;
  }
}

// US-01 (AC-14, AC-15): bệnh nhân rời khỏi danh sách chờ của chính mình.
async function leave({ user, id }) {
  const entryId = toInt(id);
  const entry = await waitlistRepository.findById(entryId);
  if (!entry) throw httpError(404, "Không tìm thấy mục danh sách chờ");
  if (entry.patient_id !== user.patientId) throw httpError(403, "Không đủ quyền");
  if (entry.status !== "active") {
    throw httpError(409, "Mục danh sách chờ không còn ở trạng thái hoạt động");
  }

  await waitlistRepository.updateStatus(null, entryId, "cancelled");
  // BR-08: nếu đang có offer pending gắn entry này -> superseded và chào bệnh nhân kế tiếp.
  await offerService.supersedeByWaitlistEntry(entryId);
  return { id: entryId, status: "cancelled" };
}

// US-07 (AC-16): bệnh nhân xem hàng đợi của chính mình kèm vị trí (position).
async function listMine(user) {
  return waitlistRepository.listActiveByPatient(user.patientId);
}

// US-05 (đọc): staff xem danh sách chờ.
async function listForStaff({ doctorId, status } = {}) {
  return waitlistRepository.listForStaff({ doctorId: toInt(doctorId), status });
}

module.exports = { join, leave, listMine, listForStaff };
