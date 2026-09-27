// Test-only: wraps node:sqlite in the subset of the D1 API the Worker uses
// (prepare().bind().first()/all()/run() and batch()). Every call first waits
// one turn of the event loop, like the network round trip to D1, so requests
// sent at once interleave between queries as they do in production. batch()
// runs its statements in one transaction: all of them or none. Rows are
// copied into plain objects because node:sqlite returns null-prototype rows.
// node:sqlite does not bind numbered parameters (?1, ?2) by position as D1
// does, so each ?N becomes a plain ? and the values are reordered to match.
const roundTrip = () => new Promise((resolve) => setImmediate(resolve));

export function createD1(db) {
  return {
    prepare(sql) {
      const order = [];
      const stmt = db.prepare(sql.replace(/\?(\d+)/g, (_, n) => {
        order.push(Number(n) - 1);
        return "?";
      }));
      const bound = (bindings) => {
        const params = order.length ? order.map((i) => bindings[i]) : bindings;
        const rows = () => stmt.all(...params).map((row) => ({ ...row }));
        return {
          bind: (...args) => bound(args),
          rows,
          async first() {
            await roundTrip();
            const row = stmt.get(...params);
            return row ? { ...row } : null;
          },
          async all() {
            await roundTrip();
            return { results: rows(), success: true };
          },
          async run() {
            await roundTrip();
            const info = stmt.run(...params);
            return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
          },
        };
      };
      return bound([]);
    },
    async batch(statements) {
      await roundTrip();
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({ results: statement.rows(), success: true }));
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
