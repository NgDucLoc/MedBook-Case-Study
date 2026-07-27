const { query, pool } = require("../db/pool");

async function create(client, { recipientUserId, type, title, body, refOfferId }) {
  const runner = client || pool;
  const result = await runner.query(
    `insert into notifications (recipient_user_id, type, title, body, ref_offer_id)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [recipientUserId, type, title, body || null, refOfferId || null],
  );
  return result.rows[0];
}

async function listByUser(userId, { unreadOnly } = {}) {
  const filters = ["recipient_user_id = $1"];
  if (unreadOnly) filters.push("read_at is null");
  return query(
    `select id, type, title, body,
       to_char(read_at, 'YYYY-MM-DD HH24:MI') as "readAt",
       to_char(created_at, 'YYYY-MM-DD HH24:MI') as "createdAt"
     from notifications
     where ${filters.join(" and ")}
     order by created_at desc`,
    [userId],
  );
}

async function markRead(id, userId) {
  const rows = await query(
    `update notifications set read_at = now()
     where id = $1 and recipient_user_id = $2 and read_at is null
     returning id`,
    [id, userId],
  );
  return rows[0] || null;
}

module.exports = { create, listByUser, markRead };
