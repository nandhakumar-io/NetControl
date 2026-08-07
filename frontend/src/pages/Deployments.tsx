import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Device } from "../lib/types";

interface HealthCheck {
  category: string;
  check_name: string;
  passed: boolean;
  detail: string | null;
  checked_at: string;
}

interface DeploymentRecord {
  id: string;
  change_request_id: string;
  device_id: string;
  snapshot_id: string | null;
  protocol: string;
  status: "queued" | "in_progress" | "succeeded" | "failed" | "rolled_back";
  error_message: string | null;
  created_at: string;
  health_checks: HealthCheck[];
}

const statusStyle: Record<string, string> = {
  queued: "bg-slate-100 text-slate-600",
  in_progress: "bg-blue-100 text-blue-700",
  succeeded: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  rolled_back: "bg-amber-100 text-amber-700",
};

const STAGES = ["Snapshot", "Deploy", "Health Monitor", "Result"];

function stageIndex(status: DeploymentRecord["status"]) {
  if (status === "queued") return 0;
  if (status === "in_progress") return 1;
  return 3;
}

export default function Deployments() {
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<DeploymentRecord | null>(null);

  const load = () => {
    api.get<DeploymentRecord[]>("/deployments").then((res) => setDeployments(res.data));
    api.get<Device[]>("/devices").then((res) => setDevices(res.data));
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const hostnameFor = (deviceId: string) => devices.find((d) => d.id === deviceId)?.hostname || deviceId.slice(0, 8);

  return (
    <div>
      <h1 className="text-2xl font-bold text-navy">Deployments &amp; Self-Healing</h1>
      <p className="text-sm text-slate-500 mt-1">
        Snapshot → Deploy → Health Monitor → Success or Automatic Rollback.
      </p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden self-start">
          <table className="w-full text-sm">
            <thead className="bg-navy text-white">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Device</th>
                <th className="text-left px-4 py-3 font-semibold">Protocol</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {deployments.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-center text-slate-400 py-8">
                    No deployments yet. Approve a change request to trigger the pipeline.
                  </td>
                </tr>
              )}
              {deployments.map((d, i) => (
                <tr
                  key={d.id}
                  onClick={() => setSelected(d)}
                  className={`cursor-pointer hover:bg-blue-50 ${i % 2 ? "bg-slate-50" : "bg-white"} ${
                    selected?.id === d.id ? "ring-2 ring-inset ring-brandblue" : ""
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-navy">{hostnameFor(d.device_id)}</td>
                  <td className="px-4 py-3 uppercase text-xs text-slate-500">{d.protocol}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-semibold capitalize ${statusStyle[d.status]}`}>
                      {d.status.replace("_", " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          {!selected ? (
            <p className="text-sm text-slate-400 italic">Select a deployment to view its pipeline.</p>
          ) : (
            <div className="space-y-5">
              <div>
                <h3 className="font-semibold text-navy">{hostnameFor(selected.device_id)}</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Snapshot {selected.snapshot_id ? selected.snapshot_id.slice(0, 8) : "—"} · {selected.protocol.toUpperCase()}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {STAGES.map((stage, idx) => {
                  const active = idx <= stageIndex(selected.status);
                  const isFinal = idx === 3;
                  const finalColor =
                    selected.status === "succeeded"
                      ? "bg-risklow"
                      : selected.status === "rolled_back"
                      ? "bg-riskmed"
                      : selected.status === "failed"
                      ? "bg-riskcrit"
                      : "bg-slate-300";
                  return (
                    <div key={stage} className="flex-1 text-center">
                      <div
                        className={`h-2 rounded-full mb-1 ${
                          isFinal ? (active ? finalColor : "bg-slate-200") : active ? "bg-brandblue" : "bg-slate-200"
                        }`}
                      />
                      <p className="text-[10px] text-slate-500">{stage}</p>
                    </div>
                  );
                })}
              </div>

              {selected.error_message && (
                <div className="bg-red-50 border border-riskcrit/30 rounded-lg px-3 py-2 text-xs text-riskcrit whitespace-pre-wrap">
                  {selected.error_message}
                </div>
              )}

              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Health Checks</p>
                {selected.health_checks.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No health checks recorded yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {selected.health_checks.map((h, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <span className={`mt-0.5 h-2 w-2 rounded-full flex-shrink-0 ${h.passed ? "bg-risklow" : "bg-riskcrit"}`} />
                        <span>
                          <span className="font-medium capitalize">{h.category}</span> · {h.check_name} —{" "}
                          {h.passed ? "passed" : "failed"}
                          {h.detail && <span className="text-slate-400"> ({h.detail.slice(0, 80)})</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {selected.status === "rolled_back" && (
                <div className="bg-amber-50 border border-riskmed/30 rounded-lg px-3 py-2 text-xs text-amber-800">
                  Self-healing rollback restored the last known-good configuration automatically.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
