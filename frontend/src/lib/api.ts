export type Work = {
  id: number;
  primaryCode: string;
  title: string;
  createdAt: string;
};

export type FileSource = {
  id: number;
  code: string;
  displayName: string;
  sourceType: string;
  enabled: boolean;
};

export type WorkflowRun = {
  id: number;
  templateCode: string;
  status: string;
  triggerReason: string;
  createdAt: string;
};

export type LocalScanResult = {
  runId: number;
  jobId: number;
  fileSourceId: number;
  status: string;
  detectedWorks: number;
  scannedFiles: number;
  updatedLocations: number;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:7659";

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listWorks: () => getJSON<Work[]>("/api/works"),
  listFileSources: () => getJSON<FileSource[]>("/api/file-sources"),
  listWorkflowRuns: () => getJSON<WorkflowRun[]>("/api/workflow-runs"),
  runLocalScan: () => postJSON<LocalScanResult>("/api/workflow-runs/local-scan"),
};
