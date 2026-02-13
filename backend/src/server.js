const express = require('express');
const { exec } = require('child_process');
const { runMigrations } = require("./db/migrations");
const StoreRepo = require("./repositories/storeRepo");
const db = require("./db/index");
const rateLimit = require('express-rate-limit');

const { promisify } = require('util');
const execPromise = promisify(exec);

runMigrations();


db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    store_name TEXT,
    namespace TEXT,
    engine TEXT,
    status TEXT,
    message TEXT,
    ip TEXT,
    timestamp TEXT NOT NULL
  )
`);

function auditLog({ action, storeName, namespace, engine, status, message, ip }) {
    db.prepare(`INSERT INTO audit_logs (action, store_name, namespace, engine, status, message, ip, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
        .run(action, storeName || null, namespace || null, engine || null, status || null, message || null, ip || null, new Date().toISOString());
}

const k8s = require('@kubernetes/client-node');
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());
app.use(cors());

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many request at a time! Please try again later.' } // limit each IP to 100 requests per windowMs
});

const createStoreLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Store creation limit reached. Max 10 stores per hour' }
});

const deleteStoreLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Store deletion limit reached. Max 10 stores per hour' }
});

app.use(globalLimiter);





const homeDir = os.homedir();
const kubeConfigPath = path.join(homeDir, '.kube', 'config');
console.log(`Loading KubeConfig from: ${kubeConfigPath}`);


// Initialize Kubernetes Client
const kc = new k8s.KubeConfig();
kc.loadFromFile(kubeConfigPath);

const cluster = kc.clusters.find(c => c.name === 'docker-desktop');
const user = kc.users.find(u => u.name === 'docker-desktop');

if (cluster && user) {
    kc.loadFromClusterAndUser(cluster, user);
    console.log("Forced K8s to use Docker Desktop cluseter and user objects.");
} else {
    kc.setCurrentContext('docker-desktop');
}


const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

// Add this to your server.js startup
console.log("Node.js is querying K8s at:", kc.getCurrentCluster().server);

app.get('/api/stores', (req, res) => {
    try {
        const stores = StoreRepo.findAll(); // Fetches instantly from SQLite
        res.json(stores);
    } catch (err) {
        console.error("DB Fetch Error:", err);
        res.status(500).json({ error: "Failed to load stores" });
    }
});

// app.post('/api/stores', async (req, res) => {
//     const { storeName, engine } = req.body;
//     const namespace = `store-${storeName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
//     const url = `http://${storeName}.local`;
//     const createdAt = new Date().toISOString();

//     console.log(`[CREATE] Starting provisioning for store: ${storeName}`);

//     try {
//         // 1️⃣ Create Namespace FIRST
//         try {
//             await k8sApi.createNamespace({
//                 body: { metadata: { name: namespace } }
//             });
//             console.log(`[CREATE] ✅ Namespace ${namespace} created`);
//         } catch (nsErr) {
//             if (nsErr.response?.statusCode === 409) {
//                 console.log(`[CREATE] ℹ️ Namespace ${namespace} already exists`);
//             } else {
//                 throw nsErr;
//             }
//         }

//         // 2️⃣ Execute Helm Install (BEFORE DB save)
//         const env = process.env.NODE_ENV === 'production' ? 'prod' : 'local';
//         const chartPath = path.resolve(__dirname, "../charts/store-chart");
//         const helmCommand = `helm install ${storeName} "${chartPath}" --namespace ${namespace} -f "${chartPath}/values.yaml" -f "${chartPath}/values-${env}.yaml" --set ingress.host=${storeName}.local`;

//         console.log(`[CREATE] Executing: ${helmCommand}`);

//         try {
//             const { stdout, stderr } = await execPromise(helmCommand);
//             console.log(`[CREATE] ✅ Helm install success: ${stdout}`);
//             if (stderr) console.warn(`[CREATE] Helm stderr: ${stderr}`);
//         } catch (helmErr) {
//             console.error(`[CREATE] ❌ Helm install failed: ${helmErr.message}`);
//             console.error(`[CREATE] Helm stderr: ${helmErr.stderr}`);

