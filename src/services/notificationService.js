const notificationRepository = require("../repositories/notificationRepository");
const userRepository = require("../repositories/userRepository");
const { httpError } = require("../errors");

// BR-05: thông báo in-app, ghi vào bảng notifications. Không gọi dịch vụ ngoài.
async function notifyOffer(offer) {
  const user = await userRepository.findByPatientId(offer.patient_id);
  if (!user) {
    throw httpError(500, "Không tìm thấy tài khoản bệnh nhân để gửi thông báo");
  }
  await notificationRepository.create(null, {
    recipientUserId: user.id,
    type: "offer_created",
    title: "Bạn nhận được lời mời nhận khung giờ khám",
    body: "Có một khung giờ khám vừa trống. Vui lòng phản hồi trong thời gian quy định để giữ lịch.",
    refOfferId: offer.id,
  });
}

async function notifyStaff(type, { title, body, refOfferId } = {}) {
  const staffIds = await userRepository.listStaffIds();
  for (const recipientUserId of staffIds) {
    await notificationRepository.create(null, { recipientUserId, type, title, body, refOfferId });
  }
}

async function listForUser(user, { unreadOnly } = {}) {
  return notificationRepository.listByUser(user.id, { unreadOnly });
}

async function markRead(user, id) {
  return notificationRepository.markRead(id, user.id);
}

module.exports = { notifyOffer, notifyStaff, listForUser, markRead };
