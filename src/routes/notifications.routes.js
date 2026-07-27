const express = require("express");
const notificationService = require("../services/notificationService");
const { demoAuth } = require("../middleware/demoAuth");

const router = express.Router();

router.get("/notifications", demoAuth, async (req, res, next) => {
  try {
    const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === "1";
    res.json({ data: await notificationService.listForUser(req.user, { unreadOnly }) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
