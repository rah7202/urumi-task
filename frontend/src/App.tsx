import { useState, useEffect } from 'react'
import axios from 'axios'
import { Plus, Trash2, ExternalLink, RefreshCw, Server, ScrollText, Activity, CheckCircle, XCircle, Clock } from 'lucide-react';

interface Store {
    name: string;
    engine: string;
    status: 'Provisioning' | 'Installing' | 'Ready' | 'Failed';
    url: string;
    namespace: string;
}

interface AuditLog {
    id: number;
    action: string;
    store_name: string;
    namespace: string;
    engine: string;
    status: string;
    message: string;
    ip: string;
    timestamp: string;
}

interface Metrics {
    stores: { total: number; ready: number; failed: number; provisioning: number; };
    activity: { totalCreated: number; totalDeleted: number; totalFailed: number; };
}

const API_BASE_URL = "http://localhost:3001/api";

function App() {
    const [storeName, setStoreName] = useState<string>('');
    const [engine, setEngine] = useState<string>('woocommerce');
    const [stores, setStores] = useState<Store[]>([]);
    const [isDeploying, setIsDeploying] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState<'stores' | 'audit' | 'metrics'>('stores');
    const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
    const [metrics, setMetrics] = useState<Metrics | null>(null);

    useEffect(() => {
        fetchStores();
        fetchAuditLogs();
        fetchMetrics();
        const interval = setInterval(() => {
            fetchStores();
            fetchAuditLogs();
            fetchMetrics();
        }, 10000);
        return () => clearInterval(interval);
    }, []);

    const fetchStores = async () => {
        try {
            const response = await axios.get(`${API_BASE_URL}/stores`);
            const mapped = response.data.map((s: any) => ({
                name: s.store_name, engine: s.engine, status: s.status, url: s.url, namespace: s.namespace,
            }));
            setStores(mapped);
        } catch (err: any) { console.error("Failed to fetch stores:", err.message); }
    };

    const fetchAuditLogs = async () => {
        try {
            const response = await axios.get(`${API_BASE_URL}/audit-logs?limit=50`);
            setAuditLogs(response.data.logs || []);
        } catch (err: any) { console.error("Failed to fetch audit logs:", err.message); }
    };

    const fetchMetrics = async () => {
        try {
            const response = await axios.get(`${API_BASE_URL}/metrics`);
            setMetrics(response.data.metrics);
        } catch (err: any) { console.error("Failed to fetch metrics:", err.message); }
    };

    const checkStatus = async (name: string, index: number) => {
        try {
            const res = await axios.get(`${API_BASE_URL}/stores/${name}/status`);
            if (res.data.status === 'Ready' || res.data.status === 'Failed') {
                const updatedStores = [...stores];
                updatedStores[index].status = res.data.status;
                setStores(updatedStores);
            }
        } catch (error) { console.error("Status check failed", error); }
    };

    useEffect(() => {
        const interval = setInterval(() => {
            stores.forEach((store, index) => {
                if (store.status !== 'Ready' && store.status !== 'Failed') checkStatus(store.name, index);
            });
        }, 5000);
        return () => clearInterval(interval);
    }, [stores]);

    const handleCreateStore = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!storeName) return;
        setIsDeploying(true);
        try {
            const response = await axios.post(`${API_BASE_URL}/stores`, { storeName, engine });
            setStores(prev => [...prev, {
                name: storeName, engine, status: response.data.status || 'Provisioning',
                url: response.data.url,
                namespace: `store-${storeName.toLowerCase().replace(/[^a-z0-9]/g, '')}`
            }]);
            setStoreName('');
            fetchAuditLogs();
            fetchMetrics();
        } catch (error: any) {
            const msg = error?.response?.data?.error || "Could not connect to the Orchestrator.";
            alert(msg);
        } finally { setIsDeploying(false); }
    };

    const handleDelete = async (name: string) => {
        if (!window.confirm(`Are you sure you want to delete ${name}?`)) return;
        try {
            await axios.delete(`${API_BASE_URL}/stores/${name}`);
            fetchStores();
            fetchAuditLogs();
            fetchMetrics();
        } catch (err: any) { alert("Error deleting store. Check console for details."); }
    };

    const getStatusStyle = (status: string) => {
        switch (status) {
            case 'Ready': return 'bg-green-100 text-green-600';
            case 'Failed': return 'bg-red-100 text-red-600';
            default: return 'bg-amber-100 text-amber-600';
        }
    };

    const getActionStyle = (action: string) => {
        if (action.includes('SUCCESS')) return 'text-green-600 bg-green-50';
        if (action.includes('FAILED') || action.includes('ERROR')) return 'text-red-600 bg-red-50';
        if (action.includes('STARTED')) return 'text-blue-600 bg-blue-50';
        if (action.includes('DELETE')) return 'text-orange-600 bg-orange-50';
        return 'text-slate-600 bg-slate-100';
    };

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-6">
            <div className="max-w-6xl mx-auto">

                {/* Header */}
                <header className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-4xl font-black tracking-tight text-slate-900">Urumi Cloud</h1>
                        <p className="text-slate-500 mt-1">Multi-tenant Kubernetes Store Orchestrator</p>
                    </div>
                    <div className="flex items-center gap-2 bg-green-100 text-green-700 px-3 py-1 rounded-full text-sm font-medium border border-green-200">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                        Cluster Online
                    </div>
                </header>

                {/* Metrics Strip */}
                {metrics && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                        {[
                            { label: 'Total Stores', value: metrics.stores.total, icon: <Server size={18} />, color: 'text-blue-600 bg-blue-50' },
                            { label: 'Ready', value: metrics.stores.ready, icon: <CheckCircle size={18} />, color: 'text-green-600 bg-green-50' },
                            { label: 'Provisioning', value: metrics.stores.provisioning, icon: <Clock size={18} />, color: 'text-amber-600 bg-amber-50' },
                            { label: 'Failed', value: metrics.stores.failed, icon: <XCircle size={18} />, color: 'text-red-600 bg-red-50' },
                        ].map((m, i) => (
                            <div key={i} className="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-3">
                                <div className={`p-2 rounded-lg ${m.color}`}>{m.icon}</div>
                                <div>
                                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">{m.label}</p>
                                    <p className="text-2xl font-black text-slate-900">{m.value}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-2 mb-6 border-b border-slate-200">
                    {[
                        { id: 'stores', label: 'Stores', icon: <Server size={16} /> },
                        { id: 'audit', label: 'Audit Log', icon: <ScrollText size={16} /> },
                        { id: 'metrics', label: 'Activity', icon: <Activity size={16} /> },
                    ].map(tab => (
                        <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
                            className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-t-lg border-b-2 transition-colors ${activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800 cursor-pointer'
                                }`}>
                            {tab.icon}{tab.label}
                        </button>
                    ))}
                </div>

                {/* STORES TAB */}
                {activeTab === 'stores' && (
                    <>
                        <section className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm mb-6">
                            <form onSubmit={handleCreateStore} className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                                <div>
                                    <label className="block text-sm font-bold mb-2 uppercase tracking-wider text-slate-500">Store Name</label>
                                    <input type="text" placeholder="my-cool-shop"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                        value={storeName} onChange={(e) => setStoreName(e.target.value)} />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold mb-2 uppercase tracking-wider text-slate-500">Engine</label>
                                    <select className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 appearance-none outline-none"
                                        value={engine} onChange={(e) => setEngine(e.target.value)}>
                                        <option value="woocommerce">WordPress + WooCommerce</option>
                                        <option value="medusa">MedusaJS (Headless)</option>
                                    </select>
                                </div>
                                <button type="submit" disabled={isDeploying}
                                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl flex items-center justify-center gap-2 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer">
                                    {isDeploying ? <RefreshCw className="animate-spin" size={20} /> : <Plus size={20} />}
                                    Deploy Store
                                </button>
                            </form>
                        </section>

                        <div className="grid grid-cols-1 gap-4">
                            {stores.length === 0 ? (
                                <div className="text-center py-20 bg-slate-100 border-2 border-dashed border-slate-200 rounded-2xl">
                                    <Server className="mx-auto text-slate-300 mb-4" size={48} />
                                    <p className="text-slate-400 font-medium">No active store deployments found in cluster.</p>
                                </div>
                            ) : stores.map((store, i) => (
                                <div key={i} className="bg-white border border-slate-200 p-5 rounded-2xl flex items-center justify-between hover:shadow-md transition-shadow">
                                    <div className="flex items-center gap-4">
                                        <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center">
                                            <Server size={24} />
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-lg">{store.name}</h3>
                                            <div className="flex gap-3 text-xs text-slate-400 font-mono mt-1">
                                                <span>NS: {store.namespace}</span>
                                                <span>Engine: {store.engine}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-6">
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${getStatusStyle(store.status)}`}>
                                            {store.status !== 'Ready' && store.status !== 'Failed' && <RefreshCw size={10} className="inline mr-1 animate-spin" />}
                                            {store.status}
                                        </span>
                                        <div className="flex items-center gap-2 border-l pl-6 border-slate-100">
                                            <a href={store.url} target="_blank" rel="noreferrer" className="p-2 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors">
                                                <ExternalLink size={20} />
                                            </a>
                                            <button onClick={() => handleDelete(store.name)} className="p-2 hover:bg-red-50 rounded-lg text-red-400 hover:text-red-600 transition-colors cursor-pointer">
                                                <Trash2 size={20} />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {/* AUDIT LOG TAB */}
                {activeTab === 'audit' && (
                    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                            <h2 className="font-bold text-slate-800 flex items-center gap-2"><ScrollText size={18} />Audit Log</h2>
                            <button onClick={fetchAuditLogs} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
                                <RefreshCw size={12} /> Refresh
                            </button>
                        </div>
                        {auditLogs.length === 0 ? (
                            <div className="text-center py-12 text-slate-400">No audit logs yet</div>
                        ) : (
                            <div className="divide-y divide-slate-100">
                                {auditLogs.map((log) => (
                                    <div key={log.id} className="px-6 py-3 flex items-start gap-4 hover:bg-slate-50">
                                        <span className={`text-xs font-bold px-2 py-1 rounded-full whitespace-nowrap mt-0.5 ${getActionStyle(log.action)}`}>
                                            {log.action}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-semibold text-sm text-slate-800">{log.store_name || '—'}</span>
                                                {log.namespace && <span className="text-xs text-slate-400 font-mono">{log.namespace}</span>}
                                                {log.engine && <span className="text-xs text-slate-400">[{log.engine}]</span>}
                                            </div>
                                            {log.message && <p className="text-xs text-slate-500 mt-0.5 truncate">{log.message}</p>}
                                        </div>
                                        <span className="text-xs text-slate-400 whitespace-nowrap">{new Date(log.timestamp).toLocaleString()}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* METRICS TAB */}
                {activeTab === 'metrics' && metrics && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="bg-white border border-slate-200 rounded-2xl p-6">
                            <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2"><Server size={18} />Store Status</h3>
                            <div className="space-y-3">
                                {[
                                    { label: 'Ready', value: metrics.stores.ready, total: metrics.stores.total, color: 'bg-green-500' },
                                    { label: 'Provisioning', value: metrics.stores.provisioning, total: metrics.stores.total, color: 'bg-amber-500' },
                                    { label: 'Failed', value: metrics.stores.failed, total: metrics.stores.total, color: 'bg-red-500' },
                                ].map((item, i) => (
                                    <div key={i}>
                                        <div className="flex justify-between text-sm mb-1">
                                            <span className="text-slate-600">{item.label}</span>
                                            <span className="font-bold">{item.value}</span>
                                        </div>
                                        <div className="w-full bg-slate-100 rounded-full h-2">
                                            <div className={`${item.color} h-2 rounded-full transition-all`}
                                                style={{ width: item.total ? `${(item.value / item.total) * 100}%` : '0%' }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="bg-white border border-slate-200 rounded-2xl p-6">
                            <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2"><Activity size={18} />Lifetime Activity</h3>
                            <div className="space-y-4">
                                {[
                                    { label: 'Stores Created', value: metrics.activity.totalCreated, color: 'text-green-600' },
                                    { label: 'Stores Deleted', value: metrics.activity.totalDeleted, color: 'text-orange-600' },
                                    { label: 'Failed Provisions', value: metrics.activity.totalFailed, color: 'text-red-600' },
                                ].map((item, i) => (
                                    <div key={i} className="flex items-center justify-between">
                                        <span className="text-slate-600 text-sm">{item.label}</span>
                                        <span className={`text-2xl font-black ${item.color}`}>{item.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* <footer>Hi there i will add git icon here</footer> */}


            </div>
        </div>
    );
}

export default App;