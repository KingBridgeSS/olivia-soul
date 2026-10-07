export const MEMORY_USER = 'olivia-soul';
export type MemoryProject = 'observation_project' | 'profile_project';
export interface MemoryRequest {
  command: 'list' | 'profile' | 'create' | 'update' | 'delete';
  project?: MemoryProject;
  page?: number;
  id?: string;
  content?: string;
}
export interface MemoryNode { memoryNodeId: string; content: string; updatedAt?: string; createdAt?: string }
export interface MemoryResult {
  user: string;
  project?: string;
  page?: number;
  data?: {
    memoryNodes?: MemoryNode[];
    total?: string | number;
    attributes?: { id?: string; name?: string; value?: string }[];
  };
  updated?: string;
  deleted?: string;
  content?: string;
  requestId?: string;
}
