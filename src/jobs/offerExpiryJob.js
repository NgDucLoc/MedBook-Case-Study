const offerRepository = require("../repositories/offerRepository");
const offerService = require("../services/offerService");

const DEFAULT_INTERVAL_MS = Number(process.env.OFFER_JOB_INTERVAL_MS || 60000);

let timer = null;

// BR-02 / US-04: quét offer pending đã quá expires_at rồi cho hết hạn + chào bệnh nhân kế.
// Idempotent nhờ offerService.expireOffer (updateStatusIfPending).
async function runOnce() {
  const expired = await offerRepository.findExpired();
  for (const offer of expired) {
    try {
      await offerService.expireOffer(offer.id);
    } catch (error) {
      console.error(`[offerExpiryJob] offer ${offer.id} failed: ${error.message}`);
    }
  }
  return expired.length;
}

function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return timer;
  timer = setInterval(() => {
    runOnce().catch((error) => console.error("[offerExpiryJob]", error));
  }, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[offerExpiryJob] started interval=${intervalMs}ms`);
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { runOnce, start, stop };
