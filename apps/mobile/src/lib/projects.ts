import type { Note, Project, Task } from "@talorys/shared";
import { api } from "./api";

export interface ProjectRow extends Project {
  openTasks: number;
}

/** Projects with their open-task counts; archived ones last (the agent sorts them so). */
export async function loadProjects(): Promise<ProjectRow[]> {
  const [{ projects }, { tasks }] = await Promise.all([api<{ projects: Project[] }>("/projects"), api<{ tasks: Task[] }>("/tasks?status=open&limit=500")]);
  return withOpenCounts(projects, tasks);
}

export function withOpenCounts(projects: Project[], tasks: Task[]): ProjectRow[] {
  const counts = new Map<string, number>();
  for (const t of tasks) if (t.project_id && t.status !== "done") counts.set(t.project_id, (counts.get(t.project_id) ?? 0) + 1);
  return projects.map((p) => ({ ...p, openTasks: counts.get(p.id) ?? 0 }));
}

export const createProject = (name: string, description?: string) => api<{ project: Project }>("/projects", { method: "POST", body: { name, ...(description ? { description } : {}) } });
export const updateProject = (id: string, patch: Partial<Pick<Project, "name" | "description" | "status">>) => api<{ project: Project }>(`/projects/${id}`, { method: "PATCH", body: patch });
export const deleteProject = (id: string) => api(`/projects/${id}`, { method: "DELETE" });
export const loadProject = (id: string) => api<{ project: Project; tasks: Task[]; notes: Note[]; thread_id: string }>(`/projects/${id}`);