//             // Cleanup namespace since Helm failed
//             try {
//                 await k8sApi.deleteNamespace(namespace);
//                 console.log(`[CREATE] 🧹 Cleaned up namespace after Helm failure`);
//             } catch (cleanupErr) {
//                 console.error(`[CREATE] Failed to cleanup namespace: ${cleanupErr.message}`);
//             }

//             return res.status(500).json({
//                 success: false,
//                 error: 'Helm installation failed',
//                 details: helmErr.message
//             });
//         }

//         // 3️⃣ Save to SQLite ONLY AFTER Helm succeeds
//         try {
//             StoreRepo.create({
//                 storeName,
//                 engine,
//                 namespace,
//                 status: "Provisioning",
//                 url,
//                 createdAt
//             });
//             console.log(`[CREATE] ✅ Saved to database`);
//         } catch (dbErr) {
//             console.error(`[CREATE] ❌ Database save failed: ${dbErr.message}`);

//             // Helm installed but DB failed - this is a problem
//             // You might want to uninstall Helm here or mark it somehow
//             return res.status(500).json({
//                 success: false,
//                 error: 'Database save failed after Helm install',
//                 details: dbErr.message,
//                 warning: 'Store may be running in cluster but not tracked in DB'
//             });
//         }

//         // 4️⃣ Send success response
//         res.status(201).json({
//             success: true,
//             status: 'Provisioning',
//             storeName,
//             namespace,
//             url
//         });

//     } catch (err) {
//         console.error("[CREATE] Unexpected error:", err.body || err);
//         res.status(500).json({
//             success: false,
//             error: 'Store provisioning failed',
//             details: err.message
//         });
//     }
// });

app.post('/api/stores', createStoreLimiter, async (req, res) => {
    const { storeName, engine } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const namespace = `store-${storeName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const url = `http://${storeName}.local`;
    const createdAt = new Date().toISOString();

    console.log(`[CREATE] Starting provisioning for store: ${storeName}`);

    // ── Audit: store creation started ──
    auditLog({
        action: 'CREATE_STARTED',
        storeName,
        namespace,
        engine,
        status: 'Provisioning',
        message: `Store creation initiated`,
        ip
    });

    try {
        // 1️⃣ Create Namespace
        try {
            await k8sApi.createNamespace({
                body: { metadata: { name: namespace } }
            });
            console.log(`[CREATE] ✅ Namespace ${namespace} created`);
        } catch (nsErr) {
            if (nsErr.response?.statusCode === 409) {
                console.log(`[CREATE] ℹ️ Namespace ${namespace} already exists`);
            } else {
                throw nsErr;
            }
        }

        // 2️⃣ Execute Helm Install
        const env = process.env.NODE_ENV === 'production' ? 'prod' : 'local';
        const chartPath = path.resolve(__dirname, "../charts/store-chart");
        const helmCommand = `helm install ${storeName} "${chartPath}" --namespace ${namespace} -f "${chartPath}/values.yaml" -f "${chartPath}/values-${env}.yaml" --set ingress.host=${storeName}.local`;

        console.log(`[CREATE] Executing: ${helmCommand}`);

        try {
            const { stdout, stderr } = await execPromise(helmCommand);
            console.log(`[CREATE] ✅ Helm install success: ${stdout}`);
            if (stderr) console.warn(`[CREATE] Helm stderr: ${stderr}`);
        } catch (helmErr) {
            console.error(`[CREATE] ❌ Helm install failed: ${helmErr.message}`);

            // Cleanup namespace since Helm failed
            try {
                await k8sApi.deleteNamespace({ name: namespace });
                console.log(`[CREATE] 🧹 Cleaned up namespace after Helm failure`);
            } catch (cleanupErr) {
                console.error(`[CREATE] Failed to cleanup namespace: ${cleanupErr.message}`);
            }

            // ── Audit: helm failed ──
            auditLog({
                action: 'CREATE_FAILED',
                storeName,
                namespace,
                engine,
                status: 'Failed',
                message: `Helm install failed: ${helmErr.message}`,
                ip
            });

            return res.status(500).json({
                success: false,
                error: 'Helm installation failed',
                details: helmErr.message
            });
        }

        // 3️⃣ Save to SQLite ONLY AFTER Helm succeeds
        try {
            StoreRepo.create({ storeName, engine, namespace, status: "Provisioning", url, createdAt });
            console.log(`[CREATE] ✅ Saved to database`);
        } catch (dbErr) {
            console.error(`[CREATE] ❌ Database save failed: ${dbErr.message}`);

            // ── Audit: db failed ──
            auditLog({
                action: 'CREATE_DB_FAILED',
                storeName,
                namespace,
                engine,
                status: 'Failed',
                message: `DB save failed after Helm install: ${dbErr.message}`,
                ip
            });

            return res.status(500).json({
                success: false,
                error: 'Database save failed after Helm install',
                details: dbErr.message,
                warning: 'Store may be running in cluster but not tracked in DB'
            });
        }

        // ── Audit: success ──
        auditLog({
            action: 'CREATE_SUCCESS',
            storeName,
            namespace,
            engine,
            status: 'Provisioning',
            message: `Store successfully provisioned via Helm`,
            ip
        });

        res.status(201).json({
            success: true,
            status: 'Provisioning',
            storeName,
            namespace,
            url
        });

    } catch (err) {
        console.error("[CREATE] Unexpected error:", err.body || err);

        auditLog({
            action: 'CREATE_ERROR',
            storeName,
            namespace,
            engine,
            status: 'Failed',
            message: `Unexpected error: ${err.message}`,
            ip
        });

        res.status(500).json({
            success: false,
            error: 'Store provisioning failed',
            details: err.message
        });
    }

});

