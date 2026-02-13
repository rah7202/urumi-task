const db = require("./index.js");

function runMigrations() {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_name TEXT UNIQUE NOT NULL,
        engine TEXT NOT NULL,
        namespace TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        created_at TEXT NOT NULL
        )
    `).run();
}

module.exports = { runMigrations };
