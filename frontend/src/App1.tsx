import { useState, useEffect } from 'react'
import axios from 'axios'
import { Plus, Trash2, ExternalLink, RefreshCw, Server, Activity, Shield, BarChart3 } from 'lucide-react';

interface Store {
    name: string;
    engine: string;
    status: 'Provisioning' | 'Installing' | 'Ready' | 'Failed';
    url: string;
    namespace: string;
}

interface Metrics {
    total_stores: number;
    by_status: { provisioning: number; ready: number; failed: number; installing: number; };
    by_engine: { woocommerce: number; medusa: number; };
}

interface AuditEntry {
    timestamp: string;
    action: string;
    storeName: string;
    user: string;
}

const API_BASE_URL = "http://localhost:3001/api";

function App() {
    const [storeName, setStoreName] = useState<string>('');
    const [engine, setEngine] = useState<string>('woocommerce');
    const [stores, setStores] = useState<Store[]>([]);
    const [isDeploying, setIsDeploying] = useState<boolean>(false);
    const [showAdmin, setShowAdmin] = useState<boolean>(false);
    const [metrics, setMetrics] = useState<Metrics | null>(null);
    const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

    useEffect(() => {
        fetchStores();
        const interval = setInterval(fetchStores, 10000);
        return () => clearInterval(interval);
    }, []);

    const fetchStores = async () => {
        try {
            const response = await axios.get(`${API_BASE_URL}/stores`);
            setStores(response.data.map((s: any) => ({
                name: s.store_name, engine: s.engine, status: s.status, url: s.url, namespace: s.namespace
            })));
        } catch (err: any) {
            console.error("Failed to fetch stores:", err.message);
        }
    };

    const checkStatus = async (name: string, index: number) => {
        try {
            const res = await axios.get(`${API_BASE_URL}/stores/${name}/status`);
            const updatedStores = [...stores];
            updatedStores[index].status = res.data.status;
            setStores(updatedStores);
        } catch (error) {
            console.error("Status check failed", error);
        }
    };

    const handleCreateStore = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!storeName) return;
        setIsDeploying(true);
        try {
            const response = await axios.post(`${API_BASE_URL}/stores`, { storeName, engine });
            setStores(prev => [...prev, {
                name: storeName, engine, status: response.data.status || 'Provisioning',
                url: response.data.url, namespace: `store-${storeName.toLowerCase().replace(/[^a-z0-9]/g, '')}`
            }]);
            setStoreName('');
        } catch (error) {
            console.error("Provisioning error:", error);
            alert("Could not connect to the Orchestrator.");
        } finally {
            setIsDeploying(false);
        }
    };

    useEffect(() => {
        const interval = setInterval(() => {
            stores.forEach((store, index) => {
                if (store.status !== 'Ready' && store.status !== 'Failed') checkStatus(store.name, index);
            });
        }, 5000);
        return () => clearInterval(interval);
    }, [stores]);

    const handleDelete = async (storeName: string) => {
        if (!window.confirm(`Are you sure you want to delete ${storeName}?`)) return;
        try {
            await axios.delete(`${API_BASE_URL}/stores/${storeName}`);
            fetchStores();
        } catch (err: any) {
            console.error("Failed to delete store:", err.message);
            alert("Error deleting store.");
        }
    };

    const fetchMetrics = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/admin/metrics`);
            setMetrics(res.data);
        } catch (err) { console.error("Failed to fetch metrics:", err); }
    };

    const fetchAuditLog = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/admin/audit?limit=20`);
            setAuditLog(res.data.entries || []);
        } catch (err) { console.error("Failed to fetch audit log:", err); }
    };

    useEffect(() => {
        if (showAdmin) { fetchMetrics(); fetchAuditLog(); }
    }, [showAdmin]);

    const getStatusStyle = (status: string) => {
        switch (status) {
            case 'Ready': return 'bg-green-100 text-green-600';
            case 'Failed': return 'bg-red-100 text-red-600';
            default: return 'bg-amber-100 text-amber-600';
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <div className="max-w-6xl mx-auto">
                <header className="flex items-center justify-between mb-12">
                    <div>
                        <h1 className="text-4xl font-black text-slate-900">Urumi Cloud</h1>
                        <p className="text-slate-500 mt-1">Multi-tenant Kubernetes Store Orchestrator</p>
                    </div>
                    <div className="flex gap-3">
                        <button onClick={() => setShowAdmin(!showAdmin)}
                            className="flex items-center gap-2 bg-slate-800 text-white px-4 py-2 rounded-lg hover:bg-slate-700 text-sm font-medium">
                            <Shield size={16} /> {showAdmin ? 'Hide Admin' : 'Admin Panel'}
                        </button>
                        <div className="flex items-center gap-2 bg-green-100 text-green-700 px-3 py-1 rounded-full text-sm border border-green-200">
                            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> Cluster Online
                        </div>
                    </div>
                </header>

                {showAdmin && (
                    <div className="grid md:grid-cols-2 gap-6 mb-10">
                        <div className="bg-white border rounded-2xl p-6">
                            <div className="flex gap-2 mb-4"><BarChart3 size={20} className="text-blue-600" /><h3 className="font-bold text-lg">Metrics</h3></div>
                            {metrics ? (
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between"><span>Total:</span><b>{metrics.total_stores}</b></div>
                                    <div className="flex justify-between"><span>Ready:</span><b className="text-green-600">{metrics.by_status.ready}</b></div>
                                    <div className="flex justify-between"><span>Provisioning:</span><b className="text-amber-600">{metrics.by_status.provisioning + metrics.by_status.installing}</b></div>
                                    <div className="flex justify-between"><span>Failed:</span><b className="text-red-600">{metrics.by_status.failed}</b></div>
                                    <hr /><div className="flex justify-between"><span>WooCommerce:</span><b>{metrics.by_engine.woocommerce}</b></div>
                                    <div className="flex justify-between"><span>Medusa:</span><b>{metrics.by_engine.medusa}</b></div>
                                </div>
                            ) : <p className="text-slate-400 text-sm">Loading...</p>}
                        </div>

                        <div className="bg-white border rounded-2xl p-6">
                            <div className="flex gap-2 mb-4"><Activity size={20} className="text-purple-600" /><h3 className="font-bold text-lg">Activity</h3></div>
                            <div className="space-y-2 max-h-64 overflow-y-auto">
                                {auditLog.length > 0 ? auditLog.map((e, i) => (
                                    <div key={i} className="text-xs border-b pb-2">
                                        <div className="flex justify-between"><span className="font-mono">{e.action}</span><span className="text-slate-400">{new Date(e.timestamp).toLocaleTimeString()}</span></div>
                                        <div className="text-slate-500 mt-1">Store: <b>{e.storeName}</b></div>
                                    </div>
                                )) : <p className="text-slate-400 text-sm">No activity</p>}
                            </div>
                        </div>
                    </div>
                )}

                <section className="bg-white border rounded-2xl p-8 mb-10">
                    <form onSubmit={handleCreateStore} className="grid md:grid-cols-3 gap-6 items-end">
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase text-slate-500">Store Name</label>
                            <input type="text" placeholder="my-cool-shop" className="w-full bg-slate-50 border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none"
                                value={storeName} onChange={(e) => setStoreName(e.target.value)} />
                        </div>
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase text-slate-500">Engine</label>
                            <select className="w-full bg-slate-50 border rounded-xl px-4 py-3 outline-none" value={engine} onChange={(e) => setEngine(e.target.value)}>
                                <option value="woocommerce">WordPress + WooCommerce</option>
                                <option value="medusa">MedusaJS (Headless)</option>
                            </select>
                        </div>
                        <button type="submit" disabled={isDeploying}
                            className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50">
                            {isDeploying ? <RefreshCw className="animate-spin" /> : <Plus size={20} />} Deploy Store
                        </button>
                    </form>
                </section>

                <div className="grid gap-4">
                    {stores.length === 0 ? (
                        <div className="text-center py-20 bg-slate-100 border-2 border-dashed rounded-2xl">
                            <Server className="mx-auto text-slate-300 mb-4" size={48} />
                            <p className="text-slate-400 font-medium">No active deployments</p>
                        </div>
                    ) : stores.map((store, i) => (
                        <div key={i} className="bg-white border p-5 rounded-2xl flex justify-between hover:shadow-md transition">
                            <div className="flex gap-4">
                                <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center"><Server size={24} /></div>
                                <div>
                                    <h3 className="font-bold text-lg">{store.name}</h3>
                                    <div className="flex gap-3 text-xs text-slate-400 font-mono mt-1">
                                        <span>NS: {store.namespace}</span><span>Engine: {store.engine}</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-6">
                                <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${getStatusStyle(store.status)}`}>
                                    {store.status !== 'Ready' && store.status !== 'Failed' && <RefreshCw size={10} className="inline mr-1 animate-spin" />}
                                    {store.status}
                                </span>
                                <div className="flex gap-2 border-l pl-6">
                                    <a href={store.url} target="_blank" rel="noreferrer" className="p-2 hover:bg-slate-100 rounded-lg text-slate-600"><ExternalLink size={20} /></a>
                                    <button onClick={() => handleDelete(store.name)} className="p-2 hover:bg-red-50 rounded-lg text-red-400 hover:text-red-600"><Trash2 size={20} /></button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default App