app.get('/api/stores/:name/status', async (req, res) => {
    const nameParam = req.params.name;

    try {
        const store = db.prepare(`SELECT * FROM stores WHERE store_name = ? OR namespace = ?`)
            .get(nameParam, nameParam);

        if (!store) {
            return res.status(404).json({ status: 'NotFound' });
        }

        const response = await k8sApi.listNamespacedPod({
            namespace: store.namespace
        });

        //const pods = response.body?.items || [];
        const pods = response.items || response.body?.items || [];

        if (pods.length === 0) {
            if (store.status !== 'Provisioning') {
                StoreRepo.updateStatus(store.store_name, 'Provisioning');
            }
            return res.json({ status: 'Provisioning', podsFound: [] });
        }

        // ✅ IMPROVED: Check if essential pods are ready
        const wordpressPods = pods.filter(p =>
            p.metadata.name.includes('wordpress') || p.metadata.name.includes('store-chart')
        );

        const mysqlPods = pods.filter(p => p.metadata.name.includes('mysql'));

        // Check if WordPress is running (ignore CrashLoopBackOff pods if we have a working one)
        const workingWordpressPod = wordpressPods.find(pod =>
            pod.status.phase === 'Running' &&
            pod.status.containerStatuses &&
            pod.status.containerStatuses.every(c => c.ready === true)
        );

        const mysqlReady = mysqlPods.some(pod =>
            pod.status.phase === 'Running' &&
            pod.status.containerStatuses &&
            pod.status.containerStatuses.every(c => c.ready === true)
        );

        // Store is ready if we have at least one working WordPress pod AND MySQL is ready
        const isReady = workingWordpressPod && mysqlReady;
        const newStatus = isReady ? 'Ready' : 'Installing';

        // Add right after you get the pods
        // console.log('[DEBUG] All pods:', pods.map(p => ({
        //     name: p.metadata.name,
        //     phase: p.status.phase,
        //     containerStatuses: p.status.containerStatuses?.map(c => ({
        //         name: c.name,
        //         ready: c.ready
        //     }))
        // })));

        if (store.status !== newStatus) {
            StoreRepo.updateStatus(store.store_name, newStatus);
        }

        res.json({
            status: newStatus,
            namespace: store.namespace,
            podsFound: pods.map(p => ({
                name: p.metadata.name,
                phase: p.status.phase,
                ready: p.status.containerStatuses?.every(c => c.ready) || false
            })),
            details: {
                wordpressReady: !!workingWordpressPod,
                mysqlReady: mysqlReady
            }
        });

    } catch (err) {
        console.error('[STATUS ERROR]', {
            message: err.message,
            body: err.body
        });

        res.status(500).json({
            status: 'Error',
            message: err.message
        });
    }
});

// app.delete('/api/stores/:name', async (req, res) => {
//     const storeName = req.params.name;
//     const errors = [];
//     let deleteSuccess = false;

//     console.log(`[DELETE] Starting cleanup for store: ${storeName}`);

