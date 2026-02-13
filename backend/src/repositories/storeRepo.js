const db = require("../db/index.js");

const StoreRepo = {
    create(store) {
        return db.prepare(`INSERT INTO stores (store_name, engine, namespace, status, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
                store.storeName,
                store.engine,
                store.namespace,
                store.status,
                store.url,
                store.createdAt
            );
    },


    resetAll() {
        const transaction = db.transaction(() => {
            db.prepare(`DELETE FROM stores`).run();
            db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'stores'`).run();
        });
        transaction();
        console.log("Database cleared and IDs reset to 1.");
    },


    updateStatus(storeName, status) {
        return db.prepare(`UPDATE stores SET status = ? WHERE store_name = ?`)
            .run(status, storeName);
    },

    findByName(storeName) {
        return db.prepare(`SELECT * FROM stores WHERE store_name = ?`).get(storeName);
    },

    findAll() {
        return db.prepare(`SELECT * FROM stores ORDER BY created_at DESC`)
            .all();
    },

    findById(id) {
        return db.prepare(`SELECT * FROM stores WHERE id = ?`)
            .get(id);
    },

    deleteById(id) {
        return db.prepare(`DELETE FROM stores WHERE id = ?`)
            .run(id);
    }
};

module.exports = StoreRepo;
