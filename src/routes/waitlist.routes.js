const express = require("express");
const waitlistService = require("../services/waitlistService");
const { demoAuth } = require("../middleware/demoAuth");
const { requireRole } = require("../middleware/requireRole");

const router = express.Router();

router.post("/waitlist", demoAuth, requireRole("patient"), async (req, res, next) => {
  try {
    const entry = await waitlistService.join({
      user: req.user,
      doctorId: req.body.doctorId,
      dateFrom: req.body.dateFrom,
      dateTo: req.body.dateTo,
    });
    res.status(201).json({ data: entry });
  } catch (error) {
    next(error);
  }
});

router.get("/my-waitlist", demoAuth, requireRole("patient"), async (req, res, next) => {
  try {
    res.json({ data: await waitlistService.listMine(req.user) });
  } catch (error) {
    next(error);
  }
});

router.get("/waitlist", demoAuth, requireRole("staff"), async (req, res, next) => {
  try {
    res.json({
      data: await waitlistService.listForStaff({
        doctorId: req.query.doctorId,
        status: req.query.status,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/waitlist/:id", demoAuth, requireRole("patient"), async (req, res, next) => {
  try {
    res.json({ data: await waitlistService.leave({ user: req.user, id: req.params.id }) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