//     try {
//         // 1️⃣ Get store from database
//         const store = db.prepare(`SELECT * FROM stores WHERE store_name = ? OR namespace = ?`)
//             .get(storeName, storeName);

//         if (!store) {
//             return res.status(404).json({
//                 success: false,
//                 message: `Store ${storeName} not found`
//             });
//         }

//         console.log(`[DELETE] Found store:`, {
//             name: store.store_name,
//             namespace: store.namespace,
//             status: store.status
//         });

//         // 2️⃣ Helm uninstall
//         try {
//             const { stdout, stderr } = await execPromise(`helm uninstall ${storeName} --namespace ${store.namespace}`);
//             console.log(`[DELETE] ✅ Helm uninstalled: ${stdout}`);
//             if (stderr) console.warn(`[DELETE] Helm stderr: ${stderr}`);
//         } catch (helmErr) {
//             const errMsg = `Helm uninstall failed: ${helmErr.message}`;
//             console.warn(`[DELETE] ⚠️ ${errMsg}`);
//             errors.push(errMsg);
//         }

//         // 3️⃣ Delete namespace
//         try {
//             await k8sApi.deleteNamespace({ name: store.namespace });
//             //await k8sApi.deleteNamespace(`store-${storeName}`);
//             //await k8sApi.deleteNamespace(store.namespace); 
//             console.log(`[DELETE] ✅ Namespace ${store.namespace} deletion initiated`);

//             await new Promise(resolve => setTimeout(resolve, 2000));
//         } catch (nsErr) {
//             if (nsErr.response?.statusCode === 404) {
//                 console.log(`[DELETE] ℹ️ Namespace already gone`);
//             } else {
//                 const errMsg = `Namespace deletion failed: ${nsErr.message}`;
//                 console.warn(`[DELETE] ⚠️ ${errMsg}`);
//                 console.error(`[DELETE] Full error:`, nsErr.body || nsErr);
//                 errors.push(errMsg);
//             }
//         }

//         // 4️⃣ Always delete from database (even if K8s cleanup failed)
//         try {
//             StoreRepo.deleteById(store.id);
//             console.log(`[DELETE] ✅ Removed from database`);
//             deleteSuccess = true;
//         } catch (dbErr) {
//             const errMsg = `Database deletion failed: ${dbErr.message}`;
//             console.error(`[DELETE] ❌ ${errMsg}`);
//             errors.push(errMsg);
//         }

//         // 5️⃣ Return response
//         if (deleteSuccess) {
//             res.json({
//                 success: true,
//                 message: `Store ${storeName} deleted`,
//                 warnings: errors.length > 0 ? errors : undefined,
//                 deletedStore: {
//                     name: storeName,
//                     namespace: store.namespace
//                 }
//             });
//         } else {
//             res.status(500).json({
//                 success: false,
//                 message: 'Failed to delete store from database',
//                 errors
//             });
//         }

//     } catch (err) {
//         console.error(`[DELETE ERROR]`, err);
//         res.status(500).json({
//             success: false,
//             error: err.message,
//             //stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
//         });
//     }
// });

