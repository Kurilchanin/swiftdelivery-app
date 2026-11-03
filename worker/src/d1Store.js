// Delete every invite whose validUntil has passed (run hourly by the Worker).
export async function deleteExpired(db, now) {
  await db.prepare('DELETE FROM invites WHERE valid_until < ?1').bind(now).run()
}

// The invite store on D1 (schema: migrations/0001_invites.sql), in the shape
// src/server/inviteHandler.js expects: { get(key), put(key, row, now, minGap) }.
export function d1Store(db) {
  return {
    async get(key) {
      const r = await db
        .prepare('SELECT courier, valid_until, signature FROM invites WHERE order_addr = ?1')
        .bind(key)
        .first()
      return r ? { courier: r.courier, validUntil: r.valid_until, signature: r.signature } : null
    },
    // One row per order. The update runs only when the old row is at least
    // `minGap` seconds old, so a client cannot hammer the store.
    async put(key, row, now, minGap) {
      const res = await db
        .prepare(
          `INSERT INTO invites (order_addr, courier, valid_until, signature, written_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(order_addr) DO UPDATE SET
             courier = excluded.courier, valid_until = excluded.valid_until,
             signature = excluded.signature, written_at = excluded.written_at
           WHERE invites.written_at <= ?6`,
        )
        .bind(key, row.courier, row.validUntil, row.signature, now, now - minGap)
        .run()
      return res.meta.changes > 0
    },
  }
}
