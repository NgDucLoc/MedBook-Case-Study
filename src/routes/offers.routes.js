const express = require("express");
const offerService = require("../services/offerService");
const { demoAuth } = require("../middleware/demoAuth");
const { requireRole } = require("../middleware/requireRole");

const router = express.Router();

router.get("/my-offers", demoAuth, requireRole("patient"), async (req, res, next) => {
  try {
    res.json({ data: await offerService.listMyOffers(req.user) });
  } catch (error) {
    next(error);
  }
});

router.post("/offers/:id/accept", demoAuth, requireRole("patient"), async (req, res, next) => {
  try {
    const appointment = await offerService.accept(req.params.id, req.user);
    res.status(201).json({ data: { appointment } });
  } catch (error) {
    next(error);
  }
});

router.post("/offers/:id/decline", demoAuth, requireRole("patient"), async (req, res, next) => {
  try {
    res.json({ data: await offerService.decline(req.params.id, req.user) });
  } catch (error) {
    next(error);
  }
});

router.get("/offers", demoAuth, requireRole("staff"), async (req, res, next) => {
  try {
    res.json({
      data: await offerService.listForStaff({
        status: req.query.status,
        doctorId: req.query.doctorId,
      }),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
