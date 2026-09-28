const BASE_URL = "/api";

export interface User { id: string; email: string; name: string; createdAt?: string }
export interface Team { id: string; name: string; createdAt: string; createdBy?: string }
export interface Project {
  id: string; name: string; ownerType: "user" | "team"; ownerUserId: string | null;
  ownerTeamId: string | null; createdAt: string; access: "owner" | "team" | "collaborator";
}
export interface Whiteboard { id: string; title: string; createdAt: string; projectId: string }
export interface WhiteboardData {
  elements: readonly object[];
  appState?: object;
  files?: Record<string, unknown>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { const body = await response.json(); message = body.message || body.error || message; } catch { /* response has no JSON body */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const getMe = async () => request<{ user: User; teams: Team[] }>("/auth/me");
export const getAuthStatus = () => request<{ bootstrapRequired: boolean }>("/auth/status");
export const bootstrap = (input: { email: string; name: string; password: string }) => request<{ user: User }>("/auth/bootstrap", json(input));
export const login = (input: { email: string; password: string }) => request<{ user: User }>("/auth/login", json(input));
export const logout = () => request<void>("/auth/logout", { method: "POST" });
export const createInvite = (email?: string) => request<{ token: string; registrationUrl: string }>("/auth/invites", json({ email }));
export const register = (input: { token: string; email?: string; name: string; password: string }) => request<{ user: User }>("/auth/register", json(input));
export const getTeams = () => request<Team[]>("/teams");
export const createTeam = (name: string) => request<Team>("/teams", json({ name }));
export const createTeamInvite = (teamId: string, email?: string) => request<{ token: string; registrationUrl: string }>(`/teams/${teamId}/invites`, json({ email }));
export const addTeamMember = (teamId: string, email: string) => request<{ user: User }>(`/teams/${teamId}/members`, json({ email }));
export const getProjects = () => request<Project[]>("/projects");
export const createProject = (name: string, teamId?: string) => request<Project>("/projects", json({ name, ...(teamId ? { teamId } : {}) }));
export const getProject = (id: string) => request<Project>(`/projects/${id}`);
export const getProjectWhiteboards = (id: string) => request<Whiteboard[]>(`/projects/${id}/whiteboards`);
export const createWhiteboard = (projectId: string, title: string) => request<Whiteboard>(`/projects/${projectId}/whiteboards`, json({ title }));
export const addCollaborator = (projectId: string, email: string) => request<void>(`/projects/${projectId}/collaborators`, json({ email }));
export const createProjectInvite = (projectId: string, email?: string) => request<{ token: string; registrationUrl: string }>(`/projects/${projectId}/invites`, json({ email }));
export const removeCollaborator = (projectId: string, userId: string) => request<void>(`/projects/${projectId}/collaborators/${userId}`, { method: "DELETE" });
export const getWhiteboardData = (id: string) => request<WhiteboardData>(`/whiteboards/${id}/data`);

export function whiteboardSocketUrl(id: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/whiteboards/${encodeURIComponent(id)}/live`;
}
