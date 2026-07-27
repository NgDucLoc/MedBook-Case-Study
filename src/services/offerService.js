const { getClient } = require("../db/pool");
const offerRepository = require("../repositories/offerRepository");
const waitlistRepository = require("../repositories/waitlistRepository");
const slotRepository = require("../repositories/slotRepository");
const appointmentRepository = require("../repositories/appointmentRepository");
const notificationService = require("./notificationService");
const { httpError } = require("../errors");
const { toInt } = require("../utils/validate");

// BR-02: giá trị cấu hình được, mặc định 15 phút.
const OFFER_TIMEOUT_MINUTES = Number(process.env.OFFER_TIMEOUT_MINUTES || 15);

// US-03: khi slot trống, chọn bệnh nhân đủ điều kiện (BR-01) và tạo offer.
// Gọi SAU khi transaction gốc đã commit (BR-04). Trả về offer đã tạo hoặc null.
async function onSlotAvailable(slotId) {
  const id = toInt(slotId);
  let offer = null;

  const client = await getClient();
  try {
    await client.query("begin");
    const slot = await slotRepository.findForUpdate(client, id);
    if (!slot || slot.status !== "available") {
      await client.query("commit");
      return null;
    }
    const eligible = await waitlistRepository.findEligibleForSlot(client, id);
    if (eligible.length === 0) {
      await client.query("commit");
      return null;
    }
    const chosen = eligible[0];
    offer = await offerRepository.create(client, {
      slotId: id,
      waitlistEntryId: chosen.id,
      patientId: chosen.patient_id,
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    // BR-06: đã tồn tại offer pending cho slot/bệnh nhân này -> bỏ qua, không nhân đôi.
    if (error.code === "23505") return null;
    throw error;
  } finally {
    client.release();
  }

  // BR-05: chỉ bắt đầu đếm timeout SAU khi thông báo thành công.
  try {
    await notificationService.notifyOffer(offer);
    const notified = await offerRepository.markNotified(offer.id, OFFER_TIMEOUT_MINUTES);
    console.log(`[offer] ${offer.id} pending → notified slot=${id} patient=${offer.patient_id}`);
    return notified || offer;
  } catch (notifyError) {
    console.error(`[offer] ${offer.id} notify failed reason=${notifyError.message}`);
    await offerRepository.updateStatusIfPending(null, offer.id, "superseded");
    await notificationService.notifyStaff("offer_notify_failed", {
      title: "Không gửi được lời mời tự động",
      body: `Offer ${offer.id} cho slot ${id} không gửi được thông báo, cần xử lý thủ công.`,
      refOfferId: offer.id,
    });
    return null;
  }
}

// US-02 (AC-21): bệnh nhân chấp nhận offer. Chống double-booking bằng 3 lớp (BR-03).
async function accept(offerId, user) {
  const id = toInt(offerId);

  const client = await getClient();
  try {
    await client.query("begin");
    const offer = await offerRepository.findByIdForUpdate(client, id); // L1 khoá offer
    if (!offer) throw httpError(404, "Không tìm thấy lời mời");
    if (offer.patient_id !== user.patientId) throw httpError(403, "Không đủ quyền");
    if (offer.status !== "pending" || (offer.expires_at && new Date(offer.expires_at) <= new Date())) {
      throw httpError(409, "Lời mời đã hết hạn");
    }

    const flipped = await offerRepository.updateStatusIfPending(client, id, "accepted");
    if (!flipped) throw httpError(409, "Lời mời đã hết hạn");

    const slot = await slotRepository.findForUpdate(client, offer.slot_id); // L2 khoá slot
    if (!slot || slot.status !== "available") throw httpError(409, "Khung giờ đã được đặt");

    await slotRepository.updateStatus(client, offer.slot_id, "booked");
    const created = await appointmentRepository.create(client, {
      patientId: offer.patient_id,
      slotId: offer.slot_id,
      type: "in_person",
    }); // L3: partial unique index one_active_appointment_per_slot là chốt cuối
    await waitlistRepository.updateStatus(client, offer.waitlist_entry_id, "fulfilled");

    await client.query("commit");
    console.log(`[offer] ${id} pending → accepted slot=${offer.slot_id} patient=${offer.patient_id}`);
    return {
      id: created.id,
      slotId: offer.slot_id,
      patientId: offer.patient_id,
      status: "booked",
      type: "in_person",
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// US-02 (AC-22): bệnh nhân từ chối offer. Entry giữ 'active' (BR-08), chào bệnh nhân kế tiếp.
async function decline(offerId, user) {
  const id = toInt(offerId);
  const offer = await offerRepository.findById(id);
  if (!offer) throw httpError(404, "Không tìm thấy lời mời");
  if (offer.patient_id !== user.patientId) throw httpError(403, "Không đủ quyền");

  const flipped = await offerRepository.updateStatusIfPending(null, id, "declined");
  if (!flipped) throw httpError(409, "Lời mời không còn hiệu lực");

  console.log(`[offer] ${id} pending → declined`);
  await onSlotAvailable(offer.slot_id);
  return { id, status: "declined" };
}

// US-04 (AC-41→44): job gọi khi offer hết hạn. Idempotent nhờ updateStatusIfPending.
async function expireOffer(offerId) {
  const id = toInt(offerId);
  const offer = await offerRepository.findById(id);
  if (!offer) return null;

  const flipped = await offerRepository.updateStatusIfPending(null, id, "expired");
  if (!flipped) return null; // đã có thao tác khác xử lý offer này -> dừng (idempotent)

  console.log(`[offer] ${id} pending → expired reason=timeout`);
  const next = await onSlotAvailable(offer.slot_id);
  if (!next) {
    // AC-42: hết danh sách đủ điều kiện -> báo staff.
    await notificationService.notifyStaff("slot_unfilled", {
      title: "Khung giờ trống chưa lấp được",
      body: `Slot ${offer.slot_id}: lời mời hết hạn và không còn bệnh nhân phù hợp trong danh sách chờ.`,
      refOfferId: id,
    });
  }
  return flipped;
}

// AC-14 / BR-08: bệnh nhân rời hàng đợi khi đang có offer pending -> superseded, chào người kế.
async function supersedeByWaitlistEntry(waitlistEntryId) {
  const offer = await offerRepository.findPendingByWaitlistEntry(waitlistEntryId);
  if (!offer) return;
  const flipped = await offerRepository.updateStatusIfPending(null, offer.id, "superseded");
  if (!flipped) return;
  console.log(`[offer] ${offer.id} pending → superseded reason=waitlist_removed`);
  await onSlotAvailable(offer.slot_id);
}

async function listMyOffers(user) {
  return offerRepository.listPendingByPatientDetailed(user.patientId);
}

async function listForStaff({ status, doctorId } = {}) {
  return offerRepository.listForStaffDetailed({ status, doctorId });
}

module.exports = {
  OFFER_TIMEOUT_MINUTES,
  onSlotAvailable,
  accept,
  decline,
  expireOffer,
  supersedeByWaitlistEntry,
  listMyOffers,
  listForStaff,
};