app.delete('/api/stores/:name', deleteStoreLimiter, async (req, res) => {
    const storeName = req.params.name;
    const ip = req.ip || req.connection.remoteAddress;
    const errors = [];
    let deleteSuccess = false;

    console.log(`[DELETE] Starting cleanup for store: ${storeName}`);

    try {
        const store = db.prepare(`SELECT * FROM stores WHERE store_name = ? OR namespace = ?`)
            .get(storeName, storeName);

        if (!store) {
            return res.status(404).json({ success: false, message: `Store ${storeName} not found` });
        }

        console.log(`[DELETE] Found store:`, { name: store.store_name, namespace: store.namespace });

        // ── Audit: delete started ──
        auditLog({
            action: 'DELETE_STARTED',
            storeName,
            namespace: store.namespace,
            engine: store.engine,
            status: store.status,
            message: `Delete initiated`,
            ip
        });

        // 2️⃣ Helm uninstall
        try {
            const { stdout, stderr } = await execPromise(`helm uninstall ${storeName} --namespace ${store.namespace}`);
            console.log(`[DELETE] ✅ Helm uninstalled: ${stdout}`);
            if (stderr) console.warn(`[DELETE] Helm stderr: ${stderr}`);
        } catch (helmErr) {
            const errMsg = `Helm uninstall failed: ${helmErr.message}`;
            console.warn(`[DELETE] ⚠️ ${errMsg}`);
            errors.push(errMsg);
        }

        // 3️⃣ Delete namespace
        try {
            await k8sApi.deleteNamespace({ name: store.namespace });
            console.log(`[DELETE] ✅ Namespace ${store.namespace} deletion initiated`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (nsErr) {
            if (nsErr.response?.statusCode === 404) {
                console.log(`[DELETE] ℹ️ Namespace already gone`);
            } else {
                const errMsg = `Namespace deletion failed: ${nsErr.message}`;
                console.warn(`[DELETE] ⚠️ ${errMsg}`);
                errors.push(errMsg);
            }
        }

        // 4️⃣ Remove from DB
        try {
            StoreRepo.deleteById(store.id);
            console.log(`[DELETE] ✅ Removed from database`);
            deleteSuccess = true;
        } catch (dbErr) {
            const errMsg = `Database deletion failed: ${dbErr.message}`;
            console.error(`[DELETE] ❌ ${errMsg}`);
            errors.push(errMsg);
        }

        // ── Audit: delete result ──
        auditLog({
            action: deleteSuccess ? 'DELETE_SUCCESS' : 'DELETE_FAILED',
            storeName,
            namespace: store.namespace,
            engine: store.engine,
            status: 'Deleted',
            message: deleteSuccess
                ? `Store deleted successfully${errors.length ? ' with warnings' : ''}`
                : `Delete failed: ${errors.join(', ')}`,
            ip
        });

        if (deleteSuccess) {
            res.json({
                success: true,
                message: `Store ${storeName} deleted`,
                warnings: errors.length > 0 ? errors : undefined,
                deletedStore: { name: storeName, namespace: store.namespace }
            });
        } else {
            res.status(500).json({ success: false, message: 'Failed to delete store', errors });
        }

    } catch (err) {
        console.error(`[DELETE ERROR]`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/reset', async (req, res) => {

    try {
        StoreRepo.resetAll();
        res.json({
            success: true,
            message: 'Database reset successfully'
        });
    }
    catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/api/audit-logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const storeName = req.query.store;

        let logs;
        if (storeName) {
            logs = db.prepare(`SELECT * FROM audit_logs WHERE store_name = ? ORDER BY timestamp DESC LIMIT ?`)
                .all(storeName, limit);
        } else {
            logs = db.prepare(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?`)
                .all(limit);
        }

        res.json({ success: true, logs });
    } catch (err) {
        console.error("Audit log fetch error:", err);
        res.status(500).json({ error: "Failed to fetch audit logs" });
    }
});

app.get('/api/metrics', (req, res) => {
    try {
        const totalStores = db.prepare(`SELECT COUNT(*) as count FROM stores`).get();
        const readyStores = db.prepare(`SELECT COUNT(*) as count FROM stores WHERE status = 'Ready'`).get();
        const failedStores = db.prepare(`SELECT COUNT(*) as count FROM stores WHERE status = 'Failed'`).get();
        const provisioningStores = db.prepare(`SELECT COUNT(*) as count FROM stores WHERE status IN ('Provisioning', 'Installing')`).get();

        const totalCreated = db.prepare(`SELECT COUNT(*) as count FROM audit_logs WHERE action = 'CREATE_SUCCESS'`).get();
        const totalDeleted = db.prepare(`SELECT COUNT(*) as count FROM audit_logs WHERE action = 'DELETE_SUCCESS'`).get();
        const totalFailed = db.prepare(`SELECT COUNT(*) as count FROM audit_logs WHERE action = 'CREATE_FAILED'`).get();

        res.json({
            success: true,
            metrics: {
                stores: {
                    total: totalStores.count,
                    ready: readyStores.count,
                    failed: failedStores.count,
                    provisioning: provisioningStores.count,
                },
                activity: {
                    totalCreated: totalCreated.count,
                    totalDeleted: totalDeleted.count,
                    totalFailed: totalFailed.count,
                }
            }
        });
    } catch (err) {
        console.error("Metrics fetch error:", err);
        res.status(500).json({ error: "Failed to fetch metrics" });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Orchestrator running on port ${PORT}`));
