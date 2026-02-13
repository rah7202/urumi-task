const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(process.cwd(), "stores.db");

const db = new Database(dbPath, {
    verbose: console.log, // optional, helps in demo/debug
});

module.exports = db;
