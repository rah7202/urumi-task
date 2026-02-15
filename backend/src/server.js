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
//app.use(cors());

app.use(cors({
    origin: [
        'http://localhost:5173',
        'http://localhost:3001',
        'https://urumi-task-18bsn1hh9-rah7202s-projects.vercel.app',
        /\.vercel\.app$/,
        /\.trycloudflare\.com$/
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}))

app.set('trust proxy', 1);

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many request at a time! Please try again later.' }
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


// Initializing Kubernetes Client
const kc = new k8s.KubeConfig();
kc.loadFromFile(kubeConfigPath);

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
    kc.loadFromFile(kubeConfigPath);
    console.log("Production mode: uisng kubeconfig directlty");

} else {
    const cluster = kc.clusters.find(c => c.name === 'docker-desktop');
    const user = kc.users.find(u => u.name === 'docker-desktop');

    if (cluster && user) {
        kc.loadFromClusterAndUser(cluster, user);
        console.log("Forced K8s to use Docker Desktop cluseter and user objects.");
    } else {
        kc.setCurrentContext('docker-desktop');
    }
}

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);


console.log("Node.js is querying K8s at:", kc.getCurrentCluster().server);

app.get('/api/stores', (req, res) => {
    try {
        const stores = StoreRepo.findAll();
        res.json(stores);
    } catch (err) {
        console.error("DB Fetch Error:", err);
        res.status(500).json({ error: "Failed to load stores" });
    }
});

app.post('/api/stores', createStoreLimiter, async (req, res) => {
    const { storeName, engine } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const namespace = `store-${storeName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    //const url = `http://${storeName}.local`;
    const storeHost = process.env.NODE_ENV === 'production' ? `${storeName}.34.135.50.141.nip.io` : `${storeName}.local`;
    const url = `http://${storeHost}`;
    const createdAt = new Date().toISOString();

    console.log(`[CREATE] Starting provisioning for store: ${storeName}`);

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
        // Creating Namespace
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

        // Executing Helm Install
        const env = process.env.NODE_ENV === 'production' ? 'prod' : 'local';
        const chartPath = path.resolve(__dirname, "../charts/store-chart");
        //const helmCommand = `helm install ${storeName} "${chartPath}" --namespace ${namespace} -f "${chartPath}/values.yaml" -f "${chartPath}/values-${env}.yaml" --set ingress.host=${storeName}.local`;

        const helmCommand = `helm install ${storeName} "${chartPath}" --namespace ${namespace} -f "${chartPath}/values.yaml" -f "${chartPath}/values-${env}.yaml" --set ingress.host=${storeHost}`;
        console.log(`[CREATE] Executing: ${helmCommand}`);

        try {
            const { stdout, stderr } = await execPromise(helmCommand);
            console.log(`[CREATE] ✅ Helm install success: ${stdout}`);
            if (stderr) console.warn(`[CREATE] Helm stderr: ${stderr}`);
        } catch (helmErr) {
            console.error(`[CREATE] ❌ Helm install failed: ${helmErr.message}`);

            // Cleaning namespace since Helm failed
            try {
                await k8sApi.deleteNamespace({ name: namespace });
                console.log(`[CREATE] 🧹 Cleaned up namespace after Helm failure`);
            } catch (cleanupErr) {
                console.error(`[CREATE] Failed to cleanup namespace: ${cleanupErr.message}`);
            }

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

        // Saving to SQLite ONLY AFTER Helm succeeds
        try {
            StoreRepo.create({ storeName, engine, namespace, status: "Provisioning", url, createdAt });
            console.log(`[CREATE] ✅ Saved to database`);
        } catch (dbErr) {
            console.error(`[CREATE] ❌ Database save failed: ${dbErr.message}`);

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

        // Checking if essential pods are ready
        const wordpressPods = pods.filter(p =>
            p.metadata.name.includes('wordpress') || p.metadata.name.includes('store-chart')
        );

        const mysqlPods = pods.filter(p => p.metadata.name.includes('mysql'));

        // Checking if WordPress is running (ignore CrashLoopBackOff pods if we have a working one)
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

        // Adding this for debugging 
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

        auditLog({
            action: 'DELETE_STARTED',
            storeName,
            namespace: store.namespace,
            engine: store.engine,
            status: store.status,
            message: `Delete initiated`,
            ip
        });

        // Helm uninstall
        try {
            const { stdout, stderr } = await execPromise(`helm uninstall ${storeName} --namespace ${store.namespace}`);
            console.log(`[DELETE] ✅ Helm uninstalled: ${stdout}`);
            if (stderr) console.warn(`[DELETE] Helm stderr: ${stderr}`);
        } catch (helmErr) {
            const errMsg = `Helm uninstall failed: ${helmErr.message}`;
            console.warn(`[DELETE] ⚠️ ${errMsg}`);
            errors.push(errMsg);
        }

        // Deleting namespace
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

        // Removing from DB
        try {
            StoreRepo.deleteById(store.id);
            console.log(`[DELETE] ✅ Removed from database`);
            deleteSuccess = true;
        } catch (dbErr) {
            const errMsg = `Database deletion failed: ${dbErr.message}`;
            console.error(`[DELETE] ❌ ${errMsg}`);
            errors.push(errMsg);
        }

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